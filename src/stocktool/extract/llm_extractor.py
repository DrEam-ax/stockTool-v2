"""LLM 抽取器（可选增强）。

规则抽取器抓的是「显式方向词 + 显式标的」。LLM 用来补两类规则抓不到的：
  - 隐含表达："这个位置我只会越来越重" / "库存已经见底了"
  - 条件观点："如果跌破 20 日线，我就走"
接口走 OpenAI 兼容协议，可直接对接 DeepSeek / 通义 / 本地 vLLM。
"""

from __future__ import annotations

import json
import re
import threading
from typing import Any

import requests

from ..models import Instrument, Opinion, SubjectMatch
from ..textutil import split_sentences
from .resolver import resolve_raw_subject

PROMPT = """你是证券文本结构化抽取器。从下面的文本中抽取作者对具体标的的观点。

作者是中文财经大V，写作风格口语化，常用隐喻和正话反说。请注意：
  - "拒绝下跌""跌不动了""已经跌了很多" 在安抚语境里是【看多】信号
  - "不像2000年互联网泡沫破灭" 是对泡沫类比的【否定】，不是看空
  - "犹如XX年破位的彼时彼刻" 是【看空】类比
  - 反讽、自嘲、提问、纯闲聊，都不要输出
  - 关注作者的真实判断，而不是他文中出现的词

严格输出 JSON 对象，格式为 {"opinions": [ ... ]}，数组每个元素包含：
  subject: 文中出现的标的原始写法（个股名/板块名/指数名，没有则 null）
  polarity: 1=看多, -1=看空, 0=中性
  strength: 1-5 的强度
  horizon: "short"|"mid"|"long"|"unspecified"
  thesis: 不超过 60 字的逻辑要点
  triggers: 字符串数组，触发条件（没有就空数组）
  quote: 原文中的证据片段（必须逐字来自原文）
  confidence: 0-1

规则：
  - 只抽取作者明确表达方向判断的内容，不要抽取客观陈述。
  - quote 必须能在原文中逐字找到，否则该条不要输出。
  - 一条都没有就返回 {"opinions": []}。

文本：
---
{text}
---
"""


def render_prompt(text: str) -> str:
    """把文本填进提示词。

    **刻意不用 str.format()** —— 提示词里含 JSON 示例（{"opinions": [...]}），
    format 会把示例里的 { 当成占位符，抛 KeyError: '"opinions"'。
    只要提示词里出现 JSON，format 就一定会炸，所以用最朴素的替换。
    """
    return PROMPT.replace("{text}", text)


def _extract_json(raw: str) -> Any:
    raw = raw.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", raw, re.S)
    if fence:
        raw = fence.group(1).strip()

    # 1) 整体就是合法 JSON —— 最常见情况，必须优先。
    #    否则下面按括号抠取时，裸数组 [ {...} ] 会被抠成里面的对象。
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # 2) 前后有寒暄文字时，抠出最外层的对象或数组
    for opener, closer in (("{", "}"), ("[", "]")):
        start = raw.find(opener)
        end = raw.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(raw[start:end + 1])
            except json.JSONDecodeError:
                continue
    raise json.JSONDecodeError("找不到可解析的 JSON", raw, 0)


