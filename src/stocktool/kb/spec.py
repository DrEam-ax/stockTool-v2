"""知识库格式的常量与基础工具。"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

FORMAT_NAME = "stocktool-kb"
FORMAT_VERSION = "1.0"
MAJOR = FORMAT_VERSION.split(".")[0]

MANIFEST = "manifest.json"
AUTHOR = "author.json"
INSTRUMENTS = "instruments.jsonl"
OPINIONS = "opinions.jsonl"
EVALUATIONS = "evaluations.jsonl"
DOCUMENTS = "documents.jsonl"

REQUIRED_FILES = (MANIFEST, AUTHOR, INSTRUMENTS, OPINIONS)
OPTIONAL_FILES = (EVALUATIONS, DOCUMENTS)
ALL_FILES = REQUIRED_FILES + OPTIONAL_FILES

POLICY_FULL = "full_text"
POLICY_EVIDENCE = "evidence_only"
POLICIES = (POLICY_FULL, POLICY_EVIDENCE)

KB_EXT = ".stkb"

# 标的类型（与内部 instrument.type 保持一致）
SUBJECT_TYPES = ("stock", "fund", "index", "industry", "concept")


def dumps_line(obj) -> str:
    """紧凑单行 JSON，用于 JSONL。"""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"),
                      default=str)


def dumps_pretty(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2, default=str)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def make_opinion_id(author_uid: str, doc_ref: str, char_start,
                    subject_secid, subject_raw=None) -> str:
    """生成库内唯一 ID。

    **必须用「secid 或原名」做区分。** 只用 secid 会导致冲突：
    同一条帖子里同一位置的两条未归属观点（例如「氧化铝2505」和「氧化铝2509」），
    secid 都是空，就会算出同一个 ID，进而让回测结果对不上观点。
    这也正是 DB 里去重用的口径（`subject_secid or subject_raw`）。
    """
    ref = subject_secid or subject_raw or ""
    raw = f"{author_uid}|{doc_ref}|{char_start}|{ref}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]


def author_uid_of(source: str, source_uid: str) -> str:
    return f"{source}:{source_uid}"


def split_author_uid(author_uid: str) -> tuple[str, str]:
    source, _, uid = str(author_uid).partition(":")
    return (source or "unknown", uid or str(author_uid))


def doc_ref_of(source: str, external_id: str) -> str:
    return f"{source}:{external_id}"


def split_doc_ref(doc_ref: str) -> tuple[str, str]:
    source, _, eid = str(doc_ref).partition(":")
    return (source or "unknown", eid or str(doc_ref))


def version_major(version: str) -> str:
    return str(version).split(".")[0]


def default_kb_id(source: str, author_uid: str, stamp: str) -> str:
    # author_uid 形如 "xueqiu:0000000000"，要剥掉前缀，
    # 否则 source 会被拼两次，得到 xueqiu-xueqiu-0000000000
    uid = author_uid.split(":", 1)[1] if ":" in str(author_uid) else author_uid
    safe = str(uid).replace(":", "-").replace("/", "-")
    return f"{source}-{safe}-{stamp}"
