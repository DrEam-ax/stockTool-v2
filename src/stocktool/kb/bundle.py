"""知识库容器读写：支持目录与 ZIP（.stkb）两种形态。

两种形态都要支持，是因为它们服务不同场景：
  · 目录 —— 开发、审查、git 版本管理、手工修补
  · ZIP  —— 分发与分享，一个文件搞定
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

from .spec import ALL_FILES, MANIFEST


class KBError(RuntimeError):
    """知识库读取/写入失败。"""


def is_zip(path: Path) -> bool:
    path = Path(path)
    if path.is_file() and zipfile.is_zipfile(path):
        return True
    return path.suffix.lower() in (".stkb", ".zip") and path.is_file()


def write_bundle(out_path: Path, files: dict[str, str]) -> Path:
    """写知识库。扩展名为 .stkb/.zip 时打成 zip，否则写目录。"""
    out_path = Path(out_path)
    if out_path.suffix.lower() in (".stkb", ".zip"):
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for name in ALL_FILES:
                if name not in files:
                    continue
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, files[name].encode("utf-8"))
        return out_path

    out_path.mkdir(parents=True, exist_ok=True)
    for name in ALL_FILES:
        if name not in files:
            continue
        (out_path / name).write_text(files[name], encoding="utf-8")
    return out_path


def read_bundle(path: Path) -> dict[str, str]:
    """读成 {文件名: 文本}。知识库很小（~1MB），整体读入内存即可。"""
    path = Path(path)
    if not path.exists():
        raise KBError(f"知识库不存在: {path}")

    if path.is_dir():
        out: dict[str, str] = {}
        for name in ALL_FILES:
            f = path / name
            if f.exists():
                out[name] = f.read_text(encoding="utf-8")
        return out

    if not zipfile.is_zipfile(path):
        raise KBError(f"既不是目录也不是有效的 zip: {path}")
    out = {}
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        for name in ALL_FILES:
            if name in names:
                out[name] = zf.read(name).decode("utf-8")
    return out


def iter_jsonl(text: str):
    """逐行解析 JSONL，出错时带行号报错。"""
    for lineno, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        import json
        try:
            yield json.loads(line)
        except json.JSONDecodeError as exc:
            raise KBError(f"JSONL 第 {lineno} 行解析失败: {exc}") from exc
