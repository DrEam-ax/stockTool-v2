"""核查：雪球时间线里的每一条，作者真的是目标用户吗？

如果 user_timeline 混合了「提到他的帖子」或「别人的帖子」，
整个语料库的身份归属就是错的 —— 这是最严重的一类错误，
因为它不会报错，只会让所有分析结果悄悄跑偏。
"""

import os

# 要分析的大V名字。默认是占位符；用法：
#     $env:STOCKTOOL_AUTHOR = "某大V"
AUTHOR = os.environ.get("STOCKTOOL_AUTHOR", "示例大V")

import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# 目标 UID。默认占位符；用法：$env:STOCKTOOL_UID = "1234567890"
TARGET = os.environ.get("STOCKTOOL_UID", "0000000000")
DUMP = ROOT / "data" / "raw" / "xueqiu" / f"xueqiu_{TARGET}_p1-117.json"


def main() -> int:
    data = json.loads(DUMP.read_text(encoding="utf-8"))
    statuses = data["statuses"]
    print(f"总条数: {len(statuses)}")

    authors = Counter()
    mismatched = []
    for s in statuses:
        u = s.get("user") or {}
        uid = str(u.get("id") or "")
        authors[(uid, u.get("screen_name"))] += 1
        if uid != TARGET:
            mismatched.append(s)

    print("\n外层帖子的作者分布:")
    for (uid, name), c in authors.most_common(10):
        mark = "  <== 目标" if uid == TARGET else "  <== !!! 不是目标用户"
        print(f"  {uid:14} {name!s:16} {c:5}{mark}")

    print(f"\n作者不是目标用户的条目: {len(mismatched)}")

    if mismatched:
        print("\n=== 那些条目的样例 ===")
        for s in mismatched[:5]:
            u = s.get("user") or {}
            print(f"--- id={s.get('id')} 作者={u.get('screen_name')}({u.get('id')})")
            txt = (s.get("text") or s.get("description") or "")[:200]
            print(f"    {txt}")

    # 再看 retweeted_status 的作者分布
    rt_authors = Counter()
    for s in statuses:
        rt = s.get("retweeted_status")
        if not rt:
            continue
        u = rt.get("user") or {}
        rt_authors[(str(u.get("id") or ""), u.get("screen_name"))] += 1
    print(f"\n被转发内容的作者分布（前 10，共 {sum(rt_authors.values())} 条转发）:")
    for (uid, name), c in rt_authors.most_common(10):
        mark = "  <== 他本人" if uid == TARGET else ""
        print(f"  {uid:14} {name!s:16} {c:5}{mark}")

    # 关键：有多少条是他自己原创/自转，多少条是转发别人的
    own = sum(1 for s in statuses if str((s.get("user") or {}).get("id")) == TARGET)
    print(f"\n结论: {own}/{len(statuses)} 条的作者是目标用户")
    return 0 if own == len(statuses) else 2


if __name__ == "__main__":
    raise SystemExit(main())
