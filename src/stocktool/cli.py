"""命令行入口。

典型用法：
    python run.py initdb --reset    # 建库（改过 schema 要 --reset）
    python run.py pipeline          # 一键跑通全链路
    python run.py fetch-universe    # 标的全集：新浪个股 + 板块ETF + 指数
    python run.py import            # 导入语料
    python run.py extract --show 20 # 抽取观点
    python run.py fetch-quotes      # 抓行情（腾讯->新浪->东财 故障转移）
    python run.py evaluate
    python run.py report
    python run.py status
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

from .backtest import build_consensus, build_scoreboard, evaluate_all, needed_secids
from .config import Config, load_config
from .db import init_db, log_run, save_revision, session, upsert_author, upsert_doc
from .extract.lexicon import Lexicon
from .extract.resolver import SubjectResolver, load_alias_rows
from .extract.runner import run_extraction
from .ingest.manual import ManualAdapter
from .market import Eastmoney, PriceService, Sina, default_indices, load_sectors
from .market.store import (
    quote_coverage, trading_calendar, upsert_aliases, upsert_instruments,
    upsert_quotes,
)
from .models import Instrument
from .report import (
    render_author_detail, render_caveats, render_consensus, render_header,
    render_overview, render_scoreboard,
)
from .textutil import content_hash, now_iso

INSTRUMENT_COLS = "secid, code, name, type, market, exchange"


# ---------------------------------------------------------------- 辅助

def _row_to_instrument(row) -> Instrument:
    return Instrument(row["secid"], row["code"], row["name"], row["type"],
                      row["market"], row["exchange"])


def benchmark_instrument(con, cfg) -> Instrument:
    secid = str(cfg.values["benchmark_secid"])
    row = con.execute(
        f"SELECT {INSTRUMENT_COLS} FROM instrument WHERE secid = ?", (secid,)
    ).fetchone()
    if row:
        return _row_to_instrument(row)
    market_part, _, code = secid.partition(".")
    return Instrument(secid, code or secid, "大盘", "index",
                      int(market_part or 1), "SH")


def load_lexicon(cfg) -> Lexicon:
    """兼容保留：实现已移到 stocktool.lexicon（外部脚本不该 import CLI）。"""
    from .lexicon import load_lexicon as _load

    return _load(cfg)


def quote_targets(con, cfg, extra: list[str] | None = None) -> list[Instrument]:
    """回测真正需要用到的标的，避免把 5000 只股票全抓一遍。"""
    wanted = set(needed_secids(con, cfg))
    if extra:
        wanted |= set(extra)
    out: list[Instrument] = []
    for row in con.execute(f"SELECT {INSTRUMENT_COLS} FROM instrument"):
        if row["secid"] in wanted:
            out.append(_row_to_instrument(row))
    return out


# ---------------------------------------------------------------- 命令

def cmd_initdb(args, cfg: Config) -> int:
    with session(cfg) as con:
        init_db(con, reset=bool(getattr(args, "reset", False)))
    print(f"数据库就绪: {cfg.db_path}")
    return 0


def cmd_fetch_universe(args, cfg: Config) -> int:
    with session(cfg) as con:
        init_db(con)
        now = now_iso()
        universe: list[Instrument] = []
        alias_rows: list[tuple[str, str, float]] = []

        # 1) 个股 —— 走新浪。东财 push2 会对密集翻页做边缘封禁（0 字节断连）。
        if not getattr(args, "skip_stocks", False):
            print("拉取 A 股列表（新浪，约 55 页）…")
            try:
                stocks = Sina(cfg).stocks()
                print(f"  · 个股: {len(stocks)}")
                universe += stocks
            except Exception as exc:  # noqa: BLE001
                print(f"  ! 个股拉取失败：{type(exc).__name__}: {exc}")

        # 2) 板块 ETF —— 板块的可交易代理，有真实K线
        sector_insts, sector_aliases = load_sectors(cfg.sectors_path)
        print(f"  · 板块 ETF: {len(sector_insts)}")
        universe += sector_insts
        alias_rows += sector_aliases

        # 3) 指数
        indices = default_indices()
        print(f"  · 指数: {len(indices)}")
        universe += indices

        # 4) 东财行业/概念板块（可选；被限流就跳过，不影响主流程）
        if getattr(args, "with_boards", False):
            try:
                em = Eastmoney(cfg)
                for bt, label in (("industry", "行业板块"), ("concept", "概念板块")):
                    items = em.boards(bt)
                    print(f"  · 东财{label}: {len(items)}")
                    universe += items
            except Exception as exc:  # noqa: BLE001
                print(f"  ! 东财板块拉取失败，已跳过：{type(exc).__name__}")

        # 以 secid 去重（6 位代码会跨市场撞车）
        seen: set[str] = set()
        uniq: list[Instrument] = []
        for inst in universe:
            if inst.secid in seen:
                continue
            seen.add(inst.secid)
            uniq.append(inst)
        upsert_instruments(con, uniq, now)

        # 别名：个股口语名（词表）+ 板块词（sectors.json）
        lex = load_lexicon(cfg)
        alias_rows += load_alias_rows(con, lex.aliases)
        n_alias = upsert_aliases(con, alias_rows, origin="manual")

        from collections import Counter
        dist = Counter(i.type for i in uniq)
        print(f"入库 {len(uniq)} 个标的："
              + "　".join(f"{k}={v}" for k, v in dist.most_common()))
        print(f"别名入库 {n_alias} 条")
        con.commit()
    return 0


def _persist_docs(con, docs, *, batch_commit: int = 200,
                  progress_label: str | None = None) -> dict:
    """把 RawDoc 落库（作者 + 文档 + 版本快照），流式处理，分批提交。

    采集器是流式 yield 的，中途失败也要保住已抓到的部分。
    """
    now = now_iso()
    stats = {"docs": 0, "authors": set(), "new_rev": 0}
    for doc in docs:
        author_id = upsert_author(con, doc.source, doc.author_uid,
                                  doc.author_name, doc.author_note, now)
        doc_id = upsert_doc(
            con, author_id=author_id, source=doc.source,
            external_id=doc.external_id, kind=doc.kind, title=doc.title,
            published_at=doc.published_at,
            published_date=doc.published_at[:10],
            permalink=doc.permalink,
            media_refs=json.dumps(doc.media_refs, ensure_ascii=False),
            raw_meta=json.dumps(doc.raw_meta, ensure_ascii=False, default=str),
            now=now,
        )
        if save_revision(con, doc_id, doc.text, content_hash(doc.text), now):
            stats["new_rev"] += 1
        stats["docs"] += 1
        stats["authors"].add(doc.author_uid)
        if batch_commit and stats["docs"] % batch_commit == 0:
            con.commit()
            if progress_label:
                print(f"    … 已入库 {stats['docs']} 篇")
    con.commit()
    stats["authors"] = len(stats["authors"])
    return stats


def cmd_import(args, cfg: Config) -> int:
    with session(cfg) as con:
        init_db(con)
        adapter = ManualAdapter(source=args.source or "manual")
        paths = [Path(p) for p in (args.paths or [])]
        docs = list(adapter.fetch(
            paths=paths,
            directory=None if paths else cfg.seed_dir,
        ))
        if not docs:
            print(f"没找到可导入的文档（目录 {cfg.seed_dir}）")
            return 0
        stats = _persist_docs(con, docs)
        print(f"导入 {stats['docs']} 篇文档 / {stats['authors']} 位大V；"
              f"新增版本快照 {stats['new_rev']} 个")
    return 0


def cmd_collect_xueqiu(args, cfg: Config) -> int:
    """一次性全量归档某个雪球账号的发言。"""
    from .ingest.xueqiu import XueqiuAdapter

    with session(cfg) as con:
        init_db(con)
        try:
            adapter = XueqiuAdapter(cfg, cookie=getattr(args, "cookie", None))
        except Exception as exc:  # noqa: BLE001
            print(f"! {exc}")
            return 1

        print("校验登录态…")
        try:
            me = adapter.client.verify_auth()
            who = me.get("screen_name") if isinstance(me, dict) else "?"
            print(f"  Cookie 有效，当前登录账号：{who}")
        except Exception as exc:  # noqa: BLE001
            print(f"! 登录态校验失败：{exc}")
            return 1

        print(f"\n开始采集「{args.who}」（限速 {adapter.client.sleep_min}~"
              f"{adapter.client.sleep_max}s/请求）")
        docs = adapter.fetch(
            who=args.who,
            expect_name=getattr(args, "expect_name", None),
            max_pages=args.max_pages,
            with_comments=args.with_comments,
        )
        try:
            stats = _persist_docs(con, docs, progress_label=True)
        except KeyboardInterrupt:
            con.commit()
            print("\n已中断，但已抓到的内容已提交入库。"
                  "重跑会自动跳过（external_id 幂等）。")
            return 130

        print(f"\n入库 {stats['docs']} 篇 / {stats['authors']} 位大V；"
              f"新增版本快照 {stats['new_rev']} 个")
        rows = con.execute(
            "SELECT MIN(published_date) a, MAX(published_date) b, COUNT(*) n "
            "FROM doc WHERE source = 'xueqiu'"
        ).fetchone()
        if rows and rows["n"]:
            print(f"雪球语料区间：{rows['a']} ~ {rows['b']}（共 {rows['n']} 篇）")
        print("下一步：python run.py extract --show 20")
    return 0


def cmd_probe_xueqiu(args, cfg: Config) -> int:
    """验证 Cookie 与接口形态，不做入库。

    雪球接口会变，这个命令用最小代价回答三个问题：
    登录态是否有效、目标账号 uid 是多少、时间线返回的结构长什么样。
    """
    from .ingest.xueqiu import XueqiuAdapter

    with session(cfg) as con:
        init_db(con)
        try:
            adapter = XueqiuAdapter(cfg, cookie=getattr(args, "cookie", None))
        except Exception as exc:  # noqa: BLE001
            print(f"! {exc}")
            return 1

        print("[1/4] 检查 Cookie 内容…")
        names = adapter.client.token_names
        has_token = adapter.client.has_auth_token()
        print(f"  共 {len(names)} 个键：{', '.join(names)}")
        print(f"  当前登录 uid：{adapter.client.self_uid or '(未知)'}")
        if has_token:
            print("  OK  关键凭证 xq_a_token / xqat 存在")
        else:
            print("  !  缺少 xq_a_token / xqat —— 这两个是真正的登录凭证，")
            print("     且是 HttpOnly（document.cookie 读不到），必须从请求头取。")
            print("     这样打接口会得到 code 400016。见 README 的 Cookie 获取说明。")
            return 1
        print(f"  限速：{adapter.client.sleep_min}~{adapter.client.sleep_max}s/请求")

        print("\n[2/4] 校验登录态…")
        try:
            me = adapter.client.verify_auth()
        except Exception as exc:  # noqa: BLE001
            print(f"! 失败：{exc}")
            return 1
        if not isinstance(me, dict):
            print(f"! 返回结构异常：{type(me).__name__} {str(me)[:200]}")
            return 1
        print(f"  OK  登录态有效，uid={me.get('id')}")

        print(f"\n[3/4] 解析目标账号「{args.who}」…")
        try:
            uid, name = adapter.resolve_uid(args.who,
                                            getattr(args, "expect_name", None))
        except SystemExit as exc:
            print(exc)
            return 1
        print(f"  目标 uid = {uid}  预期昵称 = {name}")

        print(f"\n[4/4] 拉取时间线第 1 页…")
        try:
            payload = adapter.client.timeline(uid, 1)
        except Exception as exc:  # noqa: BLE001
            print(f"! 失败：{exc}")
            return 1
        if not isinstance(payload, dict):
            print(f"! 返回结构异常：{type(payload).__name__}")
            return 1
        print(f"  顶层字段：{sorted(payload.keys())}")
        statuses = payload.get("statuses") or []
        print(f"  本页条数：{len(statuses)}   maxPage={payload.get('maxPage')}  "
              f"total={payload.get('total')}")
        if statuses:
            from .ingest.xueqiu import html_to_text, _ts_to_iso
            try:
                adapter.verify_author(statuses, uid,
                                      getattr(args, "expect_name", None))
            except SystemExit as exc:
                print(f"\n{exc}")
                return 1
            first = statuses[0]
            print(f"  单条字段：{sorted(first.keys())}")
            print(f"  --- 样例 ---")
            print(f"  id        : {first.get('id')}")
            print(f"  时间      : {_ts_to_iso(first.get('created_at'))}")
            print(f"  truncated : {first.get('truncated')}")
            print(f"  target    : {first.get('target')}")
            print(f"  是否转发  : {bool(first.get('retweeted_status'))}")
            body = html_to_text(first.get("text") or first.get("description") or "")
            print(f"  正文      : {body[:220]}")

        out = cfg.data_dir / "raw" / "xueqiu" / f"{uid}_probe_page1.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=1),
                       encoding="utf-8")
        print(f"\n原始响应已存：{out}")
        print(f"  请求次数：{adapter.client.request_count}")
        print("\n若上面字段正常，直接执行："
              f"python run.py collect-xueqiu {args.who} --with-comments")
    return 0


def cmd_import_xueqiu(args, cfg: Config) -> int:
    """导入浏览器控制台导出的雪球 JSON。

    当前唯一可用的采集通道：雪球上了阿里云 WAF 的 JS 挑战，
    外部 HTTP 客户端一律被拒（400016），只有真实浏览器能拿到数据。
    """
    from .ingest.xueqiu import docs_from_dump

    with session(cfg) as con:
        init_db(con)
        paths: list[Path] = []
        for item in args.paths:
            p = Path(item)
            if p.is_dir():
                paths.extend(sorted(p.glob("*.json")))
            elif p.exists():
                paths.append(p)
            else:
                print(f"! 找不到 {p}")
        if not paths:
            default_dir = cfg.data_dir / "raw" / "xueqiu"
            if default_dir.exists():
                paths = sorted(default_dir.glob("xueqiu_*.json"))
            if not paths:
                print(f"没有可导入的 JSON。把导出文件放到 {default_dir} 下，"
                      "或显式指定路径。")
                return 1

        total = {"docs": 0, "authors": 0, "new_rev": 0}
        for path in paths:
            print(f"\n读取 {path}")
            try:
                docs, meta = docs_from_dump(
                    path,
                    expect_uid=getattr(args, "expect_uid", None),
                    expect_name=getattr(args, "expect_name", None),
                )
            except SystemExit as exc:
                print(f"{exc}")
                return 1
            print(f"  作者：{meta.get('author_name')} (uid={meta.get('author_uid')})")
            print(f"  原始 {meta['total_statuses']} 条 -> 可用 {meta['parsed']} 篇")
            stats = _persist_docs(con, docs, progress_label=True)
            for k in total:
                total[k] += stats[k]

        print(f"\n合计入库 {total['docs']} 篇 / {total['authors']} 位大V；"
              f"新增版本快照 {total['new_rev']} 个")
        row = con.execute(
            "SELECT MIN(published_date) a, MAX(published_date) b, COUNT(*) n "
            "FROM doc WHERE source = 'xueqiu'"
        ).fetchone()
        if row and row["n"]:
            print(f"雪球语料区间：{row['a']} ~ {row['b']}（共 {row['n']} 篇）")
        print("\n下一步：python run.py extract --show 20")
    return 0


# ---------------------------------------------------------------- 知识库

def cmd_kb_export(args, cfg: Config) -> int:
    from .kb import export_kb

    with session(cfg) as con:
        init_db(con)
        out = args.out
        if not out:
            args.out = None
        default_dir = cfg.data_dir / "kb"
        out_path = Path(out) if out else (default_dir / "kb.stkb")
        if out_path.is_dir() or not out_path.suffix:
            out_path = out_path / "kb.stkb"
        try:
            stats = export_kb(
                con, cfg, out_path=out_path,
                policy=args.policy,
                kb_id=args.kb_id, title=args.title,
                authors=args.author or None,
                source=args.source,
                include_evaluations=not args.no_eval,
                max_evidence_chars=args.max_quote,
            )
        except SystemExit as exc:
            print(exc)
            return 1

        print(f"知识库已导出：{stats['path']}")
        print(f"  内容策略：{stats['policy']}　"
              f"体积：{stats['size_bytes'] / 1024:.1f} KB")
        print("  " + "  ".join(f"{k}={v}" for k, v in stats["counts"].items()))
        print(f"  回测结果 {stats['evaluations']} 条，原文 {stats['documents']} 篇")
        if stats["policy"] == "evidence_only":
            print("  提示：evidence_only 不含原文，适合分享；"
                  "个人留档建议另存一份 full_text")
    return 0


def cmd_kb_validate(args, cfg: Config) -> int:
    from .kb import format_report, validate_kb

    for raw in args.paths:
        path = Path(raw)
        print(f"\n校验 {path}")
        result = validate_kb(path)
        print(format_report(result))
        if not result["ok"]:
            return 1
    return 0


def cmd_kb_info(args, cfg: Config) -> int:
    from .kb import format_report, validate_kb

    path = Path(args.path)
    result = validate_kb(path, check_integrity=not args.no_hash)
    m = result.get("manifest") or {}
    print(f"\n知识库 {path}")
    print(format_report(result))
    if m:
        pol = (m.get("license") or {})
        print(f"\n  许可      : kb={pol.get('kb')} "
              f"content={pol.get('source_content')}")
        ap = args.author_path
        if ap:
            import json
            files = __import__("stocktool.kb.bundle", fromlist=["read_bundle"]) \
                .read_bundle(path)
            if "author.json" in files:
                Path(ap).write_text(files["author.json"], encoding="utf-8")
                print(f"  作者画像已导出: {ap}")
    return 0 if result["ok"] else 1


def cmd_kb_import(args, cfg: Config) -> int:
    from .kb import import_document_texts, import_kb, load_kb

    with session(cfg) as con:
        init_db(con)
        total = {"instruments": 0, "authors": 0, "docs": 0, "opinions": 0,
                 "evaluations": 0, "skipped": 0, "doc_texts": 0}
        for raw in args.paths:
            path = Path(raw)
            print(f"\n载入 {path}")
            try:
                kb = load_kb(path, validate=not args.no_validate)
            except SystemExit as exc:
                print(exc)
                return 1
            m = kb.manifest
            print(f"  {m.get('title')}　策略={m.get('content_policy')}　"
                  f"观点={len(kb.opinions)} 标的={len(kb.instruments)}")
            stats = import_kb(con, cfg, kb)
            if kb.documents:
                stats["doc_texts"] = import_document_texts(con, kb)
            for k in total:
                total[k] += stats.get(k, 0)

        print(f"\n合计：标的 {total['instruments']}　作者 {total['authors']}　"
              f"文档 {total['docs']}（含原文 {total['doc_texts']}）　"
              f"观点 {total['opinions']}　回测 {total['evaluations']}　"
              f"跳过 {total['skipped']}")
        if total["doc_texts"] == 0 and total["docs"]:
            print("  注意：这是 evidence_only 知识库，没有原文；")
            print("        对应的文档只作元数据存根，不会被本地重新抽取。")
        print("\n下一步：python run.py report")
    return 0


def cmd_audit(args, cfg: Config) -> int:
    """用大V的框架**检验**你写下的操作（不是替你操作）。"""
    from .extract.audit import build_audit_request
    from .extract.llm_extractor import LLMExtractor
    from .extract.persona import load_persona, persona_to_prompt

    with session(cfg) as con:
        init_db(con)
        lex = load_lexicon(cfg)
        resolver = SubjectResolver.from_db(con, lex.aliases)
        row = con.execute(
            "SELECT id, name FROM author WHERE name = ?", (args.author,)
        ).fetchone()
        if not row:
            print(f"没有找到大V：{args.author}")
            return 1
        persona = load_persona(con, int(row["id"]))
        if not persona:
            print(f"「{row['name']}」还没有决策框架，先跑：\n"
                  f"    python run.py profile-author --author {row['name']}")
            return 1

        ops = args.operations
        if not ops:
            if args.file:
                ops = Path(args.file).read_text(encoding="utf-8")
            else:
                print("请用 --operations 写下要检验的操作，或 --file 指定文件。")
                print('例：--operations "7/20 跌到 0.8471 加仓"')
                return 1

        llm = LLMExtractor(cfg, resolver, lex)
        if not llm.available():
            print("! 未配置 API key")
            return 1
        system = persona_to_prompt(persona, row["name"])
        prompt = build_audit_request(system, ops, args.context or "（无）", row["name"])
        print(f"用「{row['name']}」的框架检验你的操作")
        print("=" * 70)
        print(llm.chat_text(prompt))
        print("=" * 70)
        u = llm.usage
        print(f"LLM 用量：{u['calls']} 次，{u['total_tokens']} tokens")
    return 0


def cmd_author_alias(args, cfg: Config) -> int:
    """记录同一个大V在**其他平台**的别名。

    为什么需要：同一个人跨平台就是一个军师、多份语料。
    语料要合并、身份要统一，而且粉丝会直接用别名称呼他
    （例如雪球上粉丝会用别名而非主名去称呼他），
    抽取和画像都得认得出这是同一个人。
    """
    import json as _json

    from .textutil import now_iso

    with session(cfg) as con:
        init_db(con)
        row = con.execute(
            "SELECT id, name, source, platforms FROM author WHERE name = ?",
            (args.author,),
        ).fetchone()
        if not row:
            print(f"没有找到大V：{args.author}")
            return 1
        try:
            plats = _json.loads(row["platforms"] or "[]")
            if not isinstance(plats, list):
                plats = []
        except (TypeError, ValueError):
            plats = []

        if args.remove:
            before = len(plats)
            plats = [p for p in plats
                     if not (isinstance(p, dict) and p.get("source") == args.remove)]
            if len(plats) == before:
                print(f"没有记录 {args.remove}，无需删除")
            else:
                con.execute("UPDATE author SET platforms = ? WHERE id = ?",
                            (_json.dumps(plats, ensure_ascii=False), row["id"]))
                con.commit()
                print(f"已删除 {args.remove} 的记录")

        if args.set_note is not None:
            con.execute("UPDATE author SET note = ? WHERE id = ?",
                        (args.set_note, row["id"]))
            con.commit()
            print(f"已更新备注：{args.set_note}")

        if args.add:
            source, _, name = args.add.partition("=")
            source, name = source.strip(), name.strip()
            if not source or not name:
                print('格式应为 --add "平台=名字"，例如 --add "某平台=某别名"')
                return 1
            plats = [p for p in plats
                     if not (isinstance(p, dict) and p.get("source") == source)]
            entry: dict[str, str] = {"source": source, "name": name}
            if args.note:
                entry["note"] = args.note
            plats.append(entry)
            con.execute("UPDATE author SET platforms = ? WHERE id = ?",
                        (_json.dumps(plats, ensure_ascii=False), row["id"]))
            con.commit()
            print(f"已记录：{row['name']} 在 {source} 叫「{name}」")

        plats = _json.loads(
            con.execute("SELECT platforms FROM author WHERE id = ?",
                        (row["id"],)).fetchone()["platforms"] or "[]")
        print(f"\n「{row['name']}」的跨平台身份：")
        print(f"  {row['source']:10} {row['name']}（主）")
        for p in plats:
            if isinstance(p, dict):
                note = f"　{p['note']}" if p.get("note") else ""
                print(f"  {p.get('source',''):10} {p.get('name','')}{note}")
        if not plats:
            print("  （还没记录其他平台）")
        nrow = con.execute("SELECT note FROM author WHERE id = ?",
                           (row["id"],)).fetchone()
        if nrow and nrow["note"]:
            print(f"\n备注：{nrow['note']}")
        print("\n下次跑 profile-author 时，画像和决策框架会带上这些身份。")
        print("采集新平台语料后，用同名入库即可归到同一个人。")
    return 0


def cmd_dedupe(args, cfg: Config) -> int:
    """标记重复观点。大V 反复顶帖/分别回复会生成多条相同帖子，必须去重。"""
    from .backtest.dedupe import duplicate_examples, mark_duplicates

    with session(cfg) as con:
        init_db(con)
        stats = mark_duplicates(con, author=args.author)
        print(f"观点总数 {stats['total']}")
        print(f"重复    {stats['duplicates']}  "
              f"({stats['dup_rate'] * 100:.1f}%)，涉及 {stats['dup_groups']} 组")
        print(f"独立    {stats['unique']}")
        print()
        print("重复最严重的几组（人工核对用）：")
        for ex in duplicate_examples(con, limit=12):
            print(f"  {ex['subject']:<14} {ex['n']} 次  "
                  f"{ex['first']} ~ {ex['last']}")
            print(f"      {ex['evidence'][:80]}")
        print()
        print("说明：同一作者 + 同一标的 + 同一段证据文本，只保留最早一条。")
        print("      后续所有统计都会排除重复项，否则样本量虚高、p 值假性显著。")
        print("\n下一步：python run.py evaluate && python run.py report")
    return 0


def cmd_profile_author(args, cfg: Config) -> int:
    """用 LLM 归纳作者画像 + **可迁移的决策框架**（数字化的他）。"""
    from .extract.llm_extractor import LLMExtractor
    from .extract.persona import generate_persona
    from .extract.profiler import generate_profile

    with session(cfg) as con:
        init_db(con)
        lex = load_lexicon(cfg)
        resolver = SubjectResolver.from_db(con, lex.aliases)
        llm = LLMExtractor(cfg, resolver, lex)
        if not llm.available():
            print("! 未配置 API key（STOCKTOOL_LLM_API_KEY 或 config/llm_api_key.txt）")
            return 1

        sql = "SELECT id, name, source FROM author"
        params: list[str] = []
        if args.author:
            sql += " WHERE name = ?"
            params.append(args.author)
        authors = con.execute(sql, params).fetchall()
        if not authors:
            print("没有匹配的大V")
            return 1

        for a in authors:
            n = con.execute(
                "SELECT COUNT(*) c FROM opinion WHERE author_id = ?", (a["id"],)
            ).fetchone()["c"]
            if n < 5:
                print(f"跳过 {a['name']}：观点太少（{n} 条）")
                continue

            if not args.skip_profile:
                print(f"\n为「{a['name']}」生成风格画像（基于 {n} 条观点）…")
                try:
                    data = generate_profile(con, cfg, llm, int(a["id"]))
                except Exception as exc:  # noqa: BLE001
                    print(f"  ! 失败：{type(exc).__name__}: {exc}")
                    continue
                print(f"  画像：{(data.get('summary') or '')[:180]}")
                print(f"  风格：{'、'.join(data.get('style_tags') or [])}")
                print(f"  周期倾向：{data.get('horizon_bias')}")

            if not args.skip_persona:
                print(f"\n为「{a['name']}」提炼决策框架（数字化的他）…")
                try:
                    p = generate_persona(con, cfg, llm, int(a["id"]))
                except Exception as exc:  # noqa: BLE001
                    print(f"  ! 失败：{type(exc).__name__}: {exc}")
                    continue
                print(f"  定位：{p.get('identity')}")
                fws = p.get("frameworks") or []
                if fws:
                    print(f"\n  核心方法论 {len(fws)} 个（检验操作时优先用这些）：")
                    for f in fws:
                        if isinstance(f, dict):
                            print(f"    ◆ {f.get('name','（未命名）')} —— "
                                  f"{(f.get('content') or '')[:70]}")
                rules = p.get("decision_rules") or []
                print(f"\n  决策规则 {len(rules)} 条：")
                for r in rules[:4]:
                    if isinstance(r, dict):
                        print(f"    当「{r.get('when','')}」→「{r.get('then','')}」")
                if len(rules) > 4:
                    print(f"    … 另有 {len(rules) - 4} 条")
                vetoes = p.get("vetoes") or []
                print(f"  否决条件 {len(vetoes)} 条：")
                for v in vetoes[:3]:
                    print(f"    ✗ {v}")
                chk = p.get("checklist") or []
                print(f"  判断清单 {len(chk)} 步")
                v = p.get("voice") or {}
                print(f"  口头禅：{'、'.join((v.get('catchphrases') or [])[:8])}")

        u = llm.usage
        print(f"\nLLM 用量：{u['calls']} 次，{u['total_tokens']} tokens")
        print("\n下一步：python run.py kb-export ...")
    return 0


def cmd_baseline(args, cfg: Config) -> int:
    """计算随机选股基线 —— 绩效榜判定的正确对照组。"""
    from .backtest import compute_baseline

    with session(cfg) as con:
        init_db(con)
        print("抽样计算对照基线（随机选股 + 一律看多，同一批日期）…")
        try:
            res = compute_baseline(
                con, cfg,
                horizons=args.horizons,
                author=args.author,
                sample_stocks=args.sample,
                seed=args.seed,
                fetch_missing=not args.no_fetch,
                progress=print,
            )
        except SystemExit as exc:
            print(exc)
            return 1

        print(f"\n基准 {res['benchmark_secid']}　"
              f"观点日期 {res['dates']} 个　抽样个股 {res['sample_stocks']} 只")
        print(f"{'周期':<8}{'对照样本':>10}{'随机命中率':>12}{'平均超额':>12}")
        for h, row in sorted(res["horizons"].items()):
            print(f"T+{h:<6}{row['n']:>10}{row['hit_rate'] * 100:>11.2f}%"
                  f"{row['mean_excess'] * 100:>11.2f}%")
        print("\n说明：这个基线才是「随机」的正确答案。")
        print("      A 股里中位数个股跑输市值加权指数，所以基线不是 50%。")
        print("      绩效榜的判定现在对着它，而不是对着 50%。")
        print("\n下一步：python run.py report")
    return 0


def cmd_re_resolve(args, cfg: Config) -> int:
    """补了别名/映射表之后，重新解析未归属的观点。

    这是省钱的关键：LLM 抽取的昂贵部分是「读懂内容」，
    而「这段话提到的名字对应哪个可交易标的」是纯字典查找。
    字典补全后重跑解析即可，**不需要再调一次 LLM**。
    """
    from .extract.resolver import resolve_raw_subject

    with session(cfg) as con:
        init_db(con)
        lex = load_lexicon(cfg)

        # 1) 先把最新的别名灌进库（含 sectors.json 的板块映射）
        sector_insts, sector_aliases = load_sectors(cfg.sectors_path)
        if sector_insts:
            upsert_instruments(con, sector_insts, now_iso())
        rows = list(sector_aliases) + load_alias_rows(con, lex.aliases)
        n_alias = upsert_aliases(con, rows, origin="manual")
        con.commit()
        print(f"别名表已刷新：{n_alias} 条")

        # 2) 重建解析器再解析
        resolver = SubjectResolver.from_db(con, lex.aliases)
        bench = benchmark_instrument(con, cfg)
        pending = con.execute(
            "SELECT id, subject_raw FROM opinion "
            "WHERE subject_secid IS NULL AND subject_raw IS NOT NULL "
            "AND TRIM(subject_raw) != ''"
        ).fetchall()
        print(f"待重新解析的观点：{len(pending)} 条")

        fixed = 0
        gained: dict[str, tuple[str, int]] = {}
        for r in pending:
            found = resolve_raw_subject(resolver, lex, r["subject_raw"], bench)
            if found is None or not found.secid:
                continue
            con.execute(
                "UPDATE opinion SET subject_secid = ?, subject_type = ?, "
                "resolved = 1, match_conf = ? WHERE id = ?",
                (found.secid, found.type, found.confidence, r["id"]),
            )
            fixed += 1
            key = str(r["subject_raw"])
            name, cnt = gained.get(key, (found.secid, 0))
            gained[key] = (name, cnt + 1)
        con.commit()

        total = con.execute("SELECT COUNT(*) c FROM opinion").fetchone()["c"]
        resolved = con.execute(
            "SELECT COUNT(*) c FROM opinion WHERE subject_secid IS NOT NULL"
        ).fetchone()["c"]
        print(f"新解析成功：{fixed} 条")
        print(f"归属率：{resolved}/{total} = {resolved / total * 100:.1f}%"
              f"（此前 {(resolved - fixed) / total * 100:.1f}%）")

        top = sorted(gained.items(), key=lambda kv: -kv[1][1])[:15]
        if top:
            print("\n受益最大的关键词：")
            name_map = {
                row["secid"]: row["name"]
                for row in con.execute("SELECT secid, name FROM instrument")
            }
            for kw, (secid, cnt) in top:
                print(f"  {kw:<16} {cnt:4} 条  ->  {name_map.get(secid, secid)}")

        still = con.execute(
            "SELECT subject_raw, COUNT(*) n FROM opinion "
            "WHERE subject_secid IS NULL AND subject_raw IS NOT NULL "
            "GROUP BY subject_raw ORDER BY n DESC LIMIT 15"
        ).fetchall()
        if still:
            print("\n仍未归属（需要继续补映射，或确实没有可交易标的）：")
            for r in still:
                print(f"  {r['subject_raw']:<18} {r['n']} 条")
        print("\n下一步：python run.py fetch-quotes && python run.py evaluate")
    return 0


def cmd_extract(args, cfg: Config) -> int:
    with session(cfg) as con:
        init_db(con)
        lex = load_lexicon(cfg)
        resolver = SubjectResolver.from_db(con, lex.aliases)
        if not resolver.table:
            print("! 标的表为空，请先执行 fetch-universe")
            return 1
        bench = benchmark_instrument(con, cfg)

        llm = None
        mode = args.extractor or ("both" if getattr(args, "llm", False) else "rule")
        if mode in ("llm", "both"):
            from .extract.llm_extractor import LLMExtractor
            llm = LLMExtractor(cfg, resolver, lex)
            if not llm.available():
                print("! 未配置 STOCKTOOL_LLM_API_KEY（或 DEEPSEEK_API_KEY）")
                if mode == "llm":
                    return 1
                print("  已回退为纯规则抽取")
                mode = "rule"
            else:
                print(f"  抽取器：{mode}（模型 {llm.model}）")

        stats = run_extraction(con, cfg, lex, resolver, benchmark=bench,
                               llm=llm, extractor=mode,
                               limit=args.limit,
                               latest=getattr(args, "latest", None),
                               concurrency=getattr(args, "concurrency", 1) or 1,
                               purge=not getattr(args, "no_purge", False))
        print(f"处理文档 {stats['docs']} 篇，抽出观点 {stats['opinions']} 条"
              f"（已归属标的 {stats['resolved']}，未归属 {stats['unresolved']}）")
        if stats.get("purged"):
            print(f"  已清理旧观点 {stats['purged']} 条（切句/规则变更后重建）")
        if stats.get("failed"):
            print(f"  ⚠️ 抽取失败 {stats['failed']} 篇（详见上方错误）")
        if mode == "both":
            print(f"  其中规则 {stats['rule_opinions']} 条、LLM {stats['llm_opinions']} 条"
                  f"（合并后 {stats['opinions']} 条，冲突时 LLM 优先）")
        if llm is not None and llm.calls:
            u = llm.usage
            print(f"  LLM 用量：{u['calls']} 次调用，"
                  f"输入 {u['prompt_tokens']} / 输出 {u['completion_tokens']} "
                  f"= {u['total_tokens']} tokens"
                  + (f"，失败 {u['failures']} 次" if u["failures"] else ""))
        if stats["llm_opinions"]:
            print(f"  其中 LLM 补充 {stats['llm_opinions']} 条"
                  f"（来自 {stats['llm_docs']} 篇）")
        print("  标的匹配统计："
              f"cashtag={resolver.stats.cashtag} 裸代码={resolver.stats.bare_code} "
              f"名称={resolver.stats.name} 别名={resolver.stats.alias} "
              f"歧义={resolver.stats.ambiguous} 未命中={resolver.stats.miss}")
        if args.show:
            rows = con.execute(
                "SELECT * FROM v_opinion ORDER BY stated_date DESC LIMIT ?",
                (args.show,),
            ).fetchall()
            print()
            for r in rows:
                arrow = "看多" if r["polarity"] > 0 else "看空"
                print(f"  [{r['stated_date']}] {r['author']} {arrow} "
                      f"{r['subject_name']} ({r['subject_secid'] or '未归属'}) "
                      f"强度{r['strength']} {r['horizon']}")
                print(f"      {r['sentence'][:90]}")
    return 0


def cmd_fetch_quotes(args, cfg: Config) -> int:
    with session(cfg) as con:
        init_db(con)
        targets = quote_targets(con, cfg, args.secids)
        if not targets:
            print("没有需要抓取的标的，先跑 fetch-universe / extract")
            return 0
        svc = PriceService(cfg)
        print(f"候选数据源顺序：{' -> '.join(svc.order)}")
        print(f"待处理标的 {len(targets)} 个")

        fetched = skipped = 0
        failures: list[str] = []
        source_count: dict[str, int] = {}
        for i, inst in enumerate(targets, 1):
            _, _, n = quote_coverage(con, inst.secid)
            if n > 0 and not args.refresh:
                skipped += 1
                continue
            bars, source = svc.bars(inst)
            if not bars:
                failures.append(f"{inst.name}({inst.secid}) [{source}]")
                continue
            upsert_quotes(con, inst.secid, bars, source=source)
            source_count[source] = source_count.get(source, 0) + 1
            fetched += 1
            if i % 25 == 0:
                con.commit()
                print(f"  … {i}/{len(targets)}")
        con.commit()

        print(f"行情入库：成功 {fetched}，跳过（已有数据）{skipped}，失败 {len(failures)}")
        if source_count:
            print("  数据源命中：" + "　".join(
                f"{k}={v}" for k, v in source_count.items()))
        for f in failures[:15]:
            print(f"  ! {f}")
        if len(failures) > 15:
            print(f"  ! …另有 {len(failures) - 15} 个失败")

        cal = trading_calendar(con, str(cfg.values["benchmark_secid"]))
        if cal:
            print(f"交易日历：{cal[0]} ~ {cal[-1]}（{len(cal)} 个交易日）")
        else:
            print("! 基准指数没有行情，回测无法进行")
    return 0


def cmd_evaluate(args, cfg: Config) -> int:
    with session(cfg) as con:
        init_db(con)
        stats = evaluate_all(con, cfg, horizons=args.horizons)
        print(f"回测完成：涉及观点 {stats['opinions']} 条　"
              f"可评价 {stats['ok']}　待观察 {stats['pending']}　缺数据 {stats['no_data']}　"
              f"写入明细 {stats['rows']} 行")
        if stats.get("self_benchmark"):
            print(f"  其中 {stats['self_benchmark']} 条是「大盘」类观点（标的即基准），"
                  f"超额收益恒为 0，已排除出绩效榜")
    return 0


def cmd_report(args, cfg: Config) -> int:
    with session(cfg) as con:
        init_db(con)
        horizons = args.horizons or list(cfg.values["horizons"])
        bench = str(cfg.values["benchmark_secid"])
        min_samples = int(cfg.values["min_samples_for_rank"])
        since = args.since or (
            datetime.now() - timedelta(days=args.consensus_days)
        ).strftime("%Y-%m-%d")

        parts = [render_header("大V 观点绩效报告", cfg)]
        parts.append(render_overview(con, cfg))
        parts.append("\n## 一、大V 绩效榜\n")

        boards: dict[int, list[dict]] = {}
        for h in horizons:
            board = build_scoreboard(con, cfg, horizon=h, benchmark_secid=bench)
            boards[h] = board
            parts.append(f"\n### 评价周期 T+{h} 交易日\n")
            parts.append(render_scoreboard(board, horizon=h,
                                           benchmark_secid=bench,
                                           min_samples=min_samples))
            print(f"\n=== 大V 绩效榜 · T+{h} ===")
            print(render_scoreboard(board, horizon=h, benchmark_secid=bench,
                                    min_samples=min_samples))

        primary = horizons[0]
        parts.append(render_author_detail(boards[primary], limit=args.detail))

        consensus = build_consensus(con, cfg, since_date=since,
                                    benchmark_secid=bench,
                                    min_authors=args.min_authors)
        scope_label = f"{since} 起（最近 {args.consensus_days} 天）"
        if not consensus:
            consensus = build_consensus(con, cfg, since_date=None,
                                        benchmark_secid=bench,
                                        min_authors=args.min_authors)
            scope_label = (f"全部历史 —— 最近 {args.consensus_days} 天内没有新观点，"
                           "已自动回退到全量口径")

        parts.append("\n## 二、板块 / 标的共识\n")
        parts.append(render_consensus(consensus, scope_label=scope_label,
                                      min_authors=args.min_authors))
        parts.append(render_caveats())
        content = "\n".join(parts)

        cfg.report_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        out = cfg.report_dir / f"report_{stamp}.md"
        out.write_text(content, encoding="utf-8")
        latest = cfg.report_dir / "latest.md"
        latest.write_text(content, encoding="utf-8")

        print(f"\n=== 板块 / 标的共识（{scope_label}）===")
        for r in consensus[:12]:
            print(f"  {r['score']:+.3f}  {r['name']} ({r['code']}, {r['type']})  "
                  f"看多{r['bull']}/看空{r['bear']}  大V{r['n_authors']}位")
        if not consensus:
            print("  （无数据）")
        print(f"\n报告已写入: {out}")
        print(f"            {latest}")
    return 0


def cmd_status(args, cfg: Config) -> int:
    with session(cfg) as con:
        init_db(con)
        print(render_overview(con, cfg))
        print("标的分布：")
        for r in con.execute(
            "SELECT type, COUNT(*) n FROM instrument GROUP BY type ORDER BY n DESC"
        ):
            print(f"  {r['type']:<10} {r['n']}")
        cal = trading_calendar(con, str(cfg.values["benchmark_secid"]))
        if cal:
            print(f"交易日历：{cal[0]} ~ {cal[-1]}（{len(cal)} 天）")
        else:
            print("交易日历：无（先跑 fetch-quotes）")
        print("\n最近抽取结果（前 10 条）：")
        for r in con.execute(
            "SELECT * FROM v_opinion ORDER BY stated_date DESC LIMIT 10"
        ):
            arrow = "看多" if r["polarity"] > 0 else "看空"
            print(f"  [{r['stated_date']}] {r['author']} {arrow} "
                  f"{r['subject_name']} {r['subject_secid'] or '未归属'}")
    return 0


def cmd_pipeline(args, cfg: Config) -> int:
    steps = [
        ("初始化数据库", cmd_initdb),
        ("拉取标的全集", cmd_fetch_universe),
        ("导入语料", cmd_import),
        ("抽取观点", cmd_extract),
        ("抓取行情", cmd_fetch_quotes),
        ("回测打分", cmd_evaluate),
        ("生成报告", cmd_report),
    ]
    started = now_iso()
    for i, (label, fn) in enumerate(steps, 1):
        print(f"\n{'=' * 64}\n[{i}/{len(steps)}] {label}\n{'=' * 64}")
        code = fn(args, cfg)
        if code != 0:
            print(f"! 步骤「{label}」失败，中止")
            return code

    with session(cfg) as con:
        log_run(con, "pipeline", started, "ok", finished_at=now_iso())
        con.commit()
    return 0


# ---------------------------------------------------------------- 参数

def _add_common_quote_args(s: argparse.ArgumentParser) -> None:
    s.add_argument("--refresh", action="store_true", help="重新抓取已有数据")
    s.add_argument("--secids", nargs="*", help="额外指定的 secid")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="stocktool",
        description="把大V产出转成可回测的结构化观点",
    )
    p.add_argument("--db", help="覆盖数据库路径")
    p.add_argument("--settings", help="配置文件路径")
    sub = p.add_subparsers(dest="command")

    s = sub.add_parser("initdb", help="建库")
    s.add_argument("--reset", action="store_true",
                   help="清空并重建（schema 变更后需要）")
    s.set_defaults(func=cmd_initdb)

    s = sub.add_parser("fetch-universe", help="拉取标的全集")
    s.add_argument("--skip-stocks", action="store_true", help="跳过个股列表")
    s.add_argument("--with-boards", action="store_true",
                   help="同时尝试东财行业/概念板块指数（可能被限流）")
    s.set_defaults(func=cmd_fetch_universe)

    s = sub.add_parser("import", help="导入语料（种子/手工粘贴）")
    s.add_argument("paths", nargs="*", help="文件路径；留空则读 data/seed/")
    s.add_argument("--source", help="源标识，默认 manual")
    s.set_defaults(func=cmd_import)

    s = sub.add_parser("collect-xueqiu", help="全量归档某个雪球账号的发言")
    s.add_argument("who", help="雪球昵称，或数字 uid")
    s.add_argument("--cookie", help="直接传 Cookie 字符串（默认读配置文件/环境变量）")
    s.add_argument("--expect-name", help="预期昵称，与接口返回不一致则中止（防抓错人）")
    s.add_argument("--with-comments", action="store_true",
                   help="同时抓取作者本人在自己帖子下的评论")
    s.add_argument("--max-pages", type=int, default=500, help="最多翻多少页")
    s.set_defaults(func=cmd_collect_xueqiu)

    s = sub.add_parser("probe-xueqiu", help="验证雪球 Cookie 与接口形态（不入库）")
    s.add_argument("who", help="雪球昵称，或数字 uid")
    s.add_argument("--cookie", help="直接传 Cookie 字符串")
    s.add_argument("--expect-name", help="预期昵称，与接口返回不一致则中止")
    s.set_defaults(func=cmd_probe_xueqiu)

    s = sub.add_parser("import-xueqiu",
                       help="导入浏览器控制台导出的雪球 JSON（当前主通道）")
    s.add_argument("paths", nargs="*",
                   help="JSON 文件或目录；留空则读 data/raw/xueqiu/")
    s.add_argument("--expect-uid", help="预期 uid，不匹配则中止（防抓错人）")
    s.add_argument("--expect-name", help="预期昵称，不匹配则中止")
    s.set_defaults(func=cmd_import_xueqiu)

    # ---- 知识库 ----
    s = sub.add_parser("kb-export", help="导出知识库（App 是引擎，知识库是内容）")
    s.add_argument("out", nargs="?", help="输出路径；.stkb 打 zip，目录则写散文件")
    s.add_argument("--policy", choices=["evidence_only", "full_text"],
                   default="evidence_only",
                   help="evidence_only=不含原文可分享（默认）；full_text=含原文仅自用")
    s.add_argument("--author", action="append", help="只导出指定大V（可重复）")
    s.add_argument("--source", help="只导出指定来源")
    s.add_argument("--kb-id", help="指定 kb_id")
    s.add_argument("--title", help="指定标题")
    s.add_argument("--no-eval", action="store_true", help="不带回测结果")
    s.add_argument("--max-quote", type=int, default=200,
                   help="evidence 引用字数上限")
    s.set_defaults(func=cmd_kb_export)

    s = sub.add_parser("kb-validate", help="校验知识库是否符合规范")
    s.add_argument("paths", nargs="+")
    s.set_defaults(func=cmd_kb_validate)

    s = sub.add_parser("kb-info", help="查看知识库信息")
    s.add_argument("path")
    s.add_argument("--no-hash", action="store_true", help="跳过完整性校验")
    s.add_argument("--author-path", help="把 author.json 另存到指定路径")
    s.set_defaults(func=cmd_kb_info)

    s = sub.add_parser("kb-import", help="载入知识库到本地库")
    s.add_argument("paths", nargs="+")
    s.add_argument("--no-validate", action="store_true",
                   help="跳过校验（不建议）")
    s.set_defaults(func=cmd_kb_import)

    s = sub.add_parser("extract", help="抽取结构化观点")
    s.add_argument("--extractor", choices=["rule", "llm", "both"],
                   help="rule=零成本词表 / llm=理解口语化内容（需API key）/ both=LLM优先合并")
    s.add_argument("--llm", action="store_true",
                   help="等价于 --extractor both（保留兼容）")
    s.add_argument("--latest", type=int, help="只处理最近 N 篇（增量跑用）")
    s.add_argument("--concurrency", type=int, default=6,
                   help="LLM 并发数，默认 6。串行跑 2000 篇要一两个小时")
    s.add_argument("--no-purge", action="store_true",
                   help="重建时不清理旧观点（默认会清理，避免幽灵数据）")
    s.add_argument("--limit", type=int, help="只处理前 N 篇（按时间正序）")
    s.add_argument("--show", type=int, default=0, help="打印最近 N 条观点")
    s.set_defaults(func=cmd_extract)

    s = sub.add_parser("audit",
                       help="用大V的框架检验你的操作（不是替你操作）")
    s.add_argument("--author", required=True)
    s.add_argument("--operations", help='要检验的操作，如 "7/20 跌到0.8471加仓"')
    s.add_argument("--file", help="从文件读操作清单（一行一条）")
    s.add_argument("--context", help="补充背景，如持仓构成")
    s.set_defaults(func=cmd_audit)

    s = sub.add_parser("author-alias",
                       help="记录同一大V在其他平台的别名（跨平台=一个军师）")
    s.add_argument("--author", required=True, help="主名，如 示例大V")
    s.add_argument("--add", help='新增/覆盖，格式 "平台=名字"，如 "某平台=某别名"')
    s.add_argument("--remove", help="删除某个平台的记录，如 --remove 某平台")
    s.add_argument("--set-note", help="设置作者备注（平台无关的事实）")
    s.add_argument("--note", help="配合 --add 用的平台备注")
    s.set_defaults(func=cmd_author_alias)

    s = sub.add_parser("dedupe",
                       help="标记重复观点（同一段话反复发帖只算一次）")
    s.add_argument("--author", help="只处理指定大V")
    s.set_defaults(func=cmd_dedupe)

    s = sub.add_parser("profile-author",
                       help="归纳作者画像 + 可迁移的决策框架（数字化的他）")
    s.add_argument("--author", help="只处理指定大V")
    s.add_argument("--skip-profile", action="store_true",
                   help="只提炼决策框架，不重生成风格画像")
    s.add_argument("--skip-persona", action="store_true",
                   help="只生成风格画像，不提炼决策框架")
    s.set_defaults(func=cmd_profile_author)

    s = sub.add_parser("baseline",
                       help="计算随机选股基线（绩效榜判定的正确对照组）")
    s.add_argument("--horizons", nargs="*", type=int)
    s.add_argument("--author", help="只用某个大V的观点日期做抽样")
    s.add_argument("--sample", type=int, default=180, help="抽多少只个股")
    s.add_argument("--seed", type=int, default=20261008, help="随机种子（保证可复现）")
    s.add_argument("--no-fetch", action="store_true", help="不补拉行情")
    s.set_defaults(func=cmd_baseline)

    s = sub.add_parser("re-resolve",
                       help="补别名后重新解析未归属的观点（零 API 成本）")
    s.set_defaults(func=cmd_re_resolve)

    s = sub.add_parser("fetch-quotes", help="抓取日线行情")
    _add_common_quote_args(s)
    s.set_defaults(func=cmd_fetch_quotes)

    s = sub.add_parser("evaluate", help="回测打分")
    s.add_argument("--horizons", nargs="*", type=int, help="评价周期，如 5 20 60")
    s.set_defaults(func=cmd_evaluate)

    s = sub.add_parser("report", help="生成绩效报告")
    s.add_argument("--horizons", nargs="*", type=int, help="评价周期，取第一个出榜")
    s.add_argument("--since", help="共识统计起始日 YYYY-MM-DD")
    s.add_argument("--consensus-days", type=int, default=90, help="共识默认回看天数")
    s.add_argument("--min-authors", type=int, default=1, help="共识最少参与大V")
    s.add_argument("--detail", type=int, default=5, help="明细展示的作者数")
    s.set_defaults(func=cmd_report)

    sub.add_parser("status", help="查看数据概况").set_defaults(func=cmd_status)

    s = sub.add_parser("pipeline", help="一键跑通全链路")
    s.add_argument("--reset", action="store_true", help="重建数据库")
    s.add_argument("--skip-stocks", action="store_true")
    s.add_argument("--with-boards", action="store_true")
    s.add_argument("--extractor", choices=["rule", "llm", "both"])
    s.add_argument("--no-purge", action="store_true")
    s.add_argument("--latest", type=int)
    s.add_argument("--concurrency", type=int, default=6)
    s.add_argument("--llm", action="store_true")
    s.add_argument("--limit", type=int)
    s.add_argument("--show", type=int, default=0)
    s.add_argument("--source")
    s.add_argument("paths", nargs="*", help="语料文件路径（可选）")
    _add_common_quote_args(s)
    s.add_argument("--horizons", nargs="*", type=int)
    s.add_argument("--since")
    s.add_argument("--consensus-days", type=int, default=90)
    s.add_argument("--min-authors", type=int, default=1)
    s.add_argument("--detail", type=int, default=5)
    s.set_defaults(func=cmd_pipeline)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 1

    cfg = load_config(Path(args.settings) if args.settings else None)
    if args.db:
        cfg.values["db_path"] = args.db

    try:
        return args.func(args, cfg)
    except KeyboardInterrupt:
        print("\n已中断")
        return 130
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        print(f"\n[错误] {type(exc).__name__}: {exc}", file=sys.stderr)
        raise


if __name__ == "__main__":
    raise SystemExit(main())
