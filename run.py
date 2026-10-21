"""零安装启动器。

项目还没做成可安装包，直接把 src 挂到 sys.path 上跑，避免 pip install -e。
用法：
    python run.py <子命令> [选项]
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from stocktool.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
