"""词表加载。

放在这里而不是 cli.py：`load_lexicon` 是多个命令和**外部脚本/测试**
都要用的东西，住在 CLI 里会导致脚本为了拿一个词表去 import 整个命令行模块。
"""

from __future__ import annotations

from pathlib import Path

from .extract.lexicon import Lexicon


def load_lexicon(cfg) -> Lexicon:
    path = Path(cfg.lexicon_path)
    if not path.exists():
        raise SystemExit(f"词表不存在: {path}")
    return Lexicon.load(path)


__all__ = ["load_lexicon"]
