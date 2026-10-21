"""检视用户粘贴的 cURL 里到底带了哪些请求头（不打印任何凭证值）。"""
import sys
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from stocktool.config import load_config  # noqa: E402

SENSITIVE = {"cookie", "authorization", "xq_a_token", "xqat", "xq_r_token",
             "xq_id_token", "set-cookie"}

cfg = load_config()
path = cfg.root / "config" / "xueqiu_cookie.txt"
raw = path.read_text(encoding="utf-8")
lines = [ln.strip() for ln in raw.splitlines()
         if ln.strip() and not ln.strip().startswith("#")]
print(f"文件里有效行数：{len(lines)}")
for i, ln in enumerate(lines):
    print(f"  行{i+1}: 长度 {len(ln)}，以 {ln[:24]!r} 开头")

curl = " ".join(lines)
is_curl = "curl" in curl.lower()
print(f"\n是否 cURL 形态：{is_curl}")

if is_curl:
    # 抠出 -H 'k: v' 形式的所有头
    heads = re.findall(r"""-H\s+(['"])(.*?)\1""", curl, re.S)
    print(f"\n请求头共 {len(heads)} 个：")
    for _, hv in heads:
        name, _, value = hv.partition(":")
        name = name.strip()
        value = value.strip()
        if name.lower() in SENSITIVE:
            print(f"   {name:22} = <已隐藏，长度 {len(value)}>")
        else:
            shown = value if len(value) <= 90 else value[:90] + "…"
            print(f"   {name:22} = {shown}")

    # Cookie 内部各键的长度，用来发现截断
    import importlib
    xq = importlib.import_module("stocktool.ingest.xueqiu")
    ck = xq.load_cookie(cfg)
    if ck:
        print(f"\nCookie 内部 {len(ck.split(';'))} 个键，各自值长度：")
        for kv in ck.split(";"):
            k, _, v = kv.strip().partition("=")
            flag = ""
            if k in SENSITIVE and len(v) < 16:
                flag = "  <== 偏短，可能被截断"
            print(f"   {k:44} 长度 {len(v):4}{flag}")
else:
    print("\n不是 cURL —— 只提取到了 Cookie 值，没有其他请求头可用。")
