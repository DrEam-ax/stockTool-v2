"""核查标的归属：LLM 给的标的名，真的出现在原文里吗？

这是一个必须做的质检 —— 我们过滤了幻觉引用（quote 必须在原文逐字存在），
但没有验证**标的名**是否真的在原文里。
如果模型凭空写出一个标的名，解析器会照样把它当有效标的，
于是那条观点就被错误地算到那只票头上，而且完全不会报错。

这个脚本对全部观点做一次体检。
"""

import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from stocktool.config import load_config  # noqa: E402
from stocktool.db import connect  # noqa: E402


def main() -> int:
    target = sys.argv[1] if len(sys.argv) > 1 else None
    cfg = load_config()
    con = connect(cfg)

    rows = con.execute(
        """
        SELECT o.id, o.stated_date, o.subject_raw, o.subject_secid, o.polarity,
               o.sentence, o.evidence, o.confidence, o.extractor,
               i.name AS inst_name, d.external_id, t.text AS doc_text,
               a.name AS author
        FROM opinion o
        LEFT JOIN instrument i ON i.secid = o.subject_secid
        JOIN doc d ON d.id = o.doc_id
        LEFT JOIN doc_text t ON t.doc_id = d.id
        JOIN author a ON a.id = o.author_id
        WHERE o.subject_secid IS NOT NULL
        ORDER BY o.stated_date
        """
    ).fetchall()

    # 标的名是否出现在原文里（原名 或 标的正式名 命中任一即可）
    missing = []
    for r in rows:
        raw = (r["subject_raw"] or "").strip()
        inst = (r["inst_name"] or "").strip()
        text = r["doc_text"] or ""
        hit = (raw and raw in text) or (inst and inst in text)
        if not hit:
            missing.append(r)

    total = len(rows)
    print("=" * 78)
    print("标的归属质检：标的名是否真的出现在原文里")
    print("=" * 78)
    print(f"已归属标的的观点: {total} 条")
    print(f"标的名**查不到**的: {len(missing)} 条 ({len(missing) / total * 100:.1f}%)")
    print()

    if missing:
        by_inst = Counter(r["inst_name"] or r["subject_raw"] for r in missing)
        print("查不到最多的标的（这些归属很可能是错的）：")
        for name, c in by_inst.most_common(20):
            print(f"  {name:<16} {c:4} 条")
        print()
        print("样例（前 8 条）：")
        for r in missing[:8]:
            print(f"  --- {r['stated_date']}  {r['subject_raw']!r} -> {r['inst_name']!r}")
            print(f"      evidence: {str(r['evidence'])[:100]}")
            print(f"      原文含'圣农'? {'圣农' in (r['doc_text'] or '')}")
        print()

    # 专门看某个标的
    if target:
        sub = [r for r in rows if r["inst_name"] == target or r["subject_raw"] == target]
        print("=" * 78)
        print(f"「{target}」的全部 {len(sub)} 条观点")
        print("=" * 78)
        ok = 0
        for r in sub:
            text = r["doc_text"] or ""
            raw = r["subject_raw"] or ""
            inst = r["inst_name"] or ""
            hit = (raw and raw in text) or (inst and inst in text)
            ok += 1 if hit else 0
            mark = "OK " if hit else "!! "
            print(f"{mark}{r['stated_date']}  raw={raw!r}  原文命中={hit}  "
                  f"conf={r['confidence']}")
            print(f"     {str(r['evidence'])[:120]}")
            print(f"     doc={r['external_id']}")
        print()
        print(f"其中 {ok}/{len(sub)} 条能在原文里找到标的名")

    # 日期分布：帮助判断"他是不是只在很久以前提过"
    print()
    print("=" * 78)
    print("标的名查不到的观点，按年份分布")
    print("=" * 78)
    for y, c in sorted(Counter(r["stated_date"][:4] for r in missing).items()):
        print(f"  {y}: {c}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
