"""标的归一化：把文本里的写法解析成可回测的标的。

两条铁律
  1. 精度优先于召回。错误归属标的会直接污染回测，比漏掉更糟。
  2. 用 secid 做标识。6 位代码会跨市场撞车（000001 = 平安银行 / 上证指数）。
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass

from ..matching import longest_match_scan
from ..models import SUBJECT_PRIORITY, Instrument, SubjectMatch

# 雪球 cashtag：$贵州茅台(SH600519)$ / $贵州茅台(600519)$ / $贵州茅台$
CASHTAG = re.compile(r"\$([^$()\n]{1,20}?)(?:\((SH|SZ|BJ)?(\d{6})\))?\$")
BARE_CODE = re.compile(r"(?<!\d)(\d{6})(?!\d)")

_PRIORITY_RANK = {t: i for i, t in enumerate(SUBJECT_PRIORITY)}
_MARKET_PREFIX = {"SH": 1, "SZ": 0, "BJ": 0}


@dataclass
class ResolveStats:
    cashtag: int = 0
    bare_code: int = 0
    name: int = 0
    alias: int = 0
    ambiguous: int = 0
    miss: int = 0


class SubjectResolver:
    def __init__(self, by_name: dict[str, list[Instrument]],
                 by_alias: dict[str, list[tuple[Instrument, float]]],
                 aliases_meta: dict[str, str] | None = None):
        self.by_name = by_name
        self.by_alias = by_alias
        self.by_secid: dict[str, Instrument] = {}
        self.by_code: dict[str, list[Instrument]] = {}
        for insts in by_name.values():
            for inst in insts:
                self.by_secid.setdefault(inst.secid, inst)
                self.by_code.setdefault(inst.code, []).append(inst)

        # 合并成一张最长匹配表：term -> [(Instrument, weight, kind)]
        self.table: dict[str, list[tuple[Instrument, float, str]]] = {}
        for name, insts in by_name.items():
            if len(name) < 2:
                continue
            for inst in insts:
                self.table.setdefault(name, []).append((inst, 1.0, "name"))
        for alias, pairs in by_alias.items():
            if len(alias) < 2:
                continue
            for inst, weight in pairs:
                self.table.setdefault(alias, []).append((inst, weight, "alias"))

        self.max_len = max((len(k) for k in self.table), default=2)
        self.stats = ResolveStats()
        self._aliases_meta = aliases_meta or {}

    # ---------- 从库里构建 ----------
    @classmethod
    def from_db(cls, con: sqlite3.Connection,
                aliases_meta: dict[str, str] | None = None) -> "SubjectResolver":
        by_name: dict[str, list[Instrument]] = {}
        by_secid: dict[str, Instrument] = {}
        for row in con.execute(
            "SELECT secid, code, name, type, market, exchange FROM instrument"
        ):
            inst = Instrument(row["secid"], row["code"], row["name"],
                              row["type"], row["market"], row["exchange"])
            by_name.setdefault(inst.name, []).append(inst)
            by_secid[inst.secid] = inst

        by_alias: dict[str, list[tuple[Instrument, float]]] = {}
        for row in con.execute("SELECT alias, secid, weight FROM alias"):
            inst = by_secid.get(row["secid"])
            if inst is not None:
                by_alias.setdefault(row["alias"], []).append(
                    (inst, float(row["weight"]))
                )
        return cls(by_name, by_alias, aliases_meta)

    # ---------- 主入口 ----------
    def resolve(self, text: str) -> list[SubjectMatch]:
        matches: list[SubjectMatch] = []
        mask = [False] * len(text)

        # 1) cashtag 最可信，优先并占位
        for m in CASHTAG.finditer(text):
            raw = (m.group(1) or "").strip()
            code = m.group(3)
            prefix = m.group(2)
            inst = self._by_cashtag(code, prefix)
            if inst is None and raw:
                inst = self._pick(self.table.get(raw))
            if inst is None:
                self.stats.miss += 1
                matches.append(SubjectMatch(raw or m.group(0), None, "unresolved",
                                            m.start(), m.end(), 0.0))
                continue
            self.stats.cashtag += 1
            matches.append(SubjectMatch(raw or inst.name, inst.secid, inst.type,
                                        m.start(), m.end(), 1.0))
            for i in range(m.start(), m.end()):
                mask[i] = True

        # 2) 裸 6 位代码（必须能唯一命中标的，否则当普通数字忽略）
        for m in BARE_CODE.finditer(text):
            if mask[m.start()]:
                continue
            inst = self._by_bare_code(m.group(1))
            if inst is None:
                continue
            self.stats.bare_code += 1
            matches.append(SubjectMatch(m.group(1), inst.secid, inst.type,
                                        m.start(), m.end(), 0.9))
            for i in range(m.start(), m.end()):
                mask[i] = True

        # 3) 名称/别名最长匹配
        for start, end, term, payload in longest_match_scan(
            text, self.table, min_len=2, max_len=max(self.max_len, 2), mask=mask
        ):
            inst, weight, kind = self._pick_detail(payload)
            if inst is None:
                continue
            if kind == "alias":
                self.stats.alias += 1
            else:
                self.stats.name += 1
            ambiguous = len({p[0].secid for p in payload}) > 1
            if ambiguous:
                self.stats.ambiguous += 1
            conf = round(min(0.98, 0.78 * weight + (0.08 if not ambiguous else 0.0)), 3)
            matches.append(SubjectMatch(term, inst.secid, inst.type, start, end, conf))

        matches.sort(key=lambda x: (x.start, -x.end))
        return matches

    # ---------- 候选解析 ----------
    def _by_cashtag(self, code: str | None, prefix: str | None) -> Instrument | None:
        if not code:
            return None
        if prefix:
            market = _MARKET_PREFIX.get(prefix.upper())
            if market is not None:
                hit = self.by_secid.get(f"{market}.{code}")
                if hit:
                    return hit
        return self._by_bare_code(code)

    def _by_bare_code(self, code: str) -> Instrument | None:
        cands = self.by_code.get(code)
        if not cands:
            return None
        if len(cands) == 1:
            return cands[0]
        # 撞车（如 000001）：个股优先于指数，避免把大盘观点算到个股头上
        return max(cands, key=lambda i: -_PRIORITY_RANK.get(i.type, 99))

    @staticmethod
    def _pick(cands: list[tuple[Instrument, float, str]] | None) -> Instrument | None:
        return SubjectResolver._pick_detail(cands)[0]

    @staticmethod
    def _pick_detail(cands: list[tuple[Instrument, float, str]] | None):
        if not cands:
            return None, 0.0, ""
        best = max(
            cands,
            key=lambda c: (c[1], -_PRIORITY_RANK.get(c[0].type, 99), c[0].name),
        )
        return best[0], best[1], best[2]


def resolve_raw_subject(resolver: "SubjectResolver", lex, raw: str | None,
                        benchmark=None) -> SubjectMatch | None:
    """把一段标的写法解析成 SubjectMatch。

    抽出来单独放，是为了让 LLM 抽取和「重新解析」走同一套逻辑 ——
    补了别名之后只要重跑解析就行，**不用再花一次 LLM 的钱**。

    大盘词（大盘/后市/上证/A股…）落到基准指数，否则「看多 大盘」
    这种观点会因为找不到标的而被丢掉。
    """
    if not raw:
        return None
    raw = str(raw).strip()
    if not raw:
        return None
    for m in resolver.resolve(raw):
        if m.secid:
            return m
    if benchmark is not None and lex is not None:
        terms = getattr(lex, "market_terms", None) or []
        if any(t in raw for t in terms):
            return SubjectMatch(raw, benchmark.secid, benchmark.type,
                                0, 0, 0.5, placeholder=True)
    return None


def load_alias_rows(con: sqlite3.Connection,
                    aliases_meta: dict[str, str]) -> list[tuple[str, str, float]]:
    """把 lexicon 里「别名 -> 标的名/代码/secid」解析成 (alias, secid, weight)。"""
    by_name: dict[str, list[str]] = {}
    by_code: dict[str, list[str]] = {}
    by_secid: set[str] = set()
    for row in con.execute("SELECT secid, code, name FROM instrument"):
        by_name.setdefault(row["name"], []).append(row["secid"])
        by_code.setdefault(row["code"], []).append(row["secid"])
        by_secid.add(row["secid"])

    rows: list[tuple[str, str, float]] = []
    misses: list[str] = []
    for alias, target in aliases_meta.items():
        target = str(target).strip()
        if target in by_secid:                       # 直接写 secid
            rows.append((alias, target, 1.0))
            continue
        secids = by_name.get(target)
        if not secids:
            secids = by_code.get(target)
        if not secids:
            misses.append(f"{alias} -> {target}")
            continue
        weight = 1.0 if len(secids) == 1 else 0.6
        for secid in secids:
            rows.append((alias, secid, weight))
    if misses:
        print(f"  ! 别名未解析（标的不在库中，已跳过）: {', '.join(misses)}")
    return rows
