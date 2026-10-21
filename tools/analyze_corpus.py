"""语料体检：看看抓下来的东西到底是什么成色。"""

import os

# 要分析的大V名字。默认是占位符；用法：
#     $env:STOCKTOOL_AUTHOR = "某大V"
AUTHOR = os.environ.get("STOCKTOOL_AUTHOR", "示例大V")

import re
import statistics
import sys
from collections import Counter
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
        SELECT d.id, d.published_date, d.kind, d.title,
               t.text, t.char_len, d.raw_meta
        FROM doc d
        JOIN doc_text t ON t.doc_id = d.id
        JOIN author a ON a.id = d.author_id
        WHERE a.name = {AUTHOR}
        ORDER BY d.published_date
        """
    ).fetchall()
    n = len(rows)
    if not n:
        print("没有数据")
        return 1

    print(f"总篇数: {n}")
    print(f"时间范围: {rows[0]['published_date']} ~ {rows[-1]['published_date']}")
    lens = [r["char_len"] for r in rows]
    print(
        f"正文字数: 最短 {min(lens)}  中位 {int(statistics.median(lens))}  "
        f"平均 {int(statistics.mean(lens))}  最长 {max(lens)}"
    )

    print("\nkind 分布:")
    for k, c in Counter(r["kind"] for r in rows).most_common():
        print(f"  {k:10} {c:5}  ({c / n * 100:.1f}%)")

    print("\n按年:")
    for y, c in sorted(Counter(r["published_date"][:4] for r in rows).items()):
        print(f"  {y}: {c:5}  " + "#" * (c // 15))

    print("\n按月分布:")
    mc = Counter(r["published_date"][:7] for r in rows)
    for m, c in sorted(mc.items()):
        print(f"  {m}: {c:4}  " + "#" * (c // 3))

    # 标的标注情况 —— 这直接决定抽取器能抓到多少
    tk = re.compile(r"\$([^$()\n]{1,20}?)(?:\((?:SH|SZ|BJ)?(\d{6})\))?\$")
    bare = re.compile(r"(?<!\d)(\d{6})(?!\d)")
    n_cash = sum(1 for r in rows if tk.search(r["text"]))
    n_bare = sum(1 for r in rows if not tk.search(r["text"]) and bare.search(r["text"]))
    print("\n标的标注情况（决定能抽多少观点）:")
    print(f"  含雪球 cashtag: {n_cash:5}  ({n_cash / n * 100:.1f}%)")
    print(f"  含裸 6 位代码:  {n_bare:5}  ({n_bare / n * 100:.1f}%)")
    print(f"  两者都没有:     {n - n_cash - n_bare:5}  ({(n - n_cash - n_bare) / n * 100:.1f}%)")

    # 方向词覆盖 —— 决定规则抽取器的召回上限
    lex_path = ROOT / "config" / "lexicon.json"
    import json

    lex = json.loads(lex_path.read_text(encoding="utf-8"))
    words = []
    for direction in ("bullish", "bearish"):
        for tier_words in (lex.get("polarity", {}).get(direction, {}) or {}).values():
            words.extend(tier_words)
    n_dir = sum(1 for r in rows if any(w in r["text"] for w in words))
    print(f"\n含方向词的帖子: {n_dir}  ({n_dir / n * 100:.1f}%)")

    print("\n=== 最长的 2 篇 ===")
    for r in sorted(rows, key=lambda x: -x["char_len"])[:2]:
        print(f"--- {r['published_date']} len={r['char_len']} kind={r['kind']}")
        print("   ", r["text"][:320].replace("\n", " | "))

    print("\n=== 最短的 2 篇 ===")
    for r in sorted(rows, key=lambda x: x["char_len"])[:2]:
        print(f"--- {r['published_date']} len={r['char_len']}")
        print("   ", r["text"][:120].replace("\n", " | "))

    print("\n=== cashtag 出现频次 Top 15 ===")
    codes = Counter()
    for r in rows:
        for m in tk.finditer(r["text"]):
            if m.group(2):
                codes[m.group(2)] += 1
    if codes:
        name_map = {
            row["code"]: row["name"]
            for row in con.execute("SELECT code, name FROM instrument")
        }
        for code, c in codes.most_common(15):
            print(f"  {code}  {name_map.get(code, '?'):12} {c} 次")
    else:
        print("  没有带代码的 cashtag")

    print("\n=== LLM key 状态 ===")
    print(f"  has_llm: {cfg.has_llm}")
    print(f"  api_key: {'None' if not cfg.api_key else f'已配置（长度 {len(cfg.api_key)}）'}")
    print(f"  模型: {cfg.values.get('llm_model')} @ {cfg.values.get('llm_base_url')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
