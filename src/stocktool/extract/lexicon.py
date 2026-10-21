"""词表加载。"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

TIER_STRENGTH = {"strong": 5, "normal": 3, "weak": 2}


@dataclass
class Lexicon:
    # 词 -> (极性, tier)
    polarity: dict[str, tuple[int, str]] = field(default_factory=dict)
    negation: list[str] = field(default_factory=list)
    negation_adverbs: list[str] = field(default_factory=list)
    intensifier: list[str] = field(default_factory=list)
    hedge: list[str] = field(default_factory=list)
    # 词 -> horizon
    horizon: dict[str, str] = field(default_factory=dict)
    market_terms: list[str] = field(default_factory=list)
    trigger_markers: list[str] = field(default_factory=list)
    aliases: dict[str, str] = field(default_factory=dict)

    negation_re: re.Pattern | None = None
    hedges: list[str] = field(default_factory=list)

    @property
    def max_polarity_len(self) -> int:
        return max((len(k) for k in self.polarity), default=2)

    @classmethod
    def load(cls, path: Path) -> "Lexicon":
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
        lex = cls()

        pol: dict[str, tuple[int, str]] = {}
        for direction, sign in (("bullish", 1), ("bearish", -1)):
            for tier, words in (raw.get("polarity", {}).get(direction, {}) or {}).items():
                if tier not in TIER_STRENGTH:
                    continue
                for w in words:
                    # 同一词冲突时，强 tier 胜出
                    prev = pol.get(w)
                    if prev is None or TIER_STRENGTH[tier] > TIER_STRENGTH[prev[1]]:
                        pol[w] = (sign, tier)
        lex.polarity = pol

        lex.negation = list(raw.get("negation", []))
        lex.negation_adverbs = list(raw.get("negation_adverbs", []))
        lex.intensifier = list(raw.get("intensifier", []))
        lex.hedge = list(raw.get("hedge", []))
        lex.hedges = lex.hedge
        lex.market_terms = list(raw.get("market_terms", []))
        lex.trigger_markers = list(raw.get("trigger_markers", []))
        lex.aliases = dict(raw.get("aliases", {}))

        for tag, words in (raw.get("horizon", {}) or {}).items():
            for w in words:
                lex.horizon[w] = tag

        if lex.negation:
            neg = "|".join(sorted((re.escape(x) for x in lex.negation), key=len, reverse=True))
            adv = "".join(re.escape(x) for x in lex.negation_adverbs)
            adv_part = f"[{adv}]{{0,2}}" if adv else ""
            lex.negation_re = re.compile(rf"(?:{neg}){adv_part}$")
        return lex

    def is_negated(self, before: str) -> bool:
        if not self.negation_re:
            return False
        return bool(self.negation_re.search(before[-6:]))

    def has_any(self, text: str, words: list[str]) -> bool:
        return any(w in text for w in words)
