"""排查：为什么知识库里回测结果对不上观点 ID。"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from stocktool.kb import read_bundle  # noqa: E402
from stocktool.kb import spec  # noqa: E402
from stocktool.kb.bundle import iter_jsonl  # noqa: E402


def main() -> int:
    files = read_bundle(ROOT / "data" / "kb" / "luo_share.stkb")
    opinions = list(iter_jsonl(files["opinions.jsonl"]))
    evals = list(iter_jsonl(files["evaluations.jsonl"]))

    oids = [o["opinion_id"] for o in opinions]
    oset = set(oids)
    print(f"观点 {len(oids)} 条，去重后 {len(oset)} 个唯一 ID")
    dup = [x for x in set(oids) if oids.count(x) > 1]
    print(f"重复的 opinion_id: {len(dup)}")
    if dup:
        print("  样例:", dup[:3])
        for d in dup[:2]:
            print(f"  --- {d} 对应的观点 ---")
            for o in opinions:
                if o["opinion_id"] == d:
                    print(f"     subject={o['subject']} doc={o['doc_ref']} "
                          f"date={o['stated_date']} pol={o['polarity']}")
                    print(f"     evidence={str(o.get('evidence'))[:60]}")

    eids = {e["opinion_id"] for e in evals}
    missing = eids - oset
    print(f"\n回测结果 {len(evals)} 条，引用 {len(eids)} 个不同 ID，"
          f"其中 {len(missing)} 个不在观点里")
    if missing:
        print("  缺失样例:", list(missing)[:3])

    # 看看是不是 char_start 的问题
    import sqlite3
    from stocktool.config import load_config
    cfg = load_config()
    con = sqlite3.connect(cfg.db_path)
    con.row_factory = sqlite3.Row
    row = con.execute(
        "SELECT COUNT(*) c FROM opinion WHERE char_start IS NULL"
    ).fetchone()
    print(f"\nDB 里 char_start 为 NULL 的观点: {row['c']} 条")
    row = con.execute("SELECT COUNT(*) c FROM opinion WHERE polarity = 0").fetchone()
    print(f"DB 里 polarity=0 的观点: {row['c']} 条")
    row = con.execute(
        "SELECT COUNT(*) c FROM opinion WHERE polarity NOT IN (-1, 1)"
    ).fetchone()
    print(f"DB 里 polarity 非 ±1 的观点: {row['c']} 条")

    # 观点 ID 公式里含 char_start；如果同一 doc 内 (char_start, secid) 重复，
    # 就会产生同一个 ID —— 这是最可能的根因
    from collections import Counter
    keys = Counter((o["doc_ref"], o["subject"].get("secid")) for o in opinions)
    print(f"\n按 (doc_ref, secid) 统计：{len(keys)} 个不同组合，共 {len(opinions)} 条观点")
    dups2 = [(k, v) for k, v in keys.items() if v > 1]
    print(f"同一文档同一标的有多个观点的: {len(dups2)} 组")
    if dups2:
        print("  样例:", dups2[:3])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