class LLMExtractor:
    def __init__(self, cfg, resolver, lex=None):
        self.cfg = cfg
        self.resolver = resolver
        self.lex = lex
        self.base_url = str(cfg.values.get("llm_base_url")).rstrip("/")
        self.model = str(cfg.values.get("llm_model"))
        self.timeout = int(cfg.values.get("llm_timeout", 120))
        self.api_key = cfg.api_key
        # 用量统计：跑几千条帖子要知道花了多少
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.calls = 0
        self.failures = 0
        # 并发抽取时多个线程会同时累加，必须加锁
        self._lock = threading.Lock()

    @property
    def id(self) -> str:
        return f"llm:{self.model}"

    def available(self) -> bool:
        return bool(self.api_key)

    @property
    def usage(self) -> dict:
        return {
            "calls": self.calls,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.prompt_tokens + self.completion_tokens,
            "failures": self.failures,
        }

    def _chat(self, text: str) -> str:
        return self._chat_raw(render_prompt(text))

    def chat_text(self, prompt: str) -> str:
        """自由文本对话 —— **不要** JSON 模式。

        踩过的坑：JSON 模式（response_format=json_object）要求提示词里
        必须出现 "json" 字样，否则接口直接 400 Bad Request。
        角色扮演、自由问答这类场景必须走这条路径。
        """
        return self._chat_raw(prompt, json_mode=False)

    def _chat_raw(self, prompt: str, *, json_mode: bool = True) -> str:
        """打一次任意提示词。作者画像/决策框架复用同一个 provider，避免重复配置。

        json_mode=False 时返回自由文本，用于角色扮演。
        """
        payload_body: dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0,
        }
        if json_mode:
            # 必须是 json_object（对象），与提示词里的 {"opinions": [...]} 对应。
            # 若这里要求对象而提示词要求数组，接口会直接报错。
            payload_body["response_format"] = {"type": "json_object"}

        resp = requests.post(
            f"{self.base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json=payload_body,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        payload = resp.json()
        usage = payload.get("usage") or {}
        with self._lock:
            self.prompt_tokens += int(usage.get("prompt_tokens") or 0)
            self.completion_tokens += int(usage.get("completion_tokens") or 0)
            self.calls += 1
        return payload["choices"][0]["message"]["content"]

    # 供 profiler / persona 使用的别名（语义更清楚）
    _chat_generic = _chat_raw

    def extract(self, text: str, *, benchmark: Instrument | None = None) -> list[Opinion]:
        raw = self._chat(text)
        try:
            items = _extract_json(raw)
        except json.JSONDecodeError:
            with self._lock:
                self.failures += 1
            return []
        if isinstance(items, dict):
            items = items.get("opinions") or items.get("data") or []
        if not isinstance(items, list):
            with self._lock:
                self.failures += 1
            return []

        sentences = split_sentences(text)
        opinions: list[Opinion] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            quote = str(item.get("quote") or "").strip()
            if not quote or quote not in text:
                continue          # 幻觉引用直接丢弃
            sent, s_start, s_end = _locate(sentences, quote, text)
            subject_raw = item.get("subject")
            subject_raw = str(subject_raw).strip() if subject_raw else None

            code = subj_type = None
            resolved = False
            conf_match = None
            if subject_raw:
                found = _match_subject(self.resolver, text, subject_raw,
                                       self.lex, benchmark)
                if found is not None:
                    code, subj_type = found.secid, found.type
                    resolved = bool(code)
                    conf_match = found.confidence
                else:
                    subj_type = "unresolved"
            elif benchmark is not None:
                code, subj_type, resolved, conf_match = (
                    benchmark.secid, benchmark.type, True, 0.5,
                )

            try:
                polarity = int(item.get("polarity", 0))
            except (TypeError, ValueError):
                polarity = 0
            if polarity not in (-1, 0, 1):
                polarity = 0
            # 中性不是方向判断：既不可回测（没有方向可言），
            # 也不是知识库规范允许的 polarity（规范只允许 ±1）。
            # 直接丢弃，不要写进去污染统计。
            if polarity == 0:
                continue
            try:
                strength = int(item.get("strength", 3))
            except (TypeError, ValueError):
                strength = 3
            strength = max(1, min(5, strength))
            horizon = str(item.get("horizon") or "unspecified")
            if horizon not in ("short", "mid", "long", "unspecified"):
                horizon = "unspecified"
            try:
                confidence = float(item.get("confidence", 0.6))
            except (TypeError, ValueError):
                confidence = 0.6

            opinions.append(
                Opinion(
                    sentence=sent,
                    char_start=s_start,
                    char_end=s_end,
                    subject_raw=subject_raw,
                    subject_secid=code,
                    subject_type=subj_type or "unresolved",
                    resolved=resolved,
                    match_conf=conf_match,
                    polarity=polarity,
                    strength=strength,
                    horizon=horizon,
                    thesis=str(item.get("thesis") or sent)[:200],
                    triggers=[str(t) for t in (item.get("triggers") or [])][:5],
                    evidence=quote,
                    extractor=self.id,
                    confidence=max(0.0, min(1.0, confidence)),
                )
            )
        return opinions


def _locate(sentences, quote: str, text: str) -> tuple[str, int, int]:
    for sent, start, end in sentences:
        if quote in sent:
            return sent.strip(), start, end
    idx = text.find(quote)
    if idx == -1:
        return quote, 0, len(quote)
    return quote, idx, idx + len(quote)


def _match_subject(resolver, text: str, subject_raw: str,
                   lex=None, benchmark=None) -> SubjectMatch | None:
    """先在标的原文里找，再回到整篇正文里找，最后落到大盘词兜底。"""
    found = resolve_raw_subject(resolver, lex, subject_raw, benchmark)
    if found is not None:
        return found
    for m in resolver.resolve(text):
        if m.secid and (m.raw in subject_raw or subject_raw in m.raw):
            return m
    return None
