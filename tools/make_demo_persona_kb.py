"""给演示知识库注入一个**完全合成**的决策框架，让仓库自洽。

为什么需要：
  测试要验证「persona 能被渲染、能被 App 用起来」，而真实知识库
  （含那位大V的语料与评价）**不能进公开仓库**。
  所以仓库里得有一份合成的、带完整 persona 的演示库：
     · 测试拿它当 fixture，clone 下来就能跑
     · 用户拿它试「军师 / 检验」模式，不涉及任何真实人物

这里的作者、观点、方法论全部是虚构的，仅用于演示格式。
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

# 一个虚构的"价值成长派"军师，故意和真实人物风格不同，避免被误认
DEMO_PERSONA = {
    "identity": "【虚构示例】一个偏爱低估值、重视现金流与分红的价值成长派，靠长期持有赚估值修复的钱。",
    "worldview": [
        "价格围绕价值波动，但价值本身会随经营改善而变化。",
        "现金流和分红是唯一不能被会计手段修饰的东西。",
        "热门赛道往往已被充分定价，冷门行业里才有错杀。",
        "看不懂的生意不碰，比错过更可怕的是亏本金。",
        "仓位管理比选股更能决定长期结果。",
    ],
    "frameworks": [
        {
            "name": "现金牛筛选法",
            "content": "只买自由现金流持续为正、且分红率稳定的公司。",
            "how_to_apply": "看近三年经营现金流净额是否为正、分红是否连续；"
            "若现金流靠应收账款堆出来，判定为伪现金牛。",
            "durability": "会计手法会变，现金流不会凭空产生。",
        },
        {
            "name": "估值分位法",
            "content": "用历史估值分位判断贵贱，而不是用绝对市盈率。",
            "how_to_apply": "给出当前 PE/PB 在其自身历史 5 年区间中的分位；"
            "分位低于 30% 才算便宜，高于 70% 无论故事多好都减仓。",
            "durability": "行业景气会变，但『相对自己的历史贵不贵』这个问法不变。",
        },
        {
            "name": "冷门错杀法",
            "content": "在没人看的行业里找被错杀的龙头，而不是在热门里找便宜。",
            "how_to_apply": "先筛出成交量萎缩、机构持仓下降的行业，"
            "再在其中找份额第一且现金流健康的那一家。",
            "durability": "热门会轮换，『人弃我取』的赔率逻辑不变。",
        },
        {
            "name": "仓位纪律法",
            "content": "单票不超过总仓位的两成，看不懂就空仓等。",
            "how_to_apply": "任何单只标的超过 20% 就先减到 20%；"
            "无合适标的时保持现金，不为了满仓而买。",
            "durability": "机会会变，活下去的优先级永远高于赚得多。",
        },
    ],
    "decision_rules": [
        {
            "when": "某标的历史估值分位低于 30% 且现金流为正",
            "then": "分批建仓，首仓不超过计划仓位的一半",
            "because": "便宜且经营健康时，等待估值修复的赔率最划算",
        },
        {
            "when": "某标的估值分位高于 70%",
            "then": "无论叙事多好都逐步减仓",
            "because": "高估值已经预支了未来的好消息",
        },
        {
            "when": "行业成交量萎缩、机构持仓连续下降",
            "then": "开始研究该行业里的份额第一",
            "because": "冷门才有错杀，热门只有接力",
        },
        {
            "when": "某标的现金流为正但靠应收账款堆出来",
            "then": "判定为伪现金牛，放弃",
            "because": "账面利润可以修饰，回款不能",
        },
        {
            "when": "单只标的仓位超过总仓位的 20%",
            "then": "强制减回 20%",
            "because": "集中度是可控风险里最容易被忽视的一个",
        },
        {
            "when": "找不到满足条件的标的",
            "then": "保持现金，不为了满仓而降低标准",
            "because": "空仓也是一种仓位",
        },
    ],
    "vetoes": [
        "自由现金流连续两年为负的公司，无论故事多好听都不碰。",
        "没有三年以上经营数据的新股，不参与。",
        "靠单一客户或单一政策存活的公司，不碰。",
        "估值分位在 90% 以上时，任何标的都不新增仓位。",
    ],
    "preferences": ["低估值", "稳定分红", "现金流健康", "行业份额第一", "冷门错杀"],
    "aversions": ["热门赛道追高", "概念炒作", "高杠杆扩张", "看不懂的商业模式"],
    "valuation_framework": "历史估值分位（5 年区间）+ 自由现金流折现的粗略校验；"
    "不用绝对 PE 判断贵贱，因为不同行业的中枢差异太大。",
    "timing_framework": "不择时，但用估值分位和仓位比例代替择时；"
    "分位低就多买一点，分位高就少拿一点。",
    "position_sizing": "单票上限 20%，总仓位随机会多少浮动，允许长期半仓或空仓。",
    "information_sources": ["年报/现金流量表", "分红公告", "行业集中度数据", "估值分位历史"],
    "voice": {
        "tone": "克制、爱算账、不吹故事，常用『赔率』『分位』这类词。",
        "catchphrases": ["先算赔率", "现金流不会说谎", "人弃我取", "空仓也是仓位", "看不懂就不碰"],
        "argument_style": "先摆数据（分位、现金流），再说赔率，最后才谈结论。",
    },
    "checklist": [
        "它近三年自由现金流都是正的吗？",
        "分红是连续的吗，还是偶尔一次？",
        "当前估值在自身历史的什么分位？",
        "它在所属行业里份额第几？",
        "它靠的是单一客户还是单一政策？",
        "如果现在买入，下跌 30% 我还能拿住吗？",
        "我买它的理由能写成一两句人话吗？",
    ],
}

DEMO_PROFILE = {
    "summary": "【虚构示例】低估值 + 现金流导向的价值成长派，偏好冷门行业里的份额第一。",
    "methodology": "1. 先看现金流，再看估值分位\n2. 在冷门里找错杀\n3. 用仓位纪律替代择时",
    "style_tags": ["低估值", "现金流优先", "长期持有", "拒绝追热点"],
    "known_biases": [
        "【虚构】会系统性错过高景气成长股的机会。",
        "【虚构】在牛市后期往往因为『太贵』而过早减仓。",
    ],
    "horizon_bias": "long",
    "focus_subjects": ["示例标的A", "示例标的B"],
}


def main() -> int:
    from stocktool.kb import spec

    src = ROOT / "data" / "kb" / "demo_junshi_1.stkb"
    out = ROOT / "data" / "kb" / "demo_junshi_persona.stkb"
    if not src.exists():
        print(f"缺少源文件：{src}")
        return 1

    # 全程按**文本**处理：integrity 是对文本字节算的 sha256，
    # 中途用 bytes 再转回去容易因为换行/编码差异对不上。
    with zipfile.ZipFile(src) as z:
        texts = {
            n: z.read(n).decode("utf-8")
            for n in z.namelist()
        }

    author = json.loads(texts["author.json"])
    author.update(DEMO_PROFILE)
    author["persona"] = DEMO_PERSONA
    author["generated_by"] = "synthetic-fixture"
    texts["author.json"] = json.dumps(author, ensure_ascii=False, indent=2)

    # 内容变了，必须重算完整性哈希，否则 kb-validate 会报「文件被改动过」。
    # 注意 integrity 不包含 manifest.json 自己（导出器就是这么算的）。
    integrity = {
        name: spec.sha256_text(text)
        for name, text in sorted(texts.items())
        if name != "manifest.json"
    }

    manifest = json.loads(texts["manifest.json"])
    manifest["kb_id"] = "demo-junshi-persona-v1"
    manifest["title"] = "演示军师 · 带决策框架（合成语料）"
    if "integrity" in manifest:
        manifest["integrity"]["files"] = integrity
    texts["manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=2)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for n, text in texts.items():
            z.writestr(n, text.encode("utf-8"))

    print(f"已生成：{out}  ({out.stat().st_size / 1024:.1f} KB)")
    print(f"  作者：{author['name']}（合成）")
    print(f"  方法论 {len(DEMO_PERSONA['frameworks'])} 个 / 规则 {len(DEMO_PERSONA['decision_rules'])} 条 / "
          f"否决 {len(DEMO_PERSONA['vetoes'])} 条 / 清单 {len(DEMO_PERSONA['checklist'])} 步")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
