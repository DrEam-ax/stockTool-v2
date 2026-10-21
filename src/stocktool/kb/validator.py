"""知识库校验。

校验器存在的意义：让第三方构建者能在**载入之前**知道自己做错了什么。
规范里写着的规则，这里必须真的检查，否则规范只是文档。
"""

from __future__ import annotations

import json
from pathlib import Path

from . import spec
from .bundle import KBError, iter_jsonl, read_bundle
from .spec import (
    AUTHOR, DOCUMENTS, EVALUATIONS, INSTRUMENTS, MANIFEST, OPINIONS,
    POLICY_EVIDENCE, POLICY_FULL,
)


def validate_kb(path: Path, *, check_integrity: bool = True,
                max_report: int = 20) -> dict:
    """返回 {'ok', 'errors', 'warnings', 'manifest', 'counts', 'stats'}。"""
    errors: list[str] = []
    warnings: list[str] = []
    info: dict = {}

    try:
        files = read_bundle(Path(path))
    except KBError as exc:
        return {"ok": False, "errors": [str(exc)], "warnings": [],
                "manifest": None, "counts": {}, "stats": {}}

    # ---------- 必需文件 ----------
    for name in spec.REQUIRED_FILES:
        if name not in files:
            errors.append(f"缺少必需文件 {name}")
    if errors:
        return {"ok": False, "errors": errors, "warnings": warnings,
                "manifest": None, "counts": {}, "stats": {}}

    # ---------- manifest ----------
    try:
        manifest = json.loads(files[MANIFEST])
    except json.JSONDecodeError as exc:
        return {"ok": False, "errors": [f"{MANIFEST} 不是合法 JSON: {exc}"],
                "warnings": [], "manifest": None, "counts": {}, "stats": {}}
    info["manifest"] = manifest

    if manifest.get("kb_format") != spec.FORMAT_NAME:
        errors.append(f"kb_format 应为 {spec.FORMAT_NAME!r}，"
                      f"实际 {manifest.get('kb_format')!r}")
    ver = str(manifest.get("format_version") or "")
    if not ver:
        errors.append("缺少 format_version")
    elif spec.version_major(ver) != spec.MAJOR:
        errors.append(f"不支持的 format_version 主版本: {ver}"
                      f"（本程序支持 {spec.MAJOR}.x）")
    for field in ("kb_id", "created_at", "content_policy", "counts"):
        if not manifest.get(field):
            warnings.append(f"manifest 缺少建议字段 {field}")

    policy = manifest.get("content_policy")
    if policy not in spec.POLICIES:
        errors.append(f"content_policy 非法: {policy!r}，"
                      f"只能是 {spec.POLICIES}")

    # ---------- 内容策略 vs 实际文件 ----------
    has_docs = DOCUMENTS in files
    if policy == POLICY_FULL and not has_docs:
        errors.append(f"content_policy=full_text 但缺少 {DOCUMENTS}")
    if policy == POLICY_EVIDENCE and has_docs:
        errors.append(f"content_policy=evidence_only 不应包含 {DOCUMENTS}")

    # ---------- 解析各表 ----------
    try:
        instruments = list(iter_jsonl(files[INSTRUMENTS]))
    except KBError as exc:
        return _fail(errors + [str(exc)], warnings, manifest)
    try:
        opinions = list(iter_jsonl(files[OPINIONS]))
    except KBError as exc:
        return _fail(errors + [str(exc)], warnings, manifest)
    evaluations = []
    if EVALUATIONS in files:
        try:
            evaluations = list(iter_jsonl(files[EVALUATIONS]))
        except KBError as exc:
            return _fail(errors + [str(exc)], warnings, manifest)
    else:
        warnings.append(f"缺少 {EVALUATIONS} —— App 将无法离线显示绩效榜")
    documents = []
    if has_docs:
        try:
            documents = list(iter_jsonl(files[DOCUMENTS]))
        except KBError as exc:
            return _fail(errors + [str(exc)], warnings, manifest)

    # ---------- author ----------
    try:
        author = json.loads(files[AUTHOR])
    except json.JSONDecodeError as exc:
        return _fail(errors + [f"{AUTHOR} 不是合法 JSON: {exc}"],
                     warnings, manifest)
    for field in ("summary", "methodology"):
        if not author.get(field):
            warnings.append(f"{AUTHOR} 缺 {field}（App 无法解释"
                            f"「他为什么这么说」）")

    # ---------- 引用完整性 ----------
    inst_secids = {i.get("secid") for i in instruments if i.get("secid")}
    for i in instruments:
        if not i.get("secid"):
            errors.append("存在没有 secid 的标的")
            break
        if i.get("type") not in spec.SUBJECT_TYPES:
            errors.append(f"标的 {i['secid']} 的 type 非法: {i.get('type')!r}")
            break

    opinion_ids = set()
    quote_limit = int((manifest.get("quote_policy") or {})
                      .get("max_evidence_chars") or 0)
    over_quote = 0
    for o in opinions:
        oid = o.get("opinion_id")
        if not oid:
            errors.append("存在没有 opinion_id 的观点")
            break
        opinion_ids.add(oid)
        secid = (o.get("subject") or {}).get("secid")
        if secid and secid not in inst_secids:
            errors.append(f"观点 {oid} 引用了 {INSTRUMENTS} 里没有的标的 "
                          f"{secid}")
            break
        if o.get("polarity") not in (1, -1):
            errors.append(f"观点 {oid} 的 polarity 非法: {o.get('polarity')!r}")
            break
        ev = o.get("evidence")
        if quote_limit and isinstance(ev, str) and len(ev) > quote_limit:
            over_quote += 1
    if over_quote:
        errors.append(f"{over_quote} 条观点的 evidence 超过 "
                      f"quote_policy.max_evidence_chars={quote_limit}")

    eval_bad = 0
    for e in evaluations:
        if e.get("opinion_id") not in opinion_ids:
            eval_bad += 1
    if eval_bad:
        errors.append(f"{eval_bad} 条回测结果引用了不存在的 opinion_id")

    if documents:
        doc_refs = {d.get("doc_ref") for d in documents}
        missing_doc = sum(1 for o in opinions if o.get("doc_ref") not in doc_refs)
        if missing_doc:
            warnings.append(f"{missing_doc} 条观点的 doc_ref 在 {DOCUMENTS} "
                            f"里找不到对应原文")

    # ---------- counts ----------
    counts = manifest.get("counts") or {}
    actual = {
        "opinions": len(opinions),
        "instruments": len(instruments),
        "documents": len(documents),
        "authors": len({o.get("author_uid") for o in opinions if o.get("author_uid")}),
    }
    for key, value in actual.items():
        declared = counts.get(key)
        if declared is not None and int(declared) != value:
            warnings.append(f"counts.{key} 声明 {declared}，实际 {value}")

    # ---------- 完整性哈希 ----------
    if check_integrity:
        declared_files = (manifest.get("integrity") or {}).get("files") or {}
        algo = (manifest.get("integrity") or {}).get("algorithm", "sha256")
        if algo != "sha256":
            warnings.append(f"integrity.algorithm={algo}，本程序只校验 sha256")
        elif not declared_files:
            warnings.append("manifest.integrity.files 为空，未做完整性校验")
        else:
            for name, want in declared_files.items():
                if name not in files:
                    errors.append(f"integrity 声明了 {name} 但文件不存在")
                    continue
                got = spec.sha256_text(files[name])
                if got != want:
                    errors.append(f"{name} 哈希不符（文件被改动过）")

    return {
        "ok": not errors,
        "errors": errors[:max_report],
        "warnings": warnings[:max_report],
        "manifest": manifest,
        "counts": actual,
        "stats": {
            "opinions": len(opinions),
            "instruments": len(instruments),
            "evaluations": len(evaluations),
            "documents": len(documents),
            "has_documents": bool(documents),
        },
    }


