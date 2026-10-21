"""验证：决策框架能不能用于**他从没遇到过的新情况**。

这是"私人军师"和"史料检索"的分水岭：
  史料检索 → "他以前怎么看X" —— 新标的一问三不知
  决策框架 → "以他的逻辑，面对Y他会怎么想" —— 新标的也能推演

做法：先确认某个话题在语料里**确实没出现过**，
再拿它问数字化的他，看输出的推理是否符合他的框架。
"""

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
from stocktool.extract.llm_extractor import LLMExtractor  # noqa: E402
from stocktool.extract.persona import load_persona, persona_to_prompt  # noqa: E402
from stocktool.extract.resolver import SubjectResolver  # noqa: E402
from stocktool.lexicon import load_lexicon  # noqa: E402

# 挑几个他语料里大概率没有的新情况
PROBES = [
    ("高纯石英砂", "商务部把高纯石英砂列入出口管制清单，这个方向你怎么看？"),
    ("核聚变", "国内新批了一个可控核聚变示范堆项目，这个题材值得埋伏吗？"),
    ("低空经济", "现在低空经济很火，eVTOL 适航证陆续发放，你会参与吗？"),
]


def main() -> int:
    cfg = load_config()
    con = connect(cfg)
    lex = load_lexicon(cfg)
    resolver = SubjectResolver.from_db(con, lex.aliases)
    llm = LLMExtractor(cfg, resolver, lex)
    if not llm.available():
        print("需要 LLM API key")
        return 1

    aid = con.execute("SELECT id, name FROM author WHERE name = {AUTHOR}").fetchone()
    persona = load_persona(con, int(aid["id"]))
    if not persona:
        print("还没有决策框架，先跑 profile-author")
        return 1

    system = persona_to_prompt(persona, aid["name"])
    print("=" * 78)
    print(f"角色提示词长度：{len(system)} 字符")
    print("=" * 78)
    print(system[:600])
    print("  …（略）")
    print()

    for keyword, question in PROBES:
        # 先查语料里到底有没有提过
        n = con.execute("""f"""
            SELECT COUNT(*) c FROM doc_text t
            JOIN doc d ON d.id = t.doc_id JOIN author a ON a.id = d.author_id
            WHERE a.name = {AUTHOR} AND t.text LIKE ?
        """, (f"%{keyword}%",)).fetchone()["c"]
        n_op = con.execute("""f"""
            SELECT COUNT(*) c FROM opinion o JOIN author a ON a.id = o.author_id
            WHERE a.name = {AUTHOR} AND (o.evidence LIKE ? OR o.thesis LIKE ?
              OR o.subject_raw LIKE ?)
        """, (f"%{keyword}%",) * 3).fetchone()["c"]

        print("=" * 78)
        print(f"【新情况】{keyword}　语料中出现：原文 {n} 篇 / 相关观点 {n_op} 条")
        print(f"【提问】{question}")
        print("=" * 78)

        answer = llm.chat_text(
            system + "\n\n# 现在有人问你\n" + question +
            "\n\n（注意：现在没有联网工具，如果涉及你不知道的当前数据，"
            "请明确说明「这需要查证」，然后**仅基于你的框架**给出你会怎么想。）"
        )
        print(answer)
        print()

    u = llm.usage
    print(f"LLM 用量：{u['calls']} 次，{u['total_tokens']} tokens")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
