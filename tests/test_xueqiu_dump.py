"""雪球导出文件导入测试（端到端，含落库与抽取）。

跑法：python tests/test_xueqiu_dump.py

用合成的 dump 文件走一遍完整链路：解析 -> 落库 -> 抽取观点。
目的：确保浏览器那边辛苦导出的数据，导入时不会因为字段细节失败。
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from stocktool.config import DEFAULT_SETTINGS, Config          # noqa: E402
from stocktool.db import init_db, session                      # noqa: E402
from stocktool.extract.lexicon import Lexicon                  # noqa: E402
from stocktool.extract.resolver import SubjectResolver, load_alias_rows  # noqa: E402
from stocktool.extract.rule_extractor import extract_opinions  # noqa: E402
from stocktool.ingest.xueqiu import docs_from_dump             # noqa: E402
from stocktool.market.store import upsert_aliases, upsert_instruments  # noqa: E402
from stocktool.models import Instrument                        # noqa: E402

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


def ts(y, m, d, hh=21, mm=0):
    """按东八区造时间戳。

    必须带时区，否则测试会因为 UTC->本地 换算而跨天
    （回测用的是本地日期，A 股场景下这是正确的）。
    """
    import datetime
    tz = datetime.timezone(datetime.timedelta(hours=8))
    return int(datetime.datetime(y, m, d, hh, mm, tzinfo=tz).timestamp() * 1000)


DUMP = {
    "_source": "xueqiu-console-harvest",
    "_harvested_at": "2026-10-08T13:00:00.000Z",
    "uid": "0000000000",
    "endpoint": "/v4/statuses/user_timeline.json?user_id=0000000000&page=",
    "maxPage": 1,
    "count": 4,
    "statuses": [
        {
            "id": 1001,
            "created_at": ts(2024, 3, 5),
            "user": {"id": 0, "screen_name": "测试大V·甲"},
            "title": "",
            "text": "<p>$贵州茅台(SH600519)$ 白酒库存周期见底，"
                    "我坚定看好未来两个季度的修复行情。</p>",
            "description": "",
            "target": "/S/SH600519",
            "reply_count": 8, "like_count": 25, "retweet_count": 3,
            "view_count": 12000, "truncated": False,
        },
        {
            "id": 1002,
            "created_at": ts(2024, 5, 20),
            "user": {"id": 0, "screen_name": "测试大V·甲"},
            "title": "关于半导体的一点想法",
            "text": "<p>行业景气度在回升。</p><p>设备端订单能见度改善。</p>",
            "description": "",
            "target": "/S/SH512480",
            "reply_count": 0, "like_count": 5, "retweet_count": 0,
            "view_count": 3000, "truncated": False,
        },
        {
            "id": 1003,
            "created_at": ts(2024, 7, 15),
            "user": {"id": 0, "screen_name": "测试大V·甲"},
            "title": "",
            "text": "<p>转发一下，光伏产能过剩的问题比想象中严重。</p>",
            "description": "",
            "target": "",
            "reply_count": 1, "like_count": 2, "retweet_count": 1,
            "view_count": 800, "truncated": False,
            "retweeted_status": {
                "id": 999,
                "user": {"id": 555, "screen_name": "别人的账号"},
                "text": "<p>光伏价格战还在继续，行业整体承压。</p>",
            },
        },
        {
            "id": 1004,
            "created_at": ts(2024, 9, 14),
            "user": {"id": 0, "screen_name": "测试大V·甲"},
            "title": "",
            "text": "",
            "description": "<p>最后一条：我觉得银行没有泡沫，估值还在中枢以下。</p>",
            "target": "/S/SH600036",
            "reply_count": 0, "like_count": 1, "retweet_count": 0,
            "view_count": 100, "truncated": False,
        },
    ],
}


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="stocktool_test_"))
    dump_path = tmp / "xueqiu_0000000000.json"
    dump_path.write_text(json.dumps(DUMP, ensure_ascii=False), encoding="utf-8")

    print("\n[1] 解析导出文件")
    docs, meta = docs_from_dump(dump_path, expect_uid="0000000000",
                                expect_name="测试大V·甲")
    check("作者身份识别正确", meta["author_uid"] == "0000000000"
          and meta["author_name"] == "测试大V·甲", str(meta))
    check("4 条 status 全部解析成功", len(docs) == 4, f"got {len(docs)}")

    by_id = {d.external_id: d for d in docs}
    check("cashtag 在剥 HTML 后保留",
          "$贵州茅台(SH600519)$" in by_id["1001"].text, by_id["1001"].text[:80])
    check("HTML 标签被剥掉", "<p>" not in by_id["1001"].text)
    check("标题与正文拼接", by_id["1002"].text.startswith("关于半导体的一点想法"),
          by_id["1002"].text[:40])
    check("段落被保留为换行", "行业景气度在回升。" in by_id["1002"].text
          and "设备端订单能见度改善。" in by_id["1002"].text)
    check("转发帖保留了被转内容",
          "【转发 @别人的账号】" in by_id["1003"].text
          and "光伏价格战还在继续" in by_id["1003"].text, by_id["1003"].text)
    check("转发帖 kind 标记为 retweet", by_id["1003"].kind == "retweet",
          by_id["1003"].kind)
    check("description 兜底（text 为空时）",
          "银行没有泡沫" in by_id["1004"].text, by_id["1004"].text[:60])
    check("发布时间解析正确", by_id["1004"].published_at.startswith("2024-09-14"),
          by_id["1004"].published_at)
    check("permalink 来自 target",
          by_id["1001"].permalink.endswith("/S/SH600519"),
          by_id["1001"].permalink)

    print("\n[2] 身份防错（uid / 昵称 不匹配必须中止）")
    for label, kw in (("uid 不匹配", {"expect_uid": "999"}),
                      ("昵称不匹配", {"expect_name": "别人"})):
        try:
            docs_from_dump(dump_path, **kw)
            check(f"{label} 应中止", False, "居然没报错")
        except SystemExit:
            check(f"{label} 已中止", True)

    print("\n[3] 落库 + 抽取（端到端）")
    vals = dict(DEFAULT_SETTINGS)
    vals["db_path"] = str(tmp / "test.db")
    cfg = Config(values=vals)

    with session(cfg) as con:
        init_db(con)
        from stocktool.cli import _persist_docs
        stats = _persist_docs(con, docs)
        check("入库 4 篇", stats["docs"] == 4, str(stats))
        n = con.execute("SELECT COUNT(*) c FROM doc").fetchone()["c"]
        check("doc 表 4 行", n == 4, str(n))
        rev = con.execute("SELECT COUNT(*) c FROM doc_revision").fetchone()["c"]
        check("版本快照 4 个", rev == 4, str(rev))

        # 幂等：再导一次不应新增
        stats2 = _persist_docs(con, docs)
        n2 = con.execute("SELECT COUNT(*) c FROM doc").fetchone()["c"]
        check("重复导入幂等（doc 仍为 4）", n2 == 4, str(n2))
        check("重复导入不新增快照", stats2["new_rev"] == 0, str(stats2))

        upsert_instruments(con, [
            Instrument("1.600519", "600519", "贵州茅台", "stock", 1, "SH"),
            Instrument("1.512480", "512480", "半导体ETF", "fund", 1, "SH"),
            Instrument("1.512690", "512690", "酒ETF", "fund", 1, "SH"),
            Instrument("1.600036", "600036", "招商银行", "stock", 1, "SH"),
            Instrument("1.512800", "512800", "银行ETF", "fund", 1, "SH"),
            Instrument("1.000300", "000300", "沪深300", "index", 1, "SH"),
        ], "2026-01-01T00:00:00")
        lex = Lexicon.load(ROOT / "config" / "lexicon.json")
        # 板块词映射（真实库里来自 sectors.json，测试库手工补一条代表性的）
        upsert_aliases(con, [("银行", "1.512800", 1.0)], "manual")
        upsert_aliases(con, load_alias_rows(con, lex.aliases), "manual")
        con.commit()

        resolver = SubjectResolver.from_db(con, lex.aliases)
        bench = Instrument("1.000300", "000300", "沪深300", "index", 1, "SH")

        total_ops = 0
        for doc in docs:
            ops = extract_opinions(doc.text, resolver, lex, benchmark=bench)
            total_ops += len(ops)
        check("从导出内容里抽出了观点", total_ops > 0, f"got {total_ops}")

        ops = extract_opinions(by_id["1001"].text, resolver, lex, benchmark=bench)
        hit = [o for o in ops if o.subject_secid == "1.600519"]
        check("cashtag 正确归属到贵州茅台",
              bool(hit) and hit[0].polarity == 1,
              f"{[(o.subject_raw, o.polarity) for o in ops]}")

        ops = extract_opinions(by_id["1004"].text, resolver, lex, benchmark=bench)
        bank = [o for o in ops if o.subject_secid == "1.512800"]
        check("「银行没有泡沫」判为看多（否定翻转）",
              bool(bank) and bank[0].polarity == 1,
              f"{[(o.subject_raw, o.polarity, o.subject_secid) for o in ops]}")

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
