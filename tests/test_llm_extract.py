"""LLM 抽取器的可离线测试部分。

跑法：python tests/test_llm_extract.py

不打真实 API —— 只验证不依赖网络的关键逻辑：
  · 响应解析（含 json_object / 裸数组 / 代码围栏 三种形态）
  · 提示词与 response_format 必须一致（这里曾经有个会直接报错的 bug）
  · 规则与 LLM 结果的合并策略（LLM 优先）
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from stocktool.extract.llm_extractor import PROMPT, _extract_json, render_prompt  # noqa: E402
from stocktool.extract.runner import _merge                      # noqa: E402
from stocktool.models import Opinion                             # noqa: E402

_failures: list[str] = []
_passed = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global _passed
    if cond:
        _passed += 1
        print(f"  PASS  {name}")
    else:
        _failures.append(f"{name} :: {detail}")
        print(f"  FAIL  {name}  {detail}")


def mkop(polarity, secid, start=0, conf=0.8, extractor="rule@1"):
    return Opinion(
        sentence="s", char_start=start, char_end=start + 10,
        subject_raw="x", subject_secid=secid, subject_type="stock",
        resolved=True, match_conf=0.9, polarity=polarity, strength=3,
        horizon="unspecified", thesis="t", triggers=[], evidence="s",
        extractor=extractor, confidence=conf,
    )


def main() -> int:
    print("\n[1] 提示词与 response_format 必须一致")
    check("提示词要求返回 JSON 对象（含 \"opinions\"）",
          '"opinions"' in PROMPT, PROMPT[:60])
    check("提示词明确说明要对象而非数组",
          "严格输出 JSON 对象" in PROMPT, "提示词没说清楚要对象")
    check("提示词含口语化判读指引（拒绝下跌 etc）",
          "拒绝下跌" in PROMPT and "不像" in PROMPT)

    # 这个坑真的踩过：提示词里的 JSON 示例会让 str.format() 抛
    # KeyError: '"opinions"'，20 篇语料全军覆没
    rendered = render_prompt("测试正文XYZ")
    check("占位符替换成功且不抛异常", "测试正文XYZ" in rendered)
    check("替换后不再残留 {text} 占位符", "{text}" not in rendered)
    check("JSON 示例被原样保留",
          '{"opinions"' in rendered and "一条都没有就返回" in rendered)
    try:
        PROMPT.format(text="x")
        check("（记录）format 会炸 —— 所以不能用它", False,
              "format 居然没炸，行为已变化，需重新评估")
    except KeyError:
        check("已确认 str.format() 会因 JSON 示例而失败（故改用 replace）", True)

    print("\n[2] 响应解析")
    check("标准对象形态",
          _extract_json('{"opinions": [{"polarity": 1}]}')["opinions"][0]["polarity"] == 1)
    check("带 ```json 代码围栏",
          _extract_json('```json\n{"opinions": []}\n```')["opinions"] == [])
    check("模型不听话返回裸数组也能解析（降级路径）",
          isinstance(_extract_json('[{"polarity": -1}]'), list))
    check("前后有寒暄文字也能抠出 JSON",
          _extract_json('好的，结果如下：\n{"opinions": [{"a":1}]}\n以上。')["opinions"][0]["a"] == 1)
    try:
        _extract_json("完全没有 JSON")
        check("纯文本应抛错", False, "居然没抛")
    except json.JSONDecodeError:
        check("纯文本应抛错", True)

    print("\n[3] 规则与 LLM 合并：LLM 优先")
    rule = [mkop(1, "1.600519", start=0, conf=0.95, extractor="rule@1")]
    llm = [mkop(-1, "1.600519", start=0, conf=0.60, extractor="llm:test")]
    merged = _merge(rule, llm)
    check("同位置同标的只留一条", len(merged) == 1, f"got {len(merged)}")
    check("冲突时用 LLM 的结果（方向以 LLM 为准）",
          merged[0].polarity == -1 and merged[0].extractor == "llm:test",
          f"polarity={merged[0].polarity} extractor={merged[0].extractor}")

    rule = [mkop(1, "1.600519", start=0), mkop(-1, "1.512480", start=50)]
    llm = [mkop(1, "1.512800", start=120)]
    merged = _merge(rule, llm)
    check("键不同则两边都保留", len(merged) == 3, f"got {len(merged)}")
    check("合并结果按位置排序",
          [o.char_start for o in merged] == sorted(o.char_start for o in merged))

    print("\n[4] LLM 不可用时必须明确拒绝")
    from stocktool.extract.runner import run_extraction
    import sqlite3

    class FakeLLM:
        def available(self):
            return False

    try:
        run_extraction(sqlite3.connect(":memory:"), None, None, None,
                       extractor="llm", llm=FakeLLM())
        check("无 API key 时 llm 模式应中止", False, "居然没中止")
    except SystemExit:
        check("无 API key 时 llm 模式应中止", True)
    except Exception as exc:  # noqa: BLE001
        check("无 API key 时 llm 模式应中止", False, f"抛了别的异常 {exc}")

    print("\n" + "=" * 60)
    if _failures:
        print(f"失败 {len(_failures)} 项 / 通过 {_passed} 项")
        for f in _failures:
            print(f"  - {f}")
        return 1
    print(f"全部通过（{_passed} 项断言）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
