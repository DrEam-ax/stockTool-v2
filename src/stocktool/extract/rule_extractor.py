"""规则抽取器：零依赖、可复现、可单测。

设计要点
  1. 不预切分逗号 —— 否则 "贵州茅台，我看好" 会把标的和方向切开。
     改为：整句内找出所有标的和所有方向词，用「就近归属」配对。
     这样 "白酒我看好，但半导体要小心" 能正确得到两个相反的观点。
  2. 否定必须紧邻，且中间只允许副词。否则 "不错，看好茅台" 会被
     "不" 误判为看空。
  3. 让步从句（虽然…但…）里的方向词不算主论断，直接跳过。
     否则 "虽然估值不便宜，但产业趋势足够强" 会被判成看空。
  4. 条件从句（除非/如果/一旦…，）里的方向词同理跳过。
     否则 "除非政策有超预期的力度，否则我暂时不碰" 会因为 "超预期"
     被判成看多，而真实态度是"暂时不碰"。条件本身另有 triggers 字段记录。
  5. 主语跨句继承。大V 常先点名标的、后面若干句只谈观点，
     例如 "$寒武纪$ 产业趋势强。我坚定看好，长线持有。"
     不继承的话，后半段的观点会因为"没主语"被整句丢掉。
     继承来的观点置信度打折，且可用「subject_raw 是否出现在句子中」反查。
"""

from __future__ import annotations

import json
from typing import Iterable

from ..matching import longest_match_scan
from ..models import Instrument, Opinion, SubjectMatch
from ..textutil import split_sentences
from .lexicon import TIER_STRENGTH, Lexicon

EXTRACTOR_ID = "rule@1"

# 让步结构：虽然/尽管/固然 …… 但/但是/然而/不过/可是/却
CONCESSIVE_START = ("虽然", "尽管", "固然", "虽说", "即使", "就算")
CONCESSIVE_END = ("但", "但是", "然而", "不过", "可是", "却")

_SENT_PUNCT = "，。；！？,;"

# 主语继承的最大字距（上一句结束 → 本句开始）
CARRY_WINDOW = 80
CARRY_CONF_PENALTY = 0.8

# 方向词与标的配对的最大字距。
# 宁可少抽，也不要错抽 —— 错误归属会直接污染回测和绩效榜，
# 而漏掉一条只是少一个样本。中文里方向词离标的太远时，
# 两者往往根本不属于同一个论断。
MAX_PAIR_DISTANCE = 40


