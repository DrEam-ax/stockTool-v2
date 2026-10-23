"""数字化的他 —— 可迁移的决策框架。

和 profiler.py 的区别（这个区别就是产品的分水岭）：

  profiler.py  → "他是谁"：风格标签、命中率、已知偏见。
                 用于**描述**他。
  persona.py   → "遇到没见过的新情况，他会怎么想"：决策规则、判断清单、
                 偏好与厌恶、语言风格。
                 用于**扮演**他。

历史观点在这里只是**训练素材**，不是答案库。
如果 persona 生成得好，那么拿一个他从没提过的新标的问他，
他也能按自己的框架给出自洽的判断 —— 这才是"私人军师"。
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter

from ..textutil import now_iso
from .llm_extractor import _extract_json

PERSONA_PROMPT = """你在为一个大V构建**可迁移的决策框架**（数字化的他）。

目标：让另一个 AI 面对**他从没遇到过的新情况**时，能像他一样思考、取舍、表达。

**关键区别 —— 不要写成历史观点清单：**

✗ 错误：「他看多过锑矿、商业航天、华大智造」← 这是流水账，遇到新标的就没用了
✓ 正确：「政策出现出口管制/禁运时，他优先关注被管制的资源品，因为供需会被人为扭曲」
        ← 这是可迁移的规则，遇到任何新管制品种都能用

严格输出 JSON 对象：

{
  "identity": "一句话说清他是谁、靠什么赚钱",
  "worldview": ["3~6 条投资世界观，是他所有判断的地基"],
  "frameworks": [
    {
      "name": "给这个方法起个**好记的名字**，4~8 字（例：破位二分法、炒业绩vs炒概念、高切低轮动）",
      "content": "一句话说清这个方法是什么（例：高位破位卖，低位破位扛）",
      "how_to_apply": "怎么用它来判断一个具体操作（要让别的 AI 能照着执行）",
      "source_hint": "这个方法大概来自哪类材料（直播/长文/日常帖），不确定就留空",
      "durability": "为什么这个框架不会过期（例：结论会错，但判断高低位的方法不会错）"
    }
  ],
  "decision_rules": [
    {
      "when": "触发条件，要具体到可判断（例：某资源品被列入出口管制）",
      "then": "他会怎么做（例：左侧建仓相关标的，容忍短期浮亏）",
      "because": "他为什么这么想",
      "voice_evidence": "他的原话片段，用来佐证这条规则"
    }
  ],
  "vetoes": ["否决条件 —— 什么情况下他绝不会买，即使其他条件都满足"],
  "preferences": ["他反复偏好的东西（左侧、低估值、政策催化…）"],
  "aversions": ["他反复厌恶/嘲讽的东西（高位追涨、没有叙事的票…）"],
  "valuation_framework": "他怎么判断贵贱（相对比较？市值空间？行业地位？）",
  "timing_framework": "他怎么择时（看什么形态、什么位置、什么信号）",
  "position_sizing": "他的仓位逻辑（什么时候重仓、什么时候小仓位试）",
  "information_sources": ["他做判断时真正依赖的信息（政策文件、行业数据、K线…）"],
  "voice": {
    "tone": "他的语气特征",
    "catchphrases": ["他的口头禅/高频用语 8~15 个"],
    "argument_style": "他讲道理的套路（先立赛道？先比相对强弱？）"
  },
  "checklist": [
    "他面对一个新标的时，会依次问自己的问题 5~8 条，要能直接当检查清单用"
  ]
}

关于 frameworks —— **这是最重要的一节，比 decision_rules 还重要：**

  · 判断标准：**能不能被反复调用**。
    ✓ 「破位二分法：高位破位就卖，低位破位就扛」——遇到任何标的、任何一次
      破位都能拿出来用，而且**具体结论会过期，这个方法不会**。
    ✗ 「看好锑矿」——这是结论，下个月就可能失效。
  · `name` 一定要起得像他会说的那样，好记。有名字的框架才会被反复调用。
  · `how_to_apply` 要让别的 AI 能拿它去**检验一个具体操作**：
    输入「我跌到 X 加仓了」，输出「按破位二分法，这是低位破位 → 该扛 → 做对了」。
  · **至少 4 个 framework。**

