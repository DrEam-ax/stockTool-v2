"""从 GitHub 侧验证远端仓库：下载整包，本地逐文件扫敏感词。

为什么改成下载压缩包：
  之前逐个文件走 Contents API，188 个文件直接触发限流（HTTP 429），
  而且失败被 except 静默跳过 —— 结果只扫了 26 个还以为扫完了。
  整包下载只要 1 个请求，且能扫到**每一个**文件。

Python 写而不是 PowerShell：要处理 zip 和 UTF-8，
PowerShell 在这些地方已经踩过两次编码坑。
"""

from __future__ import annotations

import io
import json
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path

REPO = "DrEam-ax/stockTool-v2"
ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_FILE = ROOT / "tools" / ".prepush-forbidden.txt"
UA = {"User-Agent": "dsh-agent"}

SKIP_SUFFIX = {".stkb", ".db", ".apk", ".png", ".jpg", ".jpeg", ".webp",
               ".gif", ".ico", ".zip", ".pyc", ".mjs", ".woff", ".ttf", ".jar"}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def main() -> int:
    forbidden: list[str] = []
    if FORBIDDEN_FILE.exists():
        forbidden = [
            s.strip()
            for s in FORBIDDEN_FILE.read_text(encoding="utf-8").splitlines()
            if s.strip() and not s.startswith("#")
        ]

    print(f"=== 验证 {REPO} ===\n")
    print(f"  敏感词 {len(forbidden)} 条")

    # 元信息
    try:
        meta = json.loads(fetch(f"https://api.github.com/repos/{REPO}"))
        print(f"  可见性 {('私有' if meta['private'] else '公开')}   "
              f"大小 {meta['size']} KB   "
              f"stars/forks {meta['stargazers_count']}/{meta['forks_count']}")
    except Exception as e:
        print(f"  ! 元信息获取失败：{e}")

    # 整包下载（不占 API 配额）
    url = f"https://codeload.github.com/{REPO}/zip/refs/heads/main"
    print(f"\n  下载整包：{url}")
    raw = fetch(url)
    print(f"  压缩包 {len(raw) / 1024 / 1024:.2f} MB")

    zf = zipfile.ZipFile(io.BytesIO(raw))
    names = [n for n in zf.namelist() if not n.endswith("/")]
    # 去掉顶层目录前缀（GitHub 会包一层 <repo>-<branch>/）
    prefix = names[0].split("/")[0] + "/" if names else ""
    rel = [n[len(prefix):] for n in names]
    total = sum(zf.getinfo(n).file_size for n in names)
    print(f"  文件 {len(names)} 个，解压后 {total / 1024 / 1024:.2f} MB")

    print("\n=== 逐文件扫描（全部文本文件）===")
    scanned = 0
    problems = 0
    for n, r in zip(names, rel):
        if Path(r).suffix.lower() in SKIP_SUFFIX:
            continue
        try:
            text = zf.read(n).decode("utf-8")
        except (UnicodeDecodeError, KeyError):
            continue
        scanned += 1
        for term in forbidden:
            if term in text:
                for no, line in enumerate(text.splitlines(), 1):
                    if term in line:
                        print(f"  ✗ {r}:{no}  [{term}]  {line.strip()[:90]}")
                        problems += 1
                        break
    print(f"  已扫描 {scanned} 个文本文件")

    # 提交与 ref
    print("\n=== 提交 / ref ===")
    try:
        commits = json.loads(fetch(f"https://api.github.com/repos/{REPO}/commits?per_page=100"))
        print(f"  提交数 {len(commits)}")
        for c in commits:
            print(f"    {c['sha'][:7]}  {c['commit']['message'].splitlines()[0]}")
        if len(commits) != 1:
            print("  ! 不是单提交，需确认没有旧历史")
    except Exception as e:
        print(f"  ! 提交列表获取失败：{e}")
    try:
        refs = json.loads(fetch(f"https://api.github.com/repos/{REPO}/git/refs"))
        for r in refs:
            print(f"  {r['ref']} → {r['object']['sha'][:7]}")
        if len(refs) == 1:
            print("  ✓ 只有 main 一个 ref（新库没有旧提交通道）")
    except Exception as e:
        print(f"  ! ref 获取失败：{e}")

    print("\n" + "=" * 60)
    if problems:
        print(f"  ✗ 发现 {problems} 处敏感内容")
        return 1
    print("  ✓ 远端干净：全部文本文件零敏感词")
    return 0


if __name__ == "__main__":
    sys.exit(main())
