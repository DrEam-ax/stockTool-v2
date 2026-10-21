"""手工/半自动文本导入。

用途有二：
  1. 种子数据 —— 在采集器接通前先把下游管道跑通
  2. 兜底通道 —— 封闭 App、付费社区这类爬不动的源，人工粘贴后走同一条管道

文件格式：

    ---
    source: xueqiu
    author_uid: test_kol_a
    author_name: 测试大V·甲
    author_note: 合成测试数据
    ---

    ## 2024-03-05 21:30
    正文第一段……

    ## 2024-03-08 09:15 [post] https://xueqiu.com/123/456
    正文……
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Iterator

from ..models import RawDoc
from ..textutil import normalize_text, parse_dt
from .base import Adapter

_HEADER = re.compile(
    r"^##\s+(?P<dt>[\d\-/: T]{8,19})"
    r"(?:\s+\[(?P<kind>[a-z_]+)\])?"
    r"(?:\s+(?P<url>https?://\S+))?\s*$",
    re.MULTILINE,          # 没有这个，中间的 ## 小标题一个都匹配不到
)


def parse_front_matter(text: str) -> tuple[dict[str, str], str]:
    if not text.lstrip().startswith("---"):
        return {}, text
    body = text.lstrip()
    end = body.find("\n---", 3)
    if end == -1:
        return {}, text
    block = body[3:end]
    rest = body[end + 4:]
    meta: dict[str, str] = {}
    for line in block.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip()
    return meta, rest


def parse_seed_text(text: str, default_source: str = "manual") -> list[RawDoc]:
    meta, body = parse_front_matter(text)
    source = meta.get("source", default_source)
    author_uid = meta.get("author_uid", "unknown")
    author_name = meta.get("author_name", author_uid)
    note = meta.get("author_note")

    docs: list[RawDoc] = []
    matches = list(_HEADER.finditer(body))
    for idx, m in enumerate(matches):
        seg_start = m.end()
        seg_end = matches[idx + 1].start() if idx + 1 < len(matches) else len(body)
        content = normalize_text(body[seg_start:seg_end])
        if not content:
            continue
        published_at = parse_dt(m.group("dt")).isoformat(timespec="seconds")
        kind = m.group("kind") or meta.get("kind", "post")
        url = m.group("url")
        digest = hashlib.sha1(
            f"{source}|{author_uid}|{published_at}|{content[:64]}".encode("utf-8")
        ).hexdigest()[:16]
        docs.append(
            RawDoc(
                source=source,
                author_uid=author_uid,
                author_name=author_name,
                author_note=note,
                published_at=published_at,
                text=content,
                external_id=digest,
                kind=kind,
                permalink=url,
                raw_meta={"origin": "manual"},
            )
        )
    return docs


class ManualAdapter(Adapter):
    name = "manual"

    def __init__(self, source: str = "manual"):
        self.source = source

    def fetch(self, paths: list[Path] | None = None,
              directory: Path | None = None) -> Iterator[RawDoc]:
        targets: list[Path] = []
        if paths:
            targets.extend(paths)
        if directory and directory.exists():
            targets.extend(sorted(directory.glob("*.md")))
            targets.extend(sorted(directory.glob("*.txt")))
        seen: set[Path] = set()
        for path in targets:
            resolved = path.resolve()
            if resolved in seen or not path.exists():
                continue
            seen.add(resolved)
            text = path.read_text(encoding="utf-8")
            for doc in parse_seed_text(text, default_source=self.source):
                doc.raw_meta["file"] = str(path)
                yield doc
