"""推送前的最后一道闸门。

之前踩过的坑：
  1. 只检查了「有没有真实 .stkb 文件和凭据文件」，
     没检查**文件名之外的文本内容**，结果能反推出语料来源的信息
     （真名、UID、语料统计、帖子 ID）一路进了公开仓库的历史。
     更糟的是 git 会保留悬空提交，即使分支重写、旧 commit 仍可凭 SHA 访问。
  2. 这个检查脚本本身如果写死了敏感词，提交上去等于又泄漏一次。

所以：**敏感词清单放在 tools/.prepush-forbidden.txt（已 gitignore）**，
脚本只留通用逻辑。别人 clone 下来没有这份清单也没关系，
文件层面和凭据层面的检查照样能跑。

用法：python tools/prepush_check.py
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_FILE = ROOT / "tools" / ".prepush-forbidden.txt"

# ---------- A. 文件层面（与被分析者无关，可以写死在脚本里）----------
FORBIDDEN_PATHS = [
    "config/llm_api_key.txt",
    "config/xueqiu_cookie.txt",
    "config/settings.json",
    "data/stocktool.db",
    "data/raw/",
    "dist/",
    "app/node_modules/",
    "app/dist/",
]

# 这些前缀的 .stkb 是合成数据，允许进库
ALLOWED_STKB_PREFIX = ("demo_junshi_",)

SKIP_SUFFIX = {
    ".stkb", ".db", ".apk", ".png", ".jpg", ".jpeg", ".webp",
    ".gif", ".ico", ".zip", ".pyc", ".mjs", ".woff", ".ttf",
}


def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"], capture_output=True, text=True, encoding="utf-8",
    ).stdout
    return [f for f in out.splitlines() if f.strip()]


def load_forbidden() -> list[str]:
    """读本地的敏感词清单；没有就返回空（只做通用检查）。"""
    if not FORBIDDEN_FILE.exists():
        return []
    out = []
    for line in FORBIDDEN_FILE.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            out.append(s)
    return out


def looks_like_secret(tok: str) -> bool:
    """过滤低信息量噪声。

    踩过：key 文件里有一行 60 个连字符的分隔线，而某源码注释里
    也有同样的分隔线，于是被误判成「凭据泄漏」。
    真凭据的字符种类足够多（有字母也有数字）。
    """
    if len(set(tok)) <= 4:
        return False
    return any(c.isdigit() for c in tok) and any(c.isalpha() for c in tok)


def main() -> int:
    files = tracked_files()
    problems = 0
    print(f"检查 {len(files)} 个被 git 跟踪的文件\n")

    # ---------- A. 文件层面 ----------
    print("=== A. 文件层面 ===")
    bad_files = 0
    for bad in FORBIDDEN_PATHS:
        hits = [f for f in files if f.startswith(bad)]
        if hits:
            print(f"  ✗ 不该进库: {bad}  ({len(hits)} 个)")
            bad_files += 1
    kbs = [
        f for f in files
        if f.startswith("data/kb/") and f.endswith(".stkb")
        and not f.split("/")[-1].startswith(ALLOWED_STKB_PREFIX)
    ]
    if kbs:
        print(f"  ✗ 真实知识库进了库: {kbs}")
        bad_files += 1
    if bad_files == 0:
        print("  ✓ 无禁止文件")
    problems += bad_files

    # ---------- B. 内容层面 ----------
    forbidden = load_forbidden()
    print(f"\n=== B. 内容层面（{len(forbidden)} 条敏感词）===")
    if not forbidden:
        print(f"  ! 没找到 {FORBIDDEN_FILE.name}，跳过这一项")
        print("    （该文件被 gitignore，保存你本地的敏感词清单）")
    else:
        content_hits = 0
        for f in files:
            p = ROOT / f
            if not p.exists() or p.suffix.lower() in SKIP_SUFFIX:
                continue
            try:
                text = p.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for line_no, line in enumerate(text.splitlines(), 1):
                for bad in forbidden:
                    if bad in line:
                        print(f"  ✗ {f}:{line_no}  [{bad}]  {line.strip()[:80]}")
                        content_hits += 1
        if content_hits == 0:
            print("  ✓ 未命中任何敏感词")
        problems += content_hits

    # ---------- C. 凭据内容 ----------
    print("\n=== C. 凭据内容 ===")
    cred_hits = 0
    for cred in ("config/llm_api_key.txt", "config/xueqiu_cookie.txt"):
        p = ROOT / cred
        if not p.exists():
            continue
        raw = p.read_text(encoding="utf-8", errors="ignore")
        toks = re.findall(r"sk-[A-Za-z0-9_\-]{10,}", raw)
        toks += re.findall(r"[A-Za-z0-9_\-\.]{25,}", raw)
        for t in sorted(set(toks), key=len, reverse=True):
            if not looks_like_secret(t):
                continue
            r = subprocess.run(
                ["git", "grep", "-F", "-I", "--", t],
                capture_output=True, text=True, encoding="utf-8", cwd=ROOT,
            )
            if r.returncode == 0 and r.stdout.strip():
                print(f"  ✗ 凭据内容泄漏（来自 {cred}，前缀 {t[:8]}…）")
                cred_hits += 1
                break
    if cred_hits == 0:
        print("  ✓ 真实凭据内容均不在库中")
    problems += cred_hits

    print("\n" + "=" * 60)
    if problems:
        print(f"  ✗ 发现 {problems} 个问题，**不要推送**")
        return 1
    print("  ✓ 通过：可以推送")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
