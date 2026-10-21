"""知识库往返测试：导出 -> 校验 -> 导入 必须闭环。

跑法：python tests/test_kb_roundtrip.py

同时也测校验器**该拦的必须拦住** —— 一个什么都放行的校验器
比没有校验器更糟，因为它会给出虚假的安全感。
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from stocktool.config import DEFAULT_SETTINGS, Config            # noqa: E402
from stocktool.db import init_db, session                        # noqa: E402
from stocktool.extract.lexicon import Lexicon                    # noqa: E402
from stocktool.extract.resolver import SubjectResolver, load_alias_rows  # noqa: E402
from stocktool.extract.rule_extractor import extract_opinions    # noqa: E402
from stocktool.extract.runner import run_extraction              # noqa: E402
from stocktool.ingest.manual import parse_seed_text              # noqa: E402
from stocktool.kb import (                                       # noqa: E402
    export_kb, import_kb, load_kb, read_bundle, validate_kb,
)
from stocktool.kb import spec                                    # noqa: E402
from stocktool.market.store import upsert_aliases, upsert_instruments  # noqa: E402
from stocktool.models import Instrument                          # noqa: E402
from stocktool.textutil import now_iso                           # noqa: E402

_failures: list[str] = []
_passed = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global _passed
    if cond:
        _passed += 1
        print(f"  PASS  {name}")
    else:
        _failures.append(f"{name} :: {detail}")
        print(f"  FAIL  {name}  {detail}")


SEED = """---
source: xueqiu
author_uid: 999001
author_name: 测试甲
---

## 2024-03-05 21:30
$贵州茅台(SH600519)$ 白酒库存周期见底，我坚定看好未来两个季度的修复行情。

