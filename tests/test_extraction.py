"""抽取器与回测规则回归测试。

跑法：python tests/test_extraction.py
不依赖 pytest，只用标准库，避免为了跑测试再装东西。

这里锁定的都是「改词表/改逻辑时最容易悄悄改坏」的行为，
每一条都对应一个真实踩过的坑。
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from stocktool.backtest.evaluate import _entry_index          # noqa: E402
from stocktool.backtest.stats import sign_test_p, wilson_interval  # noqa: E402
from stocktool.extract.lexicon import Lexicon                 # noqa: E402
from stocktool.extract.resolver import SubjectResolver        # noqa: E402
from stocktool.extract.rule_extractor import extract_opinions  # noqa: E402
from stocktool.market.store import upsert_aliases, upsert_instruments  # noqa: E402
from stocktool.models import Instrument                       # noqa: E402

SCHEMA = (ROOT / "src" / "stocktool" / "schema.sql").read_text(encoding="utf-8")
LEXICON = ROOT / "config" / "lexicon.json"

MAOTAI = "1.600519"
BANDAOTI = "1.512480"
BAIJIU = "1.512690"
WANKE = "0.000002"
HANWUJI = "1.688256"
HS300 = "1.000300"

_failures: list[str] = []
_passed = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global _passed
    if condition:
        _passed += 1
        print(f"  PASS  {name}")
    else:
        _failures.append(f"{name} :: {detail}")
        print(f"  FAIL  {name}  {detail}")


def build_env():
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    upsert_instruments(con, [
        Instrument(MAOTAI, "600519", "贵州茅台", "stock", 1, "SH"),
        Instrument(BANDAOTI, "512480", "半导体ETF", "fund", 1, "SH"),
        Instrument(BAIJIU, "512690", "酒ETF", "fund", 1, "SH"),
        Instrument(WANKE, "000002", "万科A", "stock", 0, "SZ"),
        Instrument(HANWUJI, "688256", "寒武纪", "stock", 1, "SH"),
        Instrument(HS300, "000300", "沪深300", "index", 1, "SH"),
    ], "2026-01-01T00:00:00")
    upsert_aliases(con, [
        ("茅台", MAOTAI, 1.0),
        ("白酒", BAIJIU, 1.0),
        ("半导体", BANDAOTI, 1.0),
    ], "manual")
    con.commit()
    lex = Lexicon.load(LEXICON)
    resolver = SubjectResolver.from_db(con, lex.aliases)
    bench = Instrument(HS300, "000300", "沪深300", "index", 1, "SH")
    return con, lex, resolver, bench


def ops_for(ops, secid):
    return [o for o in ops if o.subject_secid == secid]


def main() -> int:
    con, lex, resolver, bench = build_env()

    def extract(text):
        return extract_opinions(text, resolver, lex, benchmark=bench)

    print("\n[1] cashtag 解析")
    ops = extract("$贵州茅台(SH600519)$ 我看好。")
    hit = ops_for(ops, MAOTAI)
    check("cashtag 命中标的", len(hit) == 1, f"ops={[(o.subject_raw, o.polarity) for o in ops]}")
    check("cashtag 方向为看多", bool(hit) and hit[0].polarity == 1)

    print("\n[2] 否定误判：「不错，看好茅台」不能被 '不' 翻转")
    ops = extract("不错，看好茅台。")
    hit = ops_for(ops, MAOTAI)
    check("看好茅台 -> 看多", bool(hit) and hit[0].polarity == 1,
          f"polarity={[o.polarity for o in hit]}")

    print("\n[3] 否定翻转：「半导体没有泡沫」应为看多")
    ops = extract("半导体没有泡沫。")
    hit = ops_for(ops, BANDAOTI)
    check("没有泡沫 -> 看多", bool(hit) and hit[0].polarity == 1,
          f"polarity={[o.polarity for o in hit]}")

    print("\n[4] 多标的就近归属：「白酒我看好，但半导体要小心」")
    ops = extract("白酒我看好，但半导体我觉得要小心。")
    bai = ops_for(ops, BAIJIU)
    ban = ops_for(ops, BANDAOTI)
    check("白酒 -> 看多", bool(bai) and bai[0].polarity == 1,
          f"{[(o.subject_raw, o.polarity) for o in ops]}")
    check("半导体 -> 看空", bool(ban) and ban[0].polarity == -1,
          f"{[(o.subject_raw, o.polarity) for o in ops]}")

    print("\n[5] 让步从句：「虽然估值不便宜，但产业趋势足够强」不能判成看空")
    ops = extract("$寒武纪(SH688256)$ 虽然估值不便宜，但产业趋势足够强。")
    neg = [o for o in ops_for(ops, HANWUJI) if o.polarity == -1]
    check("让步从句不产生看空", not neg,
          f"{[(o.subject_raw, o.polarity) for o in ops]}")

    print("\n[6] 主语跨句继承：「…$寒武纪$…。我坚定看好，长线持有。」")
    ops = extract(
        "$寒武纪(SH688256)$ 虽然估值不便宜，但产业趋势足够强。我坚定看好，长线持有。"
    )
    hit = [o for o in ops_for(ops, HANWUJI) if o.polarity == 1]
    check("继承到寒武纪的看多观点", len(hit) == 1,
          f"{[(o.subject_raw, o.polarity, o.subject_secid) for o in ops]}")
    if hit:
        check("强度=5（坚定看好）", hit[0].strength == 5, f"strength={hit[0].strength}")
        check("周期=long（长线）", hit[0].horizon == "long", f"horizon={hit[0].horizon}")
        check("继承观点置信度被打折", hit[0].confidence < 0.95,
              f"confidence={hit[0].confidence}")

    print("\n[7] 条件从句：「除非政策有超预期的力度，否则我暂时不碰」不能判成看多")
    ops = extract(
        "$万科A(SZ000002)$ 的销售数据依然在恶化，行业没有看到真正的拐点。"
        "除非政策有超预期的力度，否则我暂时不碰。"
    )
    wan = ops_for(ops, WANKE)
    pos = [o for o in wan if o.polarity == 1]
    neg = [o for o in wan if o.polarity == -1]
    check("条件从句不产生看多", not pos,
          f"{[(o.sentence[:16], o.polarity) for o in wan]}")
    check("主句仍产生看空", bool(neg), f"{[(o.sentence[:16], o.polarity) for o in wan]}")
    check("触发条件被记录到 triggers",
          any("除非" in t for o in wan for t in o.triggers),
          f"triggers={[o.triggers for o in wan]}")

    print("\n[8] 大盘观点回落到基准指数")
    ops = extract("大盘我说一下看法：我认为后市是向上的。")
    check("后市向上 -> 沪深300 看多",
          bool(ops_for(ops, HS300)) and ops_for(ops, HS300)[0].polarity == 1,
          f"{[(o.subject_raw, o.polarity) for o in ops]}")

    print("\n[9] 回测入场规则：严禁前视偏差")

    class Cfg:
        def __init__(self, rule):
            self.values = {"entry_rule": rule, "close_hour": 15}

    cal = ["2024-03-01", "2024-03-04", "2024-03-05", "2024-03-06", "2024-03-07"]
    idx = _entry_index(cal, "2024-03-05", "2024-03-05T21:30:00", Cfg("next_close"))
    check("盘后发布 -> 次一交易日入场", cal[idx] == "2024-03-06", f"got {cal[idx]}")
    idx = _entry_index(cal, "2024-03-05", "2024-03-05T09:30:00", Cfg("next_close"))
    check("next_close 规则下盘中发布也次日入场", cal[idx] == "2024-03-06", f"got {cal[idx]}")
    idx = _entry_index(cal, "2024-03-05", "2024-03-05T09:30:00",
                       Cfg("same_day_if_before_close"))
    check("same_day 规则下盘中发布当日收盘入场", cal[idx] == "2024-03-05", f"got {cal[idx]}")
    idx = _entry_index(cal, "2024-03-05", "2024-03-05T21:30:00",
                       Cfg("same_day_if_before_close"))
    check("same_day 规则下盘后发布仍次日入场", cal[idx] == "2024-03-06", f"got {cal[idx]}")
    idx = _entry_index(cal, "2024-03-02", "2024-03-02T10:00:00", Cfg("next_close"))
    check("非交易日发布 -> 下一交易日", cal[idx] == "2024-03-04", f"got {cal[idx]}")

    print("\n[10] 统计工具：小样本必须被识别为不显著")
    lo, hi = wilson_interval(3, 3)
    check("3/3 的 Wilson 下界远低于 100%", lo < 0.45, f"lo={lo:.3f}")
    lo2, _ = wilson_interval(300, 300)
    check("300/300 的 Wilson 下界足够高", lo2 > 0.95, f"lo={lo2:.3f}")
    check("10/10 的符号检验显著", sign_test_p(10, 10) < 0.01,
          f"p={sign_test_p(10, 10):.4f}")
    check("5/10 的符号检验不显著", sign_test_p(5, 10) > 0.9,
          f"p={sign_test_p(5, 10):.4f}")

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
