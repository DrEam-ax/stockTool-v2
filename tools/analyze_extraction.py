"""抽取结果体检：多少内容与股票无关、抽出的观点质量如何。"""

import os

# 要分析的大V名字。默认是占位符；用法：
#     $env:STOCKTOOL_AUTHOR = "某大V"
AUTHOR = os.environ.get("STOCKTOOL_AUTHOR", "示例大V")

import statistics
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from stocktool.config import load_config  # noqa: E402
from stocktool.db import connect  # noqa: E402


def pct(a: float, b: float) -> str:
    return f"{a / b * 100:.1f}%" if b else "—"


def bar(n: int, scale: int = 1, width: int = 60) -> str:
    return "#" * min(width, n // scale)


def main() -> int:
    cfg = load_config()
    con = connect(cfg)

    total = con.execute("""f"""
        SELECT COUNT(*) c FROM doc d JOIN author a ON a.id = d.author_id
        WHERE a.name = {AUTHOR}
    """).fetchone()["c"]

    with_op = con.execute("""f"""
        SELECT COUNT(DISTINCT o.doc_id) c
        FROM opinion o JOIN author a ON a.id = o.author_id
        WHERE a.name = {AUTHOR}
    """).fetchone()["c"]

    ops = con.execute("""f"""
        SELECT o.stated_date, o.polarity, o.strength, o.horizon, o.extractor,
               o.subject_secid, o.confidence,
               (SELECT COUNT(*) FROM opinion_eval e
                 WHERE e.opinion_id = o.id AND e.status = 'ok') AS n_eval,
               (SELECT COUNT(*) FROM opinion_eval e
                 WHERE e.opinion_id = o.id AND e.hit = 1) AS n_hit
        FROM opinion o JOIN author a ON a.id = o.author_id
        WHERE a.name = {AUTHOR}
    """).fetchall()

    print("=" * 66)
    print("一、内容构成")
    print("=" * 66)
    print(f"总帖子数          : {total}")
    print(f"抽出观点的帖子    : {with_op}  ({pct(with_op, total)})")
    print(f"没有观点的帖子    : {total - with_op}  ({pct(total - with_op, total)})")
    print()
    print("「没有观点」包含三类，都是合理的：")
    print("  1. 与股票无关的内容（AI 评测、生活、吵架）")
    print("  2. 纯转发行情/新闻，没有自己的判断")
    print("  3. 只有情绪宣泄，没有方向（如「索然无味」）")
    print()
    print(f"抽出的观点总数    : {len(ops)}")
    print(f"平均每篇出观点    : {len(ops) / with_op:.2f} 条（仅统计有观点的帖子）")

    print()
    print("=" * 66)
    print("二、观点分布")
    print("=" * 66)
    dirs = Counter("看多" if o["polarity"] > 0 else "看空" for o in ops)
    for k, v in dirs.most_common():
        print(f"  {k}: {v:5}  ({pct(v, len(ops))})  {bar(v, 8)}")

    print("\n  按强度:")
    for s, c in sorted(Counter(o["strength"] for o in ops).items(), reverse=True):
        print(f"    强度 {s}: {c:5}  {bar(c, 8)}")

    print("\n  按周期:")
    hz = {"short": "短期", "mid": "中期", "long": "长期", "unspecified": "未声明"}
    for h, c in Counter(o["horizon"] for o in ops).most_common():
        print(f"    {hz.get(h, h):6}: {c:5}  {bar(c, 8)}")

    print("\n  按年份:")
    for y, c in sorted(Counter(o["stated_date"][:4] for o in ops).items()):
        print(f"    {y}: {c:5}  {bar(c, 4)}")

    print("\n  按抽取器:")
    for e, c in Counter(o["extractor"] for o in ops).most_common():
        print(f"    {e:20}: {c:5}  {bar(c, 8)}")

    print()
    print("=" * 66)
    print("三、可回测性")
    print("=" * 66)
    resolved = sum(1 for o in ops if o["subject_secid"])
    print(f"已归属标的（可回测）: {resolved:5}  ({pct(resolved, len(ops))})")
    print(f"未归属标的          : {len(ops) - resolved:5}  ({pct(len(ops) - resolved, len(ops))})")
    ne = sum(1 for o in ops if o["n_eval"] > 0)
    print(f"已有回测结果的      : {ne:5}  ({pct(ne, len(ops))})")
    pending = sum(
        1 for o in ops
        if o["subject_secid"] and o["n_eval"] == 0
    )
    print(f"已归属但待观察      : {pending:5}（发布太近，窗口未走完）")

    print()
    print("=" * 66)
    print("四、被提及最多的标的")
    print("=" * 66)
    top = con.execute("""f"""
        SELECT i.name, o.subject_secid, COUNT(*) n,
               SUM(CASE WHEN o.polarity > 0 THEN 1 ELSE 0 END) bull,
               SUM(CASE WHEN o.polarity < 0 THEN 1 ELSE 0 END) bear
        FROM opinion o
        JOIN author a ON a.id = o.author_id
        JOIN instrument i ON i.secid = o.subject_secid
        WHERE a.name = {AUTHOR}
        GROUP BY o.subject_secid ORDER BY n DESC LIMIT 20
    """).fetchall()
    for r in top:
        print(f"  {r['name']:<14} {r['n']:4} 次  看多 {r['bull']:3} / 看空 {r['bear']:3}  {bar(r['n'], 2, 30)}")

    print()
    print("=" * 66)
    print("五、未归属的标的（知识库仍会保留，但无法回测）")
    print("=" * 66)
    un = con.execute("""f"""
        SELECT o.subject_raw, COUNT(*) n FROM opinion o
        JOIN author a ON a.id = o.author_id
        WHERE a.name = {AUTHOR} AND o.subject_secid IS NULL AND o.subject_raw IS NOT NULL
        GROUP BY o.subject_raw ORDER BY n DESC LIMIT 20
    """).fetchall()
    if un:
        for r in un:
            print(f"  {r['subject_raw']:<16} {r['n']} 次")
        print("\n  这些多为细分行业（氦气、光刻胶、船舶…），市场上没有对应的可交易 ETF。")
        print("  想回测的话需要在 config/sectors.json 里补映射。")
    else:
        print("  无")

    conf = [o["confidence"] for o in ops if o["confidence"] is not None]
    if conf:
        print()
        print(f"抽取置信度: 中位 {statistics.median(conf):.2f}  平均 {statistics.mean(conf):.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