## 2024-05-20 09:15
半导体没有泡沫，估值还在低位，继续加仓。
"""


def make_cfg(tmp: Path, name: str) -> Config:
    vals = dict(DEFAULT_SETTINGS)
    vals["db_path"] = str(tmp / name)
    return Config(values=vals)


def populate(cfg: Config, tmp: Path) -> dict:
    from stocktool.cli import _persist_docs
    with session(cfg) as con:
        init_db(con)
        upsert_instruments(con, [
            Instrument("1.600519", "600519", "贵州茅台", "stock", 1, "SH"),
            Instrument("1.512480", "512480", "半导体ETF", "fund", 1, "SH"),
            Instrument("1.000300", "000300", "沪深300", "index", 1, "SH"),
        ], now_iso())
        lex = Lexicon.load(ROOT / "config" / "lexicon.json")
        upsert_aliases(con, [("半导体", "1.512480", 1.0)], "manual")
        upsert_aliases(con, load_alias_rows(con, lex.aliases), "manual")
        con.commit()

        docs = parse_seed_text(SEED)
        _persist_docs(con, docs)

        resolver = SubjectResolver.from_db(con, lex.aliases)
        bench = Instrument("1.000300", "000300", "沪深300", "index", 1, "SH")
        stats = run_extraction(con, cfg, lex, resolver, benchmark=bench,
                               extractor="rule")

        # 手工造几条回测结果（evaluate 需要行情，这里不需要真行情）
        ids = [r["id"] for r in con.execute("SELECT id FROM opinion ORDER BY id")]
        for pid in ids:
            for hz in (5, 20):
                con.execute("""
                    INSERT INTO opinion_eval
                      (opinion_id, horizon_days, benchmark_secid, entry_date,
                       entry_close, exit_date, exit_close, bench_entry, bench_exit,
                       raw_return, bench_return, excess_return, signed_excess, hit,
                       max_adverse, status, evaluated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (pid, hz, "1.000300", "2024-03-06", 100.0, "2024-03-13",
                      102.0, 3400.0, 3410.0, 0.02, 0.003, 0.017, 0.017, 1,
                      -0.01, "ok", now_iso()))
        con.commit()
        used = con.execute(
            "SELECT COUNT(DISTINCT subject_secid) c FROM opinion "
            "WHERE subject_secid IS NOT NULL"
        ).fetchone()["c"]
        return {"opinions": stats["opinions"], "eval": len(ids) * 2,
                "used_secids": int(used)}


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="stocktool_kb_"))
    cfg = make_cfg(tmp, "src.db")
    counts = populate(cfg, tmp)
    print(f"\n源库：观点 {counts['opinions']} 条，回测 {counts['eval']} 条")

    print("\n[1] 导出 evidence_only")
    out1 = tmp / "ev.stkb"
    with session(cfg) as con:
        s1 = export_kb(con, cfg, out_path=out1, policy="evidence_only")
    check("生成了 .stkb 文件", out1.is_file(), str(out1))
    check("是合法 zip", zipfile.is_zipfile(out1))
    check("体积合理（< 100KB）", s1["size_bytes"] < 100_000,
          f"{s1['size_bytes']} bytes")

    print("\n[2] 校验 evidence_only")
    v1 = validate_kb(out1)
    check("校验通过", v1["ok"], "; ".join(v1["errors"]))
    files1 = read_bundle(out1)
    check("不含 documents.jsonl（evidence_only 的核心约束）",
          spec.DOCUMENTS not in files1, sorted(files1))
    check("含 evaluations.jsonl", spec.EVALUATIONS in files1)
    check("含必需文件 manifest/author/instruments/opinions",
          all(f in files1 for f in spec.REQUIRED_FILES), sorted(files1))
    check("manifest 的 content_policy 正确",
          v1["manifest"]["content_policy"] == "evidence_only")

    print("\n[3] 导入到全新的库，验证闭环")
    cfg2 = make_cfg(tmp, "dst.db")
    with session(cfg2) as con:
        init_db(con)
        kb = load_kb(out1)
        st = import_kb(con, cfg2, kb)
        n_op = con.execute("SELECT COUNT(*) c FROM opinion").fetchone()["c"]
        n_ev = con.execute("SELECT COUNT(*) c FROM opinion_eval").fetchone()["c"]
        n_doc = con.execute("SELECT COUNT(*) c FROM doc").fetchone()["c"]
        n_inst = con.execute("SELECT COUNT(*) c FROM instrument").fetchone()["c"]
        n_txt = con.execute("SELECT COUNT(*) c FROM doc_text").fetchone()["c"]
        n_author = con.execute("SELECT COUNT(*) c FROM author").fetchone()["c"]
        # 观点必须能正确解析回标的
        joined = con.execute("""
            SELECT v.author, v.subject_name, v.polarity
            FROM v_opinion v ORDER BY v.stated_date
        """).fetchall()

    check("观点数一致", n_op == counts["opinions"], f"{n_op} vs {counts['opinions']}")
    check("回测结果数一致", n_ev == counts["eval"], f"{n_ev} vs {counts['eval']}")
    # 知识库**只带被观点引用到的标的**（这是控制体积的关键设计），
    # 所以预期值要从源库的观点里推导，而不是 instrument 表的全量。
    check("标的字典自包含且只含被引用的标的",
          n_inst == counts["used_secids"],
          f"导入 {n_inst}，源库被引用 {counts['used_secids']}")
    check("作者已建（1 位）", n_author == 1, str(n_author))
    check("文档元数据存根已建", n_doc >= 2, str(n_doc))
    check("evidence_only 不导入正文（不被本地重新抽取）", n_txt == 0, str(n_txt))
    check("view 能解析出标的名", all(r["subject_name"] for r in joined),
          str([dict(r) for r in joined]))
    check("原文作者名保留", joined and joined[0]["author"] == "测试甲",
          str([dict(r) for r in joined]))

    print("\n[4] 重复导入必须幂等")
    with session(cfg2) as con:
        import_kb(con, cfg2, load_kb(out1))
        n_op2 = con.execute("SELECT COUNT(*) c FROM opinion").fetchone()["c"]
        n_ev2 = con.execute("SELECT COUNT(*) c FROM opinion_eval").fetchone()["c"]
    check("重复导入观点数不变", n_op2 == n_op, f"{n_op2} vs {n_op}")
    check("重复导入回测数不变", n_ev2 == n_ev, f"{n_ev2} vs {n_ev}")

    print("\n[5] 导出 full_text 并往返原文")
    out2 = tmp / "full.stkb"
    with session(cfg) as con:
        s2 = export_kb(con, cfg, out_path=out2, policy="full_text")
    v2 = validate_kb(out2)
    check("full_text 校验通过", v2["ok"], "; ".join(v2["errors"]))
    files2 = read_bundle(out2)
    check("含 documents.jsonl", spec.DOCUMENTS in files2)
    docs = [json.loads(x) for x in files2[spec.DOCUMENTS].splitlines() if x.strip()]
    check("原文条数正确", len(docs) == 2, str(len(docs)))
    check("原文内容完整（含 cashtag）",
          any("$贵州茅台(SH600519)$" in d["text"] for d in docs))
    check("full_text 体积大于 evidence_only", s2["size_bytes"] > s1["size_bytes"])

    cfg3 = make_cfg(tmp, "dst2.db")
    with session(cfg3) as con:
        init_db(con)
        from stocktool.kb import import_document_texts
        kb2 = load_kb(out2)
        import_kb(con, cfg3, kb2)
        n = import_document_texts(con, kb2)
        n_txt2 = con.execute("SELECT COUNT(*) c FROM doc_text").fetchone()["c"]
    check("full_text 导入后正文写回", n_txt2 == 2, f"txt={n_txt2} (imported {n})")

    print("\n[6] 校验器必须拦住坏的库")
    bad_dir = tmp / "bad"

    def tamper(name, mutate):
        files = dict(files1)
        mutate(files)
        p = tmp / name
        with zipfile.ZipFile(p, "w") as zf:
            for k, v in files.items():
                zf.writestr(k, v)
        return p

    def drop_instrument(f):
        rows = [json.loads(x) for x in f[spec.INSTRUMENTS].splitlines() if x.strip()]
        rows = [r for r in rows if r["secid"] != "1.600519"]
        f[spec.INSTRUMENTS] = "\n".join(spec.dumps_line(r) for r in rows) + "\n"

    r = validate_kb(tamper("bad_inst.stkb", drop_instrument))
    check("拦住了「观点引用未声明的标的」", not r["ok"],
          str(r["errors"]))
    check("错误信息里指出了缺失的 secid",
          any("1.600519" in e for e in r["errors"]), str(r["errors"]))

    def too_long_quote(f):
        rows = [json.loads(x) for x in f[spec.OPINIONS].splitlines() if x.strip()]
        rows[0]["evidence"] = "长" * 500
        f[spec.OPINIONS] = "\n".join(spec.dumps_line(r) for r in rows) + "\n"

    r = validate_kb(tamper("bad_quote.stkb", too_long_quote))
    check("拦住了「引用超长」", not r["ok"], str(r["errors"]))

    def bad_policy(f):
        m = json.loads(f[spec.MANIFEST])
        m["content_policy"] = "full_text"      # 但没有 documents.jsonl
        f[spec.MANIFEST] = spec.dumps_pretty(m)

    r = validate_kb(tamper("bad_policy.stkb", bad_policy))
    check("拦住了「策略与文件不符」", not r["ok"], str(r["errors"]))

    def bad_hash(f):
        f[spec.OPINIONS] = f[spec.OPINIONS] + "\n"

    r = validate_kb(tamper("bad_hash.stkb", bad_hash))
    check("拦住了「完整性哈希不符」",
          any("哈希不符" in e for e in r["errors"]), str(r["errors"]))

    def bad_opinion_ref(f):
        rows = [json.loads(x) for x in f[spec.EVALUATIONS].splitlines() if x.strip()]
        rows[0]["opinion_id"] = "deadbeef"
        f[spec.EVALUATIONS] = "\n".join(spec.dumps_line(r) for r in rows) + "\n"

    r = validate_kb(tamper("bad_eval.stkb", bad_opinion_ref))
    check("拦住了「回测引用不存在的观点」", not r["ok"], str(r["errors"]))

    def bad_major(f):
        m = json.loads(f[spec.MANIFEST])
        m["format_version"] = "9.0"
        f[spec.MANIFEST] = spec.dumps_pretty(m)

    r = validate_kb(tamper("bad_ver.stkb", bad_major))
    check("拦住了「不认识的主版本」",
          any("主版本" in e for e in r["errors"]), str(r["errors"]))

    print("\n[7] 缺文件与目录形态")
    p = tmp / "missing.stkb"
    with zipfile.ZipFile(p, "w") as zf:
        zf.writestr(spec.MANIFEST, spec.dumps_pretty({"kb_format": "stocktool-kb"}))
    r = validate_kb(p)
    check("拦住了「缺必需文件」", not r["ok"], str(r["errors"]))

    dir_kb = tmp / "dir_kb"
    with session(cfg) as con:
        export_kb(con, cfg, out_path=dir_kb, policy="evidence_only")
    r = validate_kb(dir_kb)
    check("目录形态也能校验通过", r["ok"], str(r["errors"]))

    print("\n" + "=" * 60)
    if _failures:
        print(f"失败 {len(_failures)} 项 / 通过 {_passed} 项")
        for f in _failures:
            print(f"  - {f}")
        return 1
    print(f"全部通过（{_passed} 项断言）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