def _fail(errors, warnings, manifest):
    return {"ok": False, "errors": errors, "warnings": warnings,
            "manifest": manifest, "counts": {}, "stats": {}}


def format_report(result: dict) -> str:
    lines = []
    m = result.get("manifest") or {}
    if m:
        lines.append(f"  标题      : {m.get('title')}")
        lines.append(f"  格式版本  : {m.get('format_version')}")
        lines.append(f"  kb_id     : {m.get('kb_id')}")
        lines.append(f"  内容策略  : {m.get('content_policy')}")
        lines.append(f"  抽取方式  : {(m.get('extractor') or {}).get('mode')}"
                     f" / {(m.get('extractor') or {}).get('model')}")
        for s in m.get("sources") or []:
            lines.append(f"  来源      : {s.get('source')} "
                         f"{s.get('author_name')} "
                         f"({s.get('period', {}).get('first')} ~ "
                         f"{s.get('period', {}).get('last')}, "
                         f"{s.get('doc_count')} 篇)")
    counts = result.get("counts") or {}
    if counts:
        lines.append("  实际内容  : " + "  ".join(
            f"{k}={v}" for k, v in counts.items()))
    for w in result.get("warnings") or []:
        lines.append(f"  [警告] {w}")
    for e in result.get("errors") or []:
        lines.append(f"  [错误] {e}")
    lines.append("  结论      : " + ("通过 ✓" if result.get("ok") else "不通过 ✗"))
    return "\n".join(lines)
