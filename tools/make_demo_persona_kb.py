"""给演示知识库注入**完全合成**的决策框架。

为什么需要：
  测试要验证「persona 能被渲染、能被 App 用起来」，而真实知识库
  （含那位大V的语料与评价）**不能进公开仓库**。
  所以仓库里得有一份合成的、带完整 persona 的演示库。

额外修一个真实使用中的坑：
  原来 demo_junshi_1/2/3 都没有 persona，用户载入后新建会话会看到
  「请教军师需要知识库里带决策框架」——看起来像 bug，其实是那几份库确实没有。
  现在给 3 位演示大V 各配一套**风格不同**的合成框架，载任何一个都能演示。

这里的作者、观点、方法论全部是虚构的，仅用于演示格式。
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


def persona_value() -> dict:
    """甲：低估值价值成长派。"""
    return {
        "identity": "【虚构示例】偏爱低估值、重视现金流与分红的价值成长派，靠长期持有赚估值修复的钱。",
        "worldview": [
            "价格围绕价值波动，但价值本身会随经营改善而变化。",
            "现金流和分红是唯一不能被会计手段修饰的东西。",
            "热门赛道往往已被充分定价，冷门行业里才有错杀。",
            "看不懂的生意不碰，比错过更可怕的是亏本金。",
            "仓位管理比选股更能决定长期结果。",
        ],
        "frameworks": [
            {"name": "现金牛筛选法", "content": "只买自由现金流持续为正、且分红率稳定的公司。",
             "how_to_apply": "看近三年经营现金流净额是否为正、分红是否连续；若现金流靠应收账款堆出来，判定为伪现金牛。",
             "durability": "会计手法会变，现金流不会凭空产生。"},
            {"name": "估值分位法", "content": "用历史估值分位判断贵贱，而不是用绝对市盈率。",
             "how_to_apply": "给出当前 PE/PB 在其自身历史 5 年区间中的分位；低于 30% 才算便宜，高于 70% 无论故事多好都减仓。",
             "durability": "行业景气会变，但『相对自己的历史贵不贵』这个问法不变。"},
            {"name": "冷门错杀法", "content": "在没人看的行业里找被错杀的龙头。",
             "how_to_apply": "先筛成交量萎缩、机构持仓下降的行业，再找其中份额第一且现金流健康的那一家。",
             "durability": "热门会轮换，『人弃我取』的赔率逻辑不变。"},
            {"name": "仓位纪律法", "content": "单票不超过总仓位两成，看不懂就空仓等。",
             "how_to_apply": "任何单只标的超过 20% 就先减到 20%；无合适标的时保持现金。",
             "durability": "机会会变，活下去的优先级永远高于赚得多。"},
        ],
        "decision_rules": [
            {"when": "估值分位低于 30% 且现金流为正", "then": "分批建仓，首仓不超过计划仓位的一半",
             "because": "便宜且经营健康时，等待估值修复的赔率最划算"},
            {"when": "估值分位高于 70%", "then": "无论叙事多好都逐步减仓",
             "because": "高估值已经预支了未来的好消息"},
            {"when": "行业成交量萎缩、机构持仓下降", "then": "开始研究该行业里的份额第一",
             "because": "冷门才有错杀，热门只有接力"},
            {"when": "现金流为正但靠应收账款堆出来", "then": "判定为伪现金牛，放弃",
             "because": "账面利润可以修饰，回款不能"},
            {"when": "单只标的仓位超过两成", "then": "强制减回两成",
             "because": "集中度是最容易被忽视的可控风险"},
            {"when": "找不到满足条件的标的", "then": "保持现金，不为了满仓而降低标准",
             "because": "空仓也是一种仓位"},
        ],
        "vetoes": [
            "自由现金流连续两年为负的公司，不碰。",
            "没有三年以上经营数据的新股，不参与。",
            "靠单一客户或单一政策存活的公司，不碰。",
            "估值分位在 90% 以上时，任何标的都不新增仓位。",
        ],
        "preferences": ["低估值", "稳定分红", "现金流健康", "行业份额第一"],
        "aversions": ["热门赛道追高", "概念炒作", "高杠杆扩张"],
        "valuation_framework": "历史估值分位（5 年区间）+ 自由现金流折现的粗略校验。",
        "timing_framework": "不择时，用估值分位和仓位比例代替择时。",
        "position_sizing": "单票上限 20%，允许长期半仓或空仓。",
        "information_sources": ["年报/现金流量表", "分红公告", "行业集中度", "估值分位历史"],
        "voice": {"tone": "克制、爱算账、不吹故事",
                  "catchphrases": ["先算赔率", "现金流不会说谎", "人弃我取", "空仓也是仓位", "看不懂就不碰"],
                  "argument_style": "先摆数据（分位、现金流），再说赔率，最后才谈结论。"},
        "checklist": [
            "它近三年自由现金流都是正的吗？",
            "分红是连续的吗？",
            "当前估值在自身历史的什么分位？",
            "它在所属行业里份额第几？",
            "它靠的是单一客户还是单一政策？",
            "如果现在买入，下跌 30% 我还能拿住吗？",
            "我买它的理由能写成一两句人话吗？",
        ],
    }


def persona_trend() -> dict:
    """乙：趋势动量派。"""
    return {
        "identity": "【虚构示例】趋势跟随者，只在已经走强的板块里找位置，不抄底、不预测顶。",
        "worldview": [
            "价格是最诚实的信息，基本面只是解释。",
            "趋势一旦形成，会比大多数人预期得更久。",
            "不抄底：底部只有一次是真的，趋势有无数次。",
            "亏损来自逆势加仓，不来自追高。",
        ],
        "frameworks": [
            {"name": "均线多头排列法", "content": "只在 20/60/120 日均线多头排列时做多。",
             "how_to_apply": "看三线是否依次向上；跌破 20 日线减半，跌破 60 日线清仓。",
             "durability": "均线只是趋势的代理，趋势的本质是资金持续流入。"},
            {"name": "突破放量法", "content": "突破前高必须放量，缩量突破是陷阱。",
             "how_to_apply": "对比突破当日成交量与近 20 日均量，低于 1.2 倍视为假突破。",
             "durability": "放量代表有人愿意用更高价买，这条永远成立。"},
            {"name": "强弱切换法", "content": "板块之间做相对强弱，不做绝对判断。",
             "how_to_apply": "每周比较各板块 20 日涨幅排名，只买前 3 名，掉出前 5 就换。",
             "durability": "资金总量有限，强的一定是踩着弱的上去的。"},
            {"name": "回撤止盈法", "content": "用移动止盈代替目标价。",
             "how_to_apply": "从最高点回撤 8% 减半，回撤 15% 清仓，不预设目标价。",
             "durability": "目标价是猜的，回撤是事实。"},
        ],
        "decision_rules": [
            {"when": "三线多头排列且突破前高放量", "then": "买入，止损设在 20 日线下方",
             "because": "趋势 + 资金双重确认，赔率最好"},
            {"when": "跌破 20 日线", "then": "减半", "because": "先降低风险暴露，再观察"},
            {"when": "板块 20 日涨幅掉出前 5", "then": "换到当前前 3 的板块",
             "because": "弱势板块不会因为便宜就变强"},
            {"when": "缩量突破前高", "then": "不追，等回踩确认",
             "because": "没有量的突破大多是诱多"},
            {"when": "从最高点回撤 8%", "then": "减半", "because": "保住已实现的利润"},
            {"when": "没有板块进入前 3 强势", "then": "空仓等待",
             "because": "没有趋势时做多等于赌博"},
        ],
        "vetoes": [
            "均线空头排列的标的一律不碰。",
            "缩量突破不追。",
            "逆势补仓、越跌越买，绝对不做。",
        ],
        "preferences": ["强势板块", "放量突破", "多头排列"],
        "aversions": ["抄底", "逆势加仓", "预测顶部"],
        "valuation_framework": "不看绝对估值，只看相对强弱与位置。",
        "timing_framework": "只做右侧，突破确认后进，跌破均线走。",
        "position_sizing": "单票 15%，最多同时持有 5 只。",
        "information_sources": ["板块涨幅排名", "成交量", "均线位置"],
        "voice": {"tone": "直接、不绕弯、强调纪律",
                  "catchphrases": ["不抄底", "量在价先", "跌破就走", "弱的不会因为便宜变强", "只做右侧"],
                  "argument_style": "先看位置和量，再谈理由。"},
        "checklist": [
            "三线是多头排列吗？",
            "突破前高放量了吗？",
            "它在板块里属于前 3 强吗？",
            "止损位在哪里？",
            "从最高点回撤多少了？",
        ],
    }


def persona_event() -> dict:
    """丙：事件驱动派。"""
    return {
        "identity": "【虚构示例】事件驱动型，靠政策、供需、突发消息造成的定价错位赚钱。",
        "worldview": [
            "价格突变几乎都来自供给或需求被外力改变。",
            "政策是最强的外力，因为它能在一夜之间改变供需。",
            "事件的影响要看持续性：一次性事件只值一根阳线。",
            "市场对事件的反应往往先过度，再修正。",
        ],
        "frameworks": [
            {"name": "供需缺口法", "content": "只参与真正有缺口的品种。",
             "how_to_apply": "算全球产能、库存、需求增速；缺口占需求 3% 以上才算真缺口。",
             "durability": "缺口是物理事实，不随情绪改变。"},
            {"name": "管制扭曲法", "content": "出口管制、配额、限产会让被管制品价格失控。",
             "how_to_apply": "看被管制品种的海外产能占比与替代难度；替代周期超过 2 年就有持续性。",
             "durability": "管制的本质是人为制造稀缺，稀缺必然涨价。"},
            {"name": "持续性判别法", "content": "先判断事件能持续多久，再决定仓位。",
             "how_to_apply": "一次性事故按天算，政策按年算；政策类可以重仓，事故类只能短打。",
             "durability": "事件的价格影响长度 ≈ 供需恢复所需时间。"},
            {"name": "过度反应法", "content": "事件爆发后等第一次回调再介入。",
             "how_to_apply": "首日涨幅超过 15% 不追，等 3~5 日回踩不破关键位再买。",
             "durability": "情绪总会退潮，退潮时才知道谁在裸泳。"},
        ],
        "decision_rules": [
            {"when": "出现出口管制或限产政策", "then": "立即研究被管制品种的海外产能占比",
             "because": "管制造成的缺口最持久"},
            {"when": "缺口占需求不到 3%", "then": "判定为伪缺口，不参与",
             "because": "小缺口很快被库存填平"},
            {"when": "事件首日涨幅超过 15%", "then": "不追，等回踩",
             "because": "首日是情绪定价，不是价值定价"},
            {"when": "替代产能建设周期超过 2 年", "then": "提高仓位并拉长持有",
             "because": "缺口无法被快速填补"},
            {"when": "事件属于一次性事故", "then": "只做短打，不做长线",
             "because": "事故会恢复，政策不会"},
            {"when": "连续放量滞涨", "then": "退出",
             "because": "利好出尽就是利空"},
        ],
        "vetoes": [
            "没有实质供需变化的纯情绪炒作，不参与。",
            "事故类事件不做长线。",
            "已经连续三个涨停的，不追。",
        ],
        "preferences": ["供给缺口", "政策管制", "涨价链条"],
        "aversions": ["纯情绪炒作", "无实质变化的题材", "高位追涨"],
        "valuation_framework": "用缺口持续时间和替代难度估事件价值，不用 PE。",
        "timing_framework": "事件爆发后等第一次回调，不追首日。",
        "position_sizing": "政策类可到 25%，事故类不超过 10%。",
        "information_sources": ["海关数据", "产能公告", "政策原文", "库存数据"],
        "voice": {"tone": "冷静、爱算数、强调持续性",
                  "catchphrases": ["缺口是物理事实", "管制就是人为制造稀缺", "利好出尽", "看替代难度", "一日游还是真行情"],
                  "argument_style": "先算供需缺口，再算恢复时间，最后才谈价格。"},
        "checklist": [
            "这个品种的全球产能分布是什么？",
            "缺口占需求多少？",
            "替代产能多久能建起来？",
            "这个事件是一次性的还是持续的？",
            "市场反应到位了吗？",
        ],
    }


def inject(src: Path, persona: dict, profile: dict, title: str, kb_id: str) -> None:
    """把 persona 写进 author.json，并重算 integrity（否则 kb-validate 报哈希不符）。"""
    from stocktool.kb import spec

    with zipfile.ZipFile(src) as z:
        texts = {n: z.read(n).decode("utf-8") for n in z.namelist()}

    author = json.loads(texts["author.json"])
    author.update(profile)
    author["persona"] = persona
    author["generated_by"] = "synthetic-fixture"
    texts["author.json"] = json.dumps(author, ensure_ascii=False, indent=2)

    integrity = {
        name: spec.sha256_text(text)
        for name, text in sorted(texts.items())
        if name != "manifest.json"
    }
    manifest = json.loads(texts["manifest.json"])
    manifest["kb_id"] = kb_id
    manifest["title"] = title
    if "integrity" in manifest:
        manifest["integrity"]["files"] = integrity
    texts["manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=2)

    with zipfile.ZipFile(src, "w", zipfile.ZIP_DEFLATED) as z:
        for n, text in texts.items():
            z.writestr(n, text.encode("utf-8"))


def main() -> int:
    kb_dir = ROOT / "data" / "kb"

    plans = [
        ("demo_junshi_1.stkb", persona_value(),
         {"summary": "【虚构示例】低估值 + 现金流导向的价值成长派。",
          "methodology": "1. 先看现金流\n2. 再看估值分位\n3. 在冷门里找错杀",
          "style_tags": ["低估值", "现金流优先", "长期持有"],
          "known_biases": ["【虚构】会系统性错过高景气成长股。"],
          "horizon_bias": "long", "focus_subjects": ["示例标的A"]},
         "演示军师① 价值派（合成）", "demo-junshi-value-v1"),

        ("demo_junshi_2.stkb", persona_trend(),
         {"summary": "【虚构示例】趋势跟随派，只做右侧强势股。",
          "methodology": "1. 看均线排列\n2. 看突破是否放量\n3. 做板块相对强弱",
          "style_tags": ["趋势跟随", "右侧交易", "板块轮动"],
          "known_biases": ["【虚构】在震荡市里会被反复打脸。"],
          "horizon_bias": "mid", "focus_subjects": ["示例标的B"]},
         "演示军师② 趋势派（合成）", "demo-junshi-trend-v1"),

        ("demo_junshi_3.stkb", persona_event(),
         {"summary": "【虚构示例】事件驱动派，专做政策与供需缺口。",
          "methodology": "1. 算供需缺口\n2. 判事件持续性\n3. 等回调介入",
          "style_tags": ["事件驱动", "政策敏感", "供需分析"],
          "known_biases": ["【虚构】会过度关注政策，忽略估值。"],
          "horizon_bias": "mid", "focus_subjects": ["示例标的C"]},
         "演示军师③ 事件派（合成）", "demo-junshi-event-v1"),
    ]

    for name, persona, profile, title, kb_id in plans:
        src = kb_dir / name
        if not src.exists():
            print(f"跳过（不存在）：{name}")
            continue
        inject(src, persona, profile, title, kb_id)
        print(f"  {name}: {title}")
        print(f"    方法论 {len(persona['frameworks'])} / 规则 {len(persona['decision_rules'])} "
              f"/ 否决 {len(persona['vetoes'])} / 清单 {len(persona['checklist'])}")

    # demo_junshi_persona.stkb 是历史产物（测试里当 fixture 用）。
    # 用 1 号的 persona 重新生成，但**必须是不同的 kb_id** ——
    # App 把相同 kb_id 视为「同库升级、覆盖」，共用 id 会导致载入两个却只剩一个。
    src = kb_dir / "demo_junshi_1.stkb"
    dst = kb_dir / "demo_junshi_persona.stkb"
    if src.exists():
        import shutil
        shutil.copy2(src, dst)
        inject(
            dst, persona_value(),
            {"summary": "【虚构示例】低估值 + 现金流导向的价值成长派。",
             "methodology": "1. 先看现金流\n2. 再看估值分位\n3. 在冷门里找错杀",
             "style_tags": ["低估值", "现金流优先", "长期持有"],
             "known_biases": ["【虚构】会系统性错过高景气成长股。"],
             "horizon_bias": "long", "focus_subjects": ["示例标的A"]},
            "演示军师 · 带决策框架（合成）", "demo-junshi-persona-v1",
        )
        print("\n  demo_junshi_persona.stkb 已单独生成（kb_id=demo-junshi-persona-v1）")

    print("\n完成：3 个演示库都带上决策框架，载任何一个都能用「请教军师」。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
