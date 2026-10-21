"""核对远端压缩包里的文件与本地 HEAD 是否完全一致。

为什么单独查：codeload.github.com 有 CDN 缓存，刚推完就下载
可能拿到上一次的内容。差一个文件就说明缓存没刷新，不能当作验证通过。
"""

import io
import subprocess
import sys
import urllib.request
import zipfile

REPO = "DrEam-ax/stockTool-v2"
UA = {"User-Agent": "dsh-agent"}


def main() -> int:
    local = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", "HEAD"],
        capture_output=True, text=True, encoding="utf-8",
    ).stdout.splitlines()
    local = [f for f in local if f.strip()]

    url = f"https://codeload.github.com/{REPO}/zip/refs/heads/main"
    req = urllib.request.Request(url, headers={**UA, "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
    zf = zipfile.ZipFile(io.BytesIO(raw))
    names = [n for n in zf.namelist() if not n.endswith("/")]
    prefix = names[0].split("/")[0] + "/"
    remote = sorted(n[len(prefix):] for n in names if n.startswith(prefix))
    local_sorted = sorted(local)

    print(f"本地 HEAD 文件数: {len(local_sorted)}")
    print(f"远端压缩包文件数: {len(remote)}")

    only_local = [f for f in local_sorted if f not in remote]
    only_remote = [f for f in remote if f not in local_sorted]

    if only_local:
        print("\n只在本地（远端缺）:")
        for f in only_local:
            print(f"  - {f}")
    if only_remote:
        print("\n只在远端（本地没有）:")
        for f in only_remote:
            print(f"  + {f}")

    print()
    if not only_local and not only_remote:
        print("✓ 本地与远端文件完全一致")
        return 0
    print("✗ 不一致 —— 可能是 CDN 缓存，稍后重试")
    return 1


if __name__ == "__main__":
    sys.exit(main())
