#!/usr/bin/env python3
"""把构建好的 APK 上传为 GitHub Release 资产（中文文件名自动发现，不经过命令行）。

环境变量：
    GITHUB_PAT   GitHub token（必填）
    APK_TAG      release tag，如 v1.9.6（必填）
    APK_PATH     本地 APK 绝对路径（可选；缺省自动取 dist 目录下唯一的 *.apk，
                 文件名含中文也能正确发现 —— 直接 glob 文件系统，绕开命令行编码）
    APK_NAME     上传到 release 的资产名（可选，缺省用发现到的文件名）
    BODY_FILE    release 说明文本文件路径（可选，缺省用一行标题）

退出码：0 成功 / 1 接口失败 / 2 缺少参数
"""

import glob
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

REPO = "DrEam-ax/stockTool-v2"
UA = "stocktool-release"
DIST_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dist")


def req(method, url, headers, data=None):
    r = urllib.request.Request(url, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=90) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main():
    token = os.environ.get("GITHUB_PAT", "")
    tag = os.environ.get("APK_TAG", "")
    apk = os.environ.get("APK_PATH", "")
    body_file = os.environ.get("BODY_FILE", "")
    if not token or not tag:
        print("missing env: GITHUB_PAT / APK_TAG", file=sys.stderr)
        return 2
    if not apk:
        # 自动发现 dist 下唯一的 APK（文件名中文直接来自文件系统，Unicode 安全）
        candidates = [p for p in glob.glob(os.path.join(DIST_DIR, "*.apk")) if os.path.isfile(p)]
        if len(candidates) != 1:
            print(f"dist 下应有且仅有一个 apk，实际 {len(candidates)} 个，请用 APK_PATH 指定", file=sys.stderr)
            return 2
        apk = candidates[0]
    display_name = os.environ.get("APK_NAME", "") or os.path.basename(apk)
    # ⚠️ GitHub uploads 接口对 percent-encoded 的中文资产名解码会丢字符（实测：
    # %E9%80%89%E8%82%A1... 解码后中文字节被丢弃，只剩 "-v1.9.6-debug.apk"，
    # 撞名 422 already_exists）。非 ASCII 文件名统一转拼音资产名。
    if any(ord(c) > 127 for c in display_name):
        display_name = f"xuangu-zhushou-{tag}-debug.apk"
    if not os.path.isfile(apk):
        print(f"apk not found: {apk}", file=sys.stderr)
        return 2
    body = f"Release {tag}"
    if body_file and os.path.isfile(body_file):
        with open(body_file, "r", encoding="utf-8") as f:
            body = f.read().strip()
    sha = os.popen("git rev-parse HEAD").read().strip() or "main"

    H = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": UA,
    }

    # 1) 建 release（同 tag 已存在则复用）
    st, out = req(
        "POST",
        f"https://api.github.com/repos/{REPO}/releases",
        H,
        json.dumps(
            {
                "tag_name": tag,
                "name": tag,
                "body": body,
                "target_commitish": sha,
                "draft": False,
            }
        ).encode(),
    )
    if st not in (200, 201):
        err = out.decode(errors="replace")
        if "already_exists" in err:
            st2, out2 = req("GET", f"https://api.github.com/repos/{REPO}/releases/tags/{urllib.parse.quote(tag)}", H)
            if st2 != 200:
                print("get existing release failed:", st2, out2.decode(errors="replace"), file=sys.stderr)
                return 1
            rid = json.loads(out2)["id"]
            print(f"release {tag} exists, reuse id={rid}")
        else:
            print("create release failed:", st, err, file=sys.stderr)
            return 1
    else:
        rid = json.loads(out)["id"]
        print(f"release {tag} created id={rid}")

    # 2) 清掉同名 release 下名字不符的旧资产（防重传残留）
    stl, outl = req("GET", f"https://api.github.com/repos/{REPO}/releases/{rid}", H)
    if stl == 200:
        for a in json.loads(outl).get("assets", []):
            if a.get("name") != display_name:
                req("DELETE", f"https://api.github.com/repos/{REPO}/releases/assets/{a['id']}", H)
                print(f"pruned old asset: {a.get('name')}")

    # 3) 上传资产
    with open(apk, "rb") as f:
        data = f.read()
    name = urllib.parse.quote(display_name)
    hh = {**H, "Content-Type": "application/vnd.android.package-archive"}
    st3, out3 = req(
        "POST",
        f"https://uploads.github.com/repos/{REPO}/releases/{rid}/assets?name={name}",
        hh,
        data,
    )
    if st3 not in (200, 201):
        print("upload asset failed:", st3, out3.decode(errors="replace"), file=sys.stderr)
        return 1
    asset = json.loads(out3)
    print(f"uploaded: {asset.get('name')}")

    # 4) 回读确认
    st4, out4 = req("GET", f"https://api.github.com/repos/{REPO}/releases/{rid}", H)
    if st4 == 200:
        rel = json.loads(out4)
        print(f"release page: {rel.get('html_url')}")
        for a in rel.get("assets", []):
            print(f"  asset: {a.get('name')} -> {a.get('browser_download_url')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