def _concessive_spans(sent: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    for start_word in CONCESSIVE_START:
        i = sent.find(start_word)
        while i != -1:
            for end_word in CONCESSIVE_END:
                j = sent.find(end_word, i + len(start_word))
                if j != -1:
                    spans.append((i, j))
                    break
            i = sent.find(start_word, i + len(start_word))
    return spans


def _trigger_spans(sent: str, lex: Lexicon) -> list[tuple[int, int]]:
    """条件从句区间：从触发词到本从句结束（下一个标点）。"""
    spans: list[tuple[int, int]] = []
    for word in lex.trigger_markers:
        i = sent.find(word)
        while i != -1:
            k = i + len(word)
            while k < len(sent) and sent[k] not in _SENT_PUNCT:
                k += 1
            spans.append((i, k))
            i = sent.find(word, i + len(word))
    return spans


def _in_spans(pos: int, spans: list[tuple[int, int]]) -> bool:
    return any(a <= pos < b for a, b in spans)


def _nearest_subject(marker_start: int, marker_end: int,
                     subjects: list[SubjectMatch]) -> tuple[SubjectMatch | None, int]:
    """返回 (最近的标的, 距离)。合成标的距离记为 0。"""
    if not subjects:
        return None, 10 ** 9
    best: SubjectMatch | None = None
    best_dist = 10 ** 9
    for sub in subjects:
        if sub.placeholder:
            dist = 0
        elif sub.end <= marker_start:
            dist = marker_start - sub.end
        elif sub.start >= marker_end:
            dist = sub.start - marker_end
        else:
            dist = 0
        if dist < best_dist:
            best_dist = dist
            best = sub
    return best, best_dist


def _strength(tier: str, sent: str, start: int, end: int, lex: Lexicon) -> int:
    value = TIER_STRENGTH.get(tier, 3)
    before = sent[max(0, start - 4):start]
    after = sent[end:end + 4]
    if lex.has_any(before, lex.intensifier) or lex.has_any(after, lex.intensifier):
        value += 1
    if lex.has_any(before, lex.hedge) or lex.has_any(after, lex.hedge):
        value -= 1
    return max(1, min(5, value))


def _horizon(sent: str, lex: Lexicon) -> str:
    if not lex.horizon:
        return "unspecified"
    hits = longest_match_scan(sent, lex.horizon, min_len=2, max_len=6)
    return hits[0][3] if hits else "unspecified"


def _triggers(sent: str, lex: Lexicon) -> list[str]:
    out: list[str] = []
    for marker in lex.trigger_markers:
        idx = 0
        while True:
            i = sent.find(marker, idx)
            if i == -1:
                break
            j = i + len(marker)
            k = j
            while k < len(sent) and sent[k] not in _SENT_PUNCT:
                k += 1
            clause = sent[i:k].strip()
            if 4 <= len(clause) <= 60:
                out.append(clause)
            idx = k if k > i else i + 1
    return list(dict.fromkeys(out))[:3]


def extract_opinions(
    text: str,
    resolver,
    lex: Lexicon,
    *,
    benchmark: Instrument | None = None,
    min_confidence: float = 0.0,
    max_pair_distance: int = MAX_PAIR_DISTANCE,
) -> list[Opinion]:
    opinions: list[Opinion] = []
    last_subject: SubjectMatch | None = None
    last_end = -1

    for sent, s_start, s_end in split_sentences(text):
        markers = longest_match_scan(
            sent, lex.polarity, min_len=2, max_len=max(lex.max_polarity_len, 2)
        )
        subjects = resolver.resolve(sent)
        is_market = lex.has_any(sent, lex.market_terms)

        if subjects:
            # 记住最近提到的标的，供后续无主语句子继承
            last_subject = subjects[-1]
            last_end = s_end
        elif markers and not is_market and last_subject is not None \
                and 0 <= s_start - last_end <= CARRY_WINDOW:
            subjects = [SubjectMatch(
                raw=last_subject.raw,
                secid=last_subject.secid,
                type=last_subject.type,
                start=0, end=0,
                confidence=(last_subject.confidence or 0.5) * CARRY_CONF_PENALTY,
                placeholder=True,
            )]

        if not markers:
            continue
        if not subjects and not is_market:
            continue
        if not subjects and benchmark is not None:
            subjects = [SubjectMatch("大盘", benchmark.secid, benchmark.type,
                                     0, 0, 0.5, placeholder=True)]

        # 让步从句 + 条件从句里的方向词都不作数
        spans = _concessive_spans(sent) + _trigger_spans(sent, lex)

        grouped: dict[str, tuple[SubjectMatch, list[tuple[int, int, str, int, str]]]] = {}
        for m_start, m_end, term, (sign, tier) in markers:
            if _in_spans(m_start, spans):
                continue
            sub, dist = _nearest_subject(m_start, m_end, subjects)
            if sub is None:
                continue
            if dist > max_pair_distance:
                continue
            key = sub.secid or f"@{sub.start}"
            grouped.setdefault(key, (sub, []))[1].append(
                (m_start, m_end, term, sign, tier)
            )

        for key, (sub, hits) in grouped.items():
            # 同一标的多方向词：取强度最高的那个
            hits.sort(key=lambda h: (TIER_STRENGTH.get(h[4], 3), -h[0]), reverse=True)
            m_start, m_end, term, sign, tier = hits[0]

            before = sent[max(0, m_start - 6):m_start]
            negated = lex.is_negated(before)
            polarity = -sign if negated else sign

            strength = _strength(tier, sent, m_start, m_end, lex)
            horizon = _horizon(sent, lex)
            triggers = _triggers(sent, lex)

            # 主语是否是"继承"来的：句子里找不到原始写法
            carried = bool(sub.raw) and sub.raw not in sent

            conf = 0.5
            if sub.secid:
                conf += 0.25 * (sub.confidence or 0.5)
            if tier == "strong":
                conf += 0.15
            if horizon != "unspecified":
                conf += 0.05
            if negated:
                conf += 0.05
            if carried:
                conf -= 0.1
            if lex.has_any(before, lex.hedge):
                conf -= 0.1
            conf = max(0.0, min(1.0, conf))
            if conf < min_confidence:
                continue

            sentence = sent.strip()
            opinions.append(
                Opinion(
                    sentence=sentence,
                    char_start=s_start,
                    char_end=s_end,
                    subject_raw=sub.raw,
                    subject_secid=sub.secid,
                    subject_type=sub.type,
                    resolved=bool(sub.secid),
                    match_conf=sub.confidence,
                    polarity=polarity,
                    strength=strength,
                    horizon=horizon,
                    thesis=sentence[:120],
                    triggers=triggers,
                    evidence=sentence,
                    extractor=EXTRACTOR_ID,
                    confidence=round(conf, 3),
                )
            )

    return opinions


def summarize(opinions: Iterable[Opinion]) -> str:
    rows = []
    for o in opinions:
        arrow = "看多" if o.polarity > 0 else "看空"
        rows.append(f"{arrow} {o.subject_raw or '?'} "
                    f"(strength={o.strength}, horizon={o.horizon}, conf={o.confidence})")
    return json.dumps(rows, ensure_ascii=False)
