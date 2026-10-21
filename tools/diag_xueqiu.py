"""雪球 400016 定位：对照实验找出可用的请求头组合。

思路：找一个会返回**干净 JSON** 的受保护接口当探针
（/users/show.json 会明确回 error_code 400016），
然后只改请求头这一个变量，逐个试。
"""
import os

# 要分析的大V名字。默认是占位符；用法：
#     $env:STOCKTOOL_AUTHOR = "某大V"
AUTHOR = os.environ.get("STOCKTOOL_AUTHOR", "示例大V")

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

import requests  # noqa: E402
from stocktool.config import load_config  # noqa: E402
from stocktool.ingest.xueqiu import (  # noqa: E402
    UA, load_browser_request, load_cookie,
)

cfg = load_config()
cookie = load_cookie(cfg)
browser = load_browser_request(cfg)

if not cookie:
    print("没有 Cookie，退出")
    raise SystemExit(1)

print("=" * 70)
print("浏览器 cURL 解析结果")
print("=" * 70)
if browser:
    print(f"  URL  : {browser.url}")
    print(f"  HOST : {browser.host}")
    print(f"  头数量: {len(browser.headers)}")
    print(f"  UA    : {browser.headers.get('user-agent', '(无)')[:100]}")
    print(f"  Cookie 长度: {len(browser.cookie)}")
else:
    print("  ! 没有解析出 cURL（用户可能只贴了裸 Cookie）")

SELF = ""
for kv in cookie.split(";"):
    k, _, v = kv.strip().partition("=")
    if k == "u":
        SELF = v
# 目标 UID。默认占位符；用法：$env:STOCKTOOL_UID = "1234567890"
TARGET = os.environ.get("STOCKTOOL_UID", "0000000000")

bua = (browser.headers.get("user-agent") if browser else None) or UA
bal = (browser.headers.get("accept-language") if browser else None) or "zh-CN,zh;q=0.9"
bsec = {k: v for k, v in (browser.headers.items() if browser else [])
        if k.startswith("sec-ch-ua")}

PROBE = "/users/show.json"
PROBE_PARAMS = {"user_id": SELF}

VARIANTS = [
    ("1 基线：自拼 Chrome125 UA", "xueqiu.com",
     {"User-Agent": UA, "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9", "X-Requested-With": "XMLHttpRequest"}),
    ("2 换成浏览器原版 UA", "xueqiu.com",
     {"User-Agent": bua, "Accept": "application/json, text/plain, */*",
      "Accept-Language": bal, "X-Requested-With": "XMLHttpRequest"}),
    ("3 UA + sec-ch-ua 客户端提示", "xueqiu.com",
     {"User-Agent": bua, "Accept": "application/json, text/plain, */*",
      "Accept-Language": bal, "X-Requested-With": "XMLHttpRequest", **bsec}),
    ("4 重放浏览器全部头", "xueqiu.com", None),          # None = 用浏览器全部头
    ("5 全部头 + www 域", "www.xueqiu.com", None),
    ("6 全部头 + 域和 Referer 都是 www", "www.xueqiu.com", "__www__"),
]


def build_headers(spec, host):
    if spec is None:
        h = {k: v for k, v in browser.headers.items() if k != "cookie"}
    elif spec == "__www__":
        h = {k: v for k, v in browser.headers.items() if k != "cookie"}
        h["referer"] = "https://www.xueqiu.com/"
        h["origin"] = "https://www.xueqiu.com"
    else:
        h = dict(spec)
    if "referer" not in {k.lower() for k in h}:
        h["Referer"] = f"https://{host}/"
    h["Cookie"] = cookie
    return h


print("\n" + "=" * 70)
print(f"对照实验：{PROBE}  (auth 探针，返回干净 JSON)")
print("=" * 70)

best = None
for label, host, spec in VARIANTS:
    if spec is None and not browser:
        print(f"[{label}] 跳过（没有浏览器请求头）")
        continue
    headers = build_headers(spec, host)
    try:
        r = requests.get(f"https://{host}{PROBE}", params=PROBE_PARAMS,
                         headers=headers, timeout=20)
        ct = r.headers.get("content-type", "")[:32]
        txt = r.text[:200].replace("\n", " ")
        ok = '"success":true' in r.text or '"error_code"' not in r.text
        flag = "  <<< 成功" if ok else ""
        if ok and best is None:
            best = (label, host, spec)
        print(f"[{label}]")
        print(f"   HTTP {r.status_code}  ct={ct}")
        print(f"   {txt}{flag}")
    except Exception as exc:  # noqa: BLE001
        print(f"[{label}] FAIL {type(exc).__name__}: {exc}")
    time.sleep(2.0)

print("\n" + "=" * 70)
print("用成功的组合再试时间线接口（关键：看是否仍是 WAF 页）")
print("=" * 70)
label, host, spec = best if best else ("4 重放浏览器全部头", "xueqiu.com", None)
for tl_path, tl_params in [
    ("/v4/statuses/user_timeline.json", {"user_id": TARGET, "page": 1}),
    ("/v4/statuses/user_timeline.json",
     {"user_id": TARGET, "page": 1, "count": 20}),
    ("/statuses/original/timeline.json", {"user_id": TARGET, "page": 1}),
]:
    headers = build_headers(spec, host)
    try:
        r = requests.get(f"https://{host}{tl_path}", params=tl_params,
                         headers=headers, timeout=20)
        ct = r.headers.get("content-type", "")[:32]
        if "json" in ct.lower():
            body = r.text[:300].replace("\n", " ")
        elif "_waf_" in r.text or "aliyun_waf" in r.text:
            body = "<<阿里云 WAF 挑战页>>"
        else:
            body = r.text.lstrip()[:150].replace("\n", " ")
        print(f"[{tl_path} {tl_params}]")
        print(f"   HTTP {r.status_code}  ct={ct}")
        print(f"   {body}")
    except Exception as exc:  # noqa: BLE001
        print(f"[{tl_path}] FAIL {type(exc).__name__}: {exc}")
    time.sleep(2.5)