硬性要求：
1. **frameworks 至少 4 个**，每个都要有好记的名字和可执行的应用方法。
2. **decision_rules 至少 6 条，必须都是「条件→动作」形式。**
   条件要具体到别的 AI 能拿去比对现实（能判断真假），不要写"当市场情绪好时"这种废话。
3. **vetoes 至少 3 条。** 这决定了他会在什么时候说"不"。
4. **checklist 必须能直接用于评估一个全新标的**，不是描述他过去做了什么。
5. `voice.catchphrases` —— 挑**有辨识度的表达**：他的比喻、判断句、行业黑话
   （例如「上游尖尖」「击球区」「破位二分法」这种一听就知道是他的说法）。
   **绝对不要**收「对不对」「所以说」「我觉得」「这个东西」「什么时候」这类
   对话填充词 —— 直播口述里它们频率最高，但没有任何信息量。
   判断标准：把这句话放到别人嘴里会显得突兀，那才是口头禅。
6. 每条规则尽量带 `voice_evidence`（他的原话），没有就不写这个字段。
7. **不许美化、不许编造。** 材料里没有的不要脑补。
8. 中文。

材料：
---
{data}
---
"""


def render_persona_prompt(data: str) -> str:
    # 同 llm_extractor：提示词含 JSON 示例，绝不能用 str.format()
    return PERSONA_PROMPT.replace("{data}", data)


_STOP = {
    "这个", "那个", "什么", "怎么", "就是", "没有", "可以", "已经", "还是",
    "但是", "因为", "所以", "现在", "时候", "自己", "他们", "我们", "你们",
    "一个", "不会", "不是", "这些", "那些", "如果", "而且", "然后", "这么",
    # ---- 口述语料特有的填充词 ----
    # 直播场景里「对不对」「所以说」「我觉得」这类对话填充词频率极高，
    # 但它们不承载任何观点。如果不排除，模型会把它们当成「口头禅」，
    # 生成出来的军师满嘴废话，反而不像他本人。
    "对不对", "所以说", "我觉得", "就是说", "知道吗", "你看", "你看这",
    "你知道", "这个东西", "那个东西", "什么时候", "是什么", "为什么",
    "我们看", "你看", "这个事", "这种情", "的话", "对吧", "是吧",
    "有没有", "是不是", "能不能", "行不行", "好不好", "对不对",
    "那么", "这样", "那样", "一样", "一直", "真的", "其实", "肯定",
}


def _phrase_stats(texts: list[str], n: int = 4, top: int = 50) -> list[str]:
    """从中文正文里捞高频 n 字短语，作为"口头禅"的线索。

    中文里重复出现的 4 字串通常是有意义的表达（成语式说法、他的固定比喻），
    比让模型凭印象编口头禅可靠。
    """
    counts: Counter[str] = Counter()
    for t in texts:
        for seg in re.sub(r"[^\u4e00-\u9fff]+", " ", t or "").split():
            for i in range(len(seg) - n + 1):
                counts[seg[i:i + n]] += 1
    out = []
    for phrase, c in counts.most_common(top * 3):
        if c < 3 or phrase in _STOP:
            continue
        if any(phrase in kept for kept in out):   # 去包含关系，避免"政策利好"和"政策性利好"
            continue
        out.append(phrase)
        if len(out) >= top:
            break
    return out


def build_persona_material(con: sqlite3.Connection, author_id: int,
                           max_theses: int = 150) -> str:
    lines: list[str] = []

    arow = con.execute(
        "SELECT name, source, platforms, note FROM author WHERE id = ?", (author_id,)
    ).fetchone()
    if arow:
        lines.append("【这个人的身份】")
        lines.append(f"  主名：{arow['name']}（{arow['source']}）")
        try:
            plats = json.loads(arow["platforms"] or "[]")
        except (TypeError, ValueError):
            plats = []
        if plats:
            desc = "；".join(
                f"{p.get('source','?')} 上叫「{p.get('name','?')}」"
                + (f"（{p['note']}）" if p.get("note") else "")
                for p in plats if isinstance(p, dict)
            )
            lines.append(f"  跨平台身份：{desc}")
            lines.append("  注意：粉丝会用这些名字直接称呼他，材料里出现的这些称呼都指他本人。")
        if arow["note"]:
            lines.append(f"  其他事实：{arow['note']}")
        lines.append("")

    prof = con.execute(
        "SELECT summary, methodology, style_tags, known_biases, horizon_bias "
        "FROM author_profile WHERE author_id = ?", (author_id,)
    ).fetchone()
    if prof:
        lines.append("【已有的风格画像】")
        lines.append(f"  概述：{prof['summary']}")
        lines.append(f"  方法：{prof['methodology']}")
        lines.append(f"  周期：{prof['horizon_bias']}")
        lines.append("")

    # ---- 他反复出现的判断依据：按 thesis 归类 ----
    lines.append("【他给出过的理由（thesis），这是提炼规则的主要素材】")
    rows = con.execute("""
        SELECT o.thesis, o.polarity, o.horizon, o.strength, o.triggers,
               COALESCE(i.name, o.subject_raw) AS subj, o.stated_date
        FROM opinion o
        LEFT JOIN instrument i ON i.secid = o.subject_secid
        WHERE o.author_id = ? AND o.thesis IS NOT NULL AND TRIM(o.thesis) != ''
          AND o.is_dup = 0
        ORDER BY o.stated_date DESC LIMIT ?
    """, (author_id, max_theses)).fetchall()
    for r in rows:
        d = "看多" if r["polarity"] > 0 else "看空"
        lines.append(f"  [{r['stated_date']}] {d} {r['subj'] or '?'}"
                     f"（强度{r['strength']}）{r['thesis'][:110]}")
    lines.append("")

    # ---- 触发条件 ----
    trig: Counter[str] = Counter()
    for r in con.execute(
        "SELECT triggers FROM opinion WHERE author_id = ? AND triggers IS NOT NULL"
        " AND triggers NOT IN ('[]','')", (author_id,)
    ):
        try:
            for t in json.loads(r["triggers"]):
                if isinstance(t, str) and 1 < len(t) < 30:
                    trig[t] += 1
        except (TypeError, ValueError):
            pass
    if trig:
        lines.append("【他明确提出的触发条件（triggers），按出现次数排序】")
        lines.append("  " + "、".join(f"{t}({c})" for t, c in trig.most_common(40)))
        lines.append("")

    # ---- 他真正关注的信息 ----
    lines.append("【他高频提及的关键词（反映他真正盯什么）】")
    kws = con.execute("""
        SELECT COALESCE(i.name, o.subject_raw) AS subj, COUNT(*) n
        FROM opinion o LEFT JOIN instrument i ON i.secid = o.subject_secid
        WHERE o.author_id = ? AND o.is_dup = 0
        GROUP BY COALESCE(o.subject_secid, o.subject_raw)
        ORDER BY n DESC LIMIT 25
    """, (author_id,)).fetchall()
    lines.append("  " + "、".join(f"{r['subj']}({r['n']})" for r in kws if r["subj"]))
    lines.append("")

    # ---- 语言风格素材 ----
    texts = [r["text"] for r in con.execute("""
        SELECT t.text FROM doc_text t
        JOIN doc d ON d.id = t.doc_id JOIN author a ON a.id = d.author_id
        WHERE a.id = ?
    """, (author_id,))]
    phrases = _phrase_stats(texts, n=4, top=45)
    if phrases:
        lines.append("【他的高频四字表达（候选口头禅，请从中挑选真实的）】")
        lines.append("  " + "、".join(phrases))
        lines.append("")

    # ---- 原话样本：语气与论证方式 ----
    lines.append("【他的原话样本（判断语气、论证套路用）】")
    samples = con.execute("""
        SELECT o.evidence FROM opinion o
        WHERE o.author_id = ? AND o.is_dup = 0
          AND LENGTH(o.evidence) BETWEEN 30 AND 200
        ORDER BY o.strength DESC, o.stated_date DESC LIMIT 40
    """, (author_id,)).fetchall()
    for r in samples:
        lines.append(f"  · {r['evidence'].replace(chr(10), ' ')[:150]}")
    lines.append("")

    # ---- 他自己的持仓/操作描述（仓位逻辑的来源）----
    lines.append("【他对自己仓位/操作的描述】")
    for kw in ("仓位", "重仓", "加仓", "减仓", "清仓", "建仓", "止盈", "止损"):
        hits = con.execute("""
            SELECT o.evidence FROM opinion o
            WHERE o.author_id = ? AND o.evidence LIKE ? AND o.is_dup = 0
            ORDER BY o.stated_date DESC LIMIT 3
        """, (author_id, f"%{kw}%")).fetchall()
        for h in hits:
            lines.append(f"  [{kw}] {h['evidence'].replace(chr(10),' ')[:130]}")

    return "\n".join(lines)


def generate_persona(con: sqlite3.Connection, cfg, llm, author_id: int) -> dict:
    material = build_persona_material(con, author_id)
    raw = llm._chat_generic(render_persona_prompt(material))
    data = _extract_json(raw)
    if not isinstance(data, dict):
        raise SystemExit("决策框架生成返回的不是 JSON 对象")

    rules = data.get("decision_rules") or []
    if not isinstance(rules, list) or len(rules) < 3:
        raise SystemExit(
            f"决策规则太少（{len(rules) if isinstance(rules, list) else 0} 条），"
            "无法构成可用的框架"
        )

    con.execute(
        "UPDATE author_profile SET persona = ?, generated_by = ?, generated_at = ? "
        "WHERE author_id = ?",
        (json.dumps(data, ensure_ascii=False), llm.id, now_iso(), author_id),
    )
    con.commit()
    return data


def load_persona(con: sqlite3.Connection, author_id: int) -> dict | None:
    row = con.execute(
        "SELECT persona FROM author_profile WHERE author_id = ?", (author_id,)
    ).fetchone()
    if not row or not row["persona"]:
        return None
    try:
        data = json.loads(row["persona"])
        return data if isinstance(data, dict) else None
    except (TypeError, ValueError):
        return None


def persona_to_prompt(persona: dict, name: str) -> str:
    """把决策框架渲染成给 LLM 的角色提示词。

    App 的「军师模式」用这个当 system prompt：
    让他带着自己的框架去面对**实时数据**，而不是复述历史观点。
    """
    if not persona:
        return ""
    L: list[str] = []
    L.append(f"# 你是谁\n你在扮演「{name}」的数字化身，用他的框架思考，而不是复述他说过的话。")
    if persona.get("identity"):
        L.append(f"\n## 你的定位\n{persona['identity']}")

    if persona.get("worldview"):
        L.append("\n## 你的世界观（所有判断的地基）")
        for w in persona["worldview"]:
            L.append(f"- {w}")

    # frameworks 放在 decision_rules 之前：有名字的方法论才是能反复调用的东西，
    # 具体规则只是它在某个场景下的实例。
    if persona.get("frameworks"):
        L.append("\n## 你的核心方法论（**检验操作时优先用这些**）")
        for i, f in enumerate(persona["frameworks"], 1):
            if not isinstance(f, dict):
                continue
            L.append(f"{i}. **{f.get('name','（未命名）')}** —— {f.get('content','')}")
            if f.get("how_to_apply"):
                L.append(f"   怎么用：{f['how_to_apply']}")
            if f.get("durability"):
                L.append(f"   为什么不过期：{f['durability']}")

    if persona.get("decision_rules"):
        L.append("\n## 你的决策规则（遇到情况按这些推演）")
        for i, r in enumerate(persona["decision_rules"], 1):
            if not isinstance(r, dict):
                continue
            L.append(f"{i}. 当「{r.get('when','')}」")
            L.append(f"   → 你会「{r.get('then','')}」")
            if r.get("because"):
                L.append(f"   因为：{r['because']}")

    if persona.get("vetoes"):
        L.append("\n## 你的否决条件（这些情况你会直接说不）")
        for v in persona["vetoes"]:
            L.append(f"- {v}")

    if persona.get("preferences"):
        L.append("\n## 你偏好的\n" + "、".join(persona["preferences"]))
    if persona.get("aversions"):
        L.append("\n## 你厌恶的\n" + "、".join(persona["aversions"]))

    for key, label in (("valuation_framework", "你怎么判断贵贱"),
                       ("timing_framework", "你怎么择时"),
                       ("position_sizing", "你的仓位逻辑")):
        if persona.get(key):
            L.append(f"\n## {label}\n{persona[key]}")

    if persona.get("information_sources"):
        L.append("\n## 你做判断时真正依赖的信息\n"
                 + "、".join(persona["information_sources"]))

    if persona.get("checklist"):
        L.append("\n## 面对一个新标的，你依次问自己")
        for i, c in enumerate(persona["checklist"], 1):
            L.append(f"{i}. {c}")

    v = persona.get("voice") or {}
    if v:
        L.append("\n## 你的说话方式")
        if v.get("tone"):
            L.append(f"- 语气：{v['tone']}")
        if v.get("argument_style"):
            L.append(f"- 论证套路：{v['argument_style']}")
        if v.get("catchphrases"):
            L.append(f"- 你常用的说法：{'、'.join(v['catchphrases'])}")

    L.append(
        "\n# 重要行为约束\n"
        "1. **先查证，再判断。** 涉及行情、政策、新闻时，必须先调用工具获取**当前**数据，"
        "不许凭记忆或训练数据作答。\n"
        "2. **用框架推演，不要类比历史。** 不要说「我以前怎么看X」，"
        "而要说「按我的逻辑，这个情况意味着…」。历史观点只在真的相关时引用。\n"
        "3. **区分事实与判断。** 明确标出哪些是查到的数据、哪些是你的推断。\n"
        "4. **允许说不。** 如果这个标的触发了你的否决条件，直接说你不感兴趣，并说明为什么。\n"
        "5. **不确定就承认。** 数据查不到就说查不到，不要编。\n"
        "6. **可以给方向性建议，但必须标清性质。** 用户问「买哪个板块」「选哪只基金」时，"
        "允许给出具体方向 —— 这正是他的价值。但每条建议要带上："
        "① 用的是哪条方法论或决策规则（说得出名字）；② 什么情况下会失效。"
        "**不要给精确买点、目标价、仓位百分比**，那些取决于用户自己的风险承受能力。\n"
        "7. **联网查证前先征得同意。** 需要当前行情、新闻、政策时，"
        "先用一句话问「我需要查一下最近的行情和新闻，可以吗？」，"
        "用户同意后再调用工具；用户不置可否或拒绝就用框架推演，"
        "并说明缺了哪些数据、结论打多少折扣。\n"
        "8. **涉及基金时，推荐前后都要核对持仓。** 基金名字很不可靠："
        "份额类别不同（A/C）、简称与全称不同、截图识别还可能读错字。"
        "先调用 check_holdings 确认他是否已持有，给出建议后再核对一次。"
        "工具报「疑似已持有」时必须向用户确认，不要自己断言是同一只。\n"
        "9. 用第一人称，保持你的语气。\n"
    )
    return "\n".join(L)
