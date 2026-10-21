"""雪球 Cookie 解析回归测试。

跑法：python tests/test_xueqiu_cookie.py

为什么值得单独测：真正的凭证 xq_a_token / xqat 是 HttpOnly，
只能从请求头拿。而请求头里的 Cookie 有 1KB 多，
用户复制时会出现各种形态（cURL 整段 / 带引号 / 带前缀 / 多行）。
解析错了会得到一个"看起来有内容但用不了"的 Cookie，
报错信息还指向错误的方向，非常难排查。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from stocktool.ingest.xueqiu import _clean_cookie, _extract_cookie_from_curl  # noqa: E402

_failures: list[str] = []
_passed = 0


def check(name: str, got, want) -> None:
    global _passed
    if got == want:
        _passed += 1
        print(f"  PASS  {name}")
    else:
        _failures.append(f"{name} :: got={got!r} want={want!r}")
        print(f"  FAIL  {name}\n        got ={got!r}\n        want={want!r}")


# 模拟 Chrome「Copy as cURL (bash)」的完整输出
BASH_CURL = (
    "curl 'https://xueqiu.com/v4/statuses/user_timeline.json?user_id=1&page=1' \\\n"
    "  -H 'accept: application/json, text/plain, */*' \\\n"
    "  -H 'cookie: acw_tc=abc123; xq_a_token=SECRET_A; u=0000000001; "
    "xqat=SECRET_B; device_id=d1' \\\n"
    "  -H 'referer: https://xueqiu.com/' \\\n"
    "  -H 'user-agent: Mozilla/5.0' \\\n"
    "  --compressed"
)

# 模拟「Copy as cURL (cmd)」—— 用双引号
CMD_CURL = 'curl "https://xueqiu.com/x" -H "cookie: xq_a_token=SECRET_C; u=1"'

# 模拟 curl -b
B_CURL = "curl 'https://xueqiu.com/x' -b 'xq_a_token=SECRET_D; u=2'"

EXPECT_BASH = ("acw_tc=abc123; xq_a_token=SECRET_A; u=0000000001; "
               "xqat=SECRET_B; device_id=d1")


def main() -> int:
    print("\n[1] cURL 整段解析（这是主推的获取方式）")
    check("bash 版多行 cURL", _clean_cookie(BASH_CURL), EXPECT_BASH)
    check("cmd 版双引号 cURL", _clean_cookie(CMD_CURL), "xq_a_token=SECRET_C; u=1")
    check("curl -b 简写", _clean_cookie(B_CURL), "xq_a_token=SECRET_D; u=2")
    check("从 cURL 中单独抽函数",
          _extract_cookie_from_curl(BASH_CURL), EXPECT_BASH)

    print("\n[2] 直接粘贴 Cookie 值的各种脏形态")
    check("裸 Cookie 行", _clean_cookie("xq_a_token=S1; u=2"), "xq_a_token=S1; u=2")
    check("带 Cookie: 前缀", _clean_cookie("Cookie: xq_a_token=S1; u=2"),
          "xq_a_token=S1; u=2")
    check("前缀大小写混写", _clean_cookie("COOKIE:  xq_a_token=S1"),
          "xq_a_token=S1")
    check("被单引号包住", _clean_cookie("'xq_a_token=S1'"), "xq_a_token=S1")
    check("被双引号包住", _clean_cookie('"xq_a_token=S1"'), "xq_a_token=S1")
    check("前后有空白", _clean_cookie("   xq_a_token=S1   "), "xq_a_token=S1")

    print("\n[3] 多行：取最后一个有效行（重新粘贴时自动覆盖旧的）")
    check("旧行+新行",
          _clean_cookie("xq_a_token=OLD\n# 注释\nu=1\nxq_a_token=NEW; u=9"),
          "xq_a_token=NEW; u=9")

    print("\n[4] 边界情况")
    check("只有注释 -> None", _clean_cookie("# 说明\n# 更多说明"), None)
    check("空字符串 -> None", _clean_cookie(""), None)
    check("只有空白 -> None", _clean_cookie("   \n\n  "), None)
    check("真 Cookie 里含 = 和 %3D 不被截断",
          _clean_cookie("xq_a_token=a=b%3Dc; u=1"), "xq_a_token=a=b%3Dc; u=1")

    print("\n[5] 关键凭证识别（has_auth_token 依赖它）")
    names = [kv.strip().split("=", 1)[0]
             for kv in (_clean_cookie(BASH_CURL) or "").split(";") if "=" in kv]
    check("解析后含 xq_a_token", "xq_a_token" in names, True)
    check("解析后含 xqat", "xqat" in names, True)
    check("解析后含 u（uid）", "u" in names, True)

    print("\n" + "=" * 60)
    if _failures:
        print(f"失败 {len(_failures)} 项 / 通过 {_passed} 项")
        for f in _failures:
            print(f"  - {f}")
        return 1
    print(f"全部通过（{_passed} 项断言）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
