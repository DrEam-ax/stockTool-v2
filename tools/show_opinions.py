"""查看 LLM 抽出的观点，人工判断方向对不对。"""

import os

# 要分析的大V名字。默认是占位符；用法：
#     $env:STOCKTOOL_AUTHOR = "某大V"
AUTHOR = os.environ.get("STOCKTOOL_AUTHOR", "示例大V")

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from stocktool.config import load_config  # noqa: E402
from stocktool.db import connect  # noqa: E402


def main() -> int:
    cfg = load_config()
    con = connect(cfg)
    rows = con.execute(
        """f"""
        SELECT o.stated_date, o.subject_raw, o.subject_secid, o.subject_type,
               o.polarity, o.strength, o.horizon, o.sentence, o.thesis,
               o.confidence, o.extractor, i.name AS inst_name
        FROM opinion o
        JOIN author a ON a.id = o.author_id
        LEFT JOIN instrument i ON i.secid = o.subject_secid
        WHERE a.name = {AUTHOR} AND o.extractor LIKE 'llm%'
        ORDER BY o.stated_date DESC
        """
    ).fetchall()

    print(f"LLM 抽出 {len(rows)} 条\n")
    for r in rows:
        arrow = "看多" if r["polarity"] > 0 else "看空"
        name = r["inst_name"] or r["subject_raw"] or "（未归属）"
        print(
            f"{r['stated_date']}  {arrow} {name:<12} "
            f"强度{r['strength']} {r['horizon']:<12} conf={r['confidence']:.2f}"
        )
        print(f"    {r['sentence'][:170]}")
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
