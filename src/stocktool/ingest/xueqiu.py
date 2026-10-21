"""雪球采集器。

设计前提（这个前提让实现简单很多）：
  目标账号的雪球语料是**冻结的**（最后一条帖子之后不再更新）。
  所以这是一次性的全量归档，不需要 Cookie 续期、增量抓取、长期调度。
  相应的取舍是：**宁可慢，也要抓全**，并且把原始 JSON 落盘永久保存 ——
  因为以后大概率没有第二次机会重新抓。

反爬现状（实测）：
  - 匿名会话只有 acw_tc，没有 xq_a_token，接口返回 code 400016
  - search/status.json 会返回阿里云 WAF 的混淆 JS 挑战页
  所以必须带登录 Cookie，且必须限速。

Cookie 获取方式（见 README）：浏览器登录雪球后，
DevTools -> Network -> 任意请求 -> 复制完整 Cookie 请求头。
"""

from __future__ import annotations

import html
import json
import random
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import requests

from ..models import RawDoc
from .base import Adapter

BASE = "https://xueqiu.com"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")

_TAG = re.compile(r"<[^>]+>")
_BLOCK_END = re.compile(r"</(p|div|li|h[1-6]|blockquote|tr)>", re.I)
_BR = re.compile(r"<br\s*/?>", re.I)
_MULTI_NL = re.compile(r"\n{3,}")


class XueqiuAuthError(RuntimeError):
    """登录态无效或缺失。"""


class XueqiuWAFError(RuntimeError):
    """被风控拦截（返回的不是 JSON）。"""


def html_to_text(raw: str) -> str:
    """雪球正文是 HTML。剥标签即可 —— cashtag 在 <a> 里，剥完正好保留 $名称(SH600519)$。"""
    if not raw:
        return ""
    s = _BR.sub("\n", raw)
    s = _BLOCK_END.sub("\n", s)
    s = _TAG.sub("", s)
    s = html.unescape(s)
    s = s.replace("\u3000", " ").replace("\xa0", " ")
    s = "\n".join(line.strip() for line in s.split("\n"))
    return _MULTI_NL.sub("\n\n", s).strip()


class XueqiuClient:
    def __init__(self, cfg, cookie: str, browser: CurlRequest | None = None):
        self.cfg = cfg
        self.timeout = int(cfg.values.get("request_timeout", 20))
        self.retries = int(cfg.values.get("request_retries", 3))
        # 雪球风控较严，默认给足间隔
        self.sleep_min = float(cfg.values.get("xueqiu_sleep_min", 2.5))
        self.sleep_max = float(cfg.values.get("xueqiu_sleep_max", 5.0))
        self.host = str(cfg.values.get("xueqiu_host", "xueqiu.com"))
        self.browser = browser

        headers: dict[str, str] = {
            "User-Agent": UA,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "X-Requested-With": "XMLHttpRequest",
        }

        # 重放浏览器指纹。
        # 雪球会把 token 和客户端指纹关联，UA 不一致会直接拿到 400016，
        # 所以浏览器当时用什么 UA / 语言 / 客户端提示，我们就照抄。
        if browser:
            bh = browser.headers
            if bh.get("user-agent"):
                headers["User-Agent"] = bh["user-agent"]
            if bh.get("accept-language"):
                headers["Accept-Language"] = bh["accept-language"]
            for key, value in bh.items():
                # sec-ch-ua* 是浏览器级指纹，稳定，照抄
                if key.startswith("sec-ch-ua"):
                    headers[key] = value
            if browser.host:
                # 用户是在 www.xueqiu.com 上取的凭据，就用同一个域
                self.host = browser.host

        headers["Referer"] = f"https://{self.host}/"
        headers["Cookie"] = cookie.strip()

        self.session = requests.Session()
        self.session.headers.update(headers)
        self.request_count = 0

    # ---------- 底层 ----------
    def _sleep(self) -> None:
        time.sleep(random.uniform(self.sleep_min, self.sleep_max))

    def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        url = path if path.startswith("http") else f"https://{self.host}{path}"
        last: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                resp = self.session.get(url, params=params, timeout=self.timeout)
                self.request_count += 1
                ctype = resp.headers.get("content-type", "")
                body = resp.text

                if "json" not in ctype.lower():
                    # WAF 挑战页或登录页
                    head = body.lstrip()[:120].replace("\n", " ")
                    if "_waf_" in body or "aliyun_waf" in body:
                        raise XueqiuWAFError(
                            f"被阿里云 WAF 拦截（第 {attempt} 次）。"
                            "通常是请求过快或 Cookie 失效。"
                        )
                    raise XueqiuAuthError(
                        f"返回的不是 JSON（可能是登录页）。HTTP {resp.status_code} "
                        f"content-type={ctype[:60]} body={head!r}"
                    )

                payload = resp.json()
                if isinstance(payload, dict) and payload.get("success") is False:
                    code = payload.get("code")
                    if code in (400016, 400, 401):
                        raise XueqiuAuthError(
                            f"登录态无效：code={code} message={payload.get('message')!r}。"
                            "请重新复制浏览器 Cookie。"
                        )
                return payload
            except (XueqiuAuthError, XueqiuWAFError):
                raise
            except Exception as exc:  # noqa: BLE001
                last = exc
                if attempt < self.retries:
                    back = self.sleep_min * (3 ** attempt)
                    print(f"    … 请求异常，{back:.1f}s 后重试（{attempt}/{self.retries}）")
                    time.sleep(back)
        raise RuntimeError(f"请求失败 {url} params={params}: {last}") from last

    def _get_paged(self, path: str, params: dict[str, Any]) -> Any:
        try:
            return self._get(path, params)
        finally:
            self._sleep()

    # ---------- 接口 ----------
    @property
    def self_uid(self) -> str | None:
        """从 Cookie 里读当前登录用户的 uid。"""
        for kv in self.session.headers.get("Cookie", "").split(";"):
            k, _, v = kv.strip().partition("=")
            if k == "u" and v:
                return v
        return None

    @property
    def token_names(self) -> list[str]:
        return [kv.strip().split("=", 1)[0]
                for kv in self.session.headers.get("Cookie", "").split(";")
                if "=" in kv]

    def has_auth_token(self) -> bool:
        """xq_a_token / xqat 是真正的凭证，且是 HttpOnly。"""
        names = set(self.token_names)
        return bool(names & {"xq_a_token", "xqat"})

    def verify_auth(self) -> dict:
        """用搜索接口验证登录态。

        未登录时雪球返回 {"code":400016,"success":false}，
        所以「能搜出结果」本身就证明登录态有效。
        （不用 /v4/user/show.json —— 实测该路径已返回 404。）
        """
        payload = self._get_paged("/query/v1/search/user.json",
                                  {"q": "雪球", "count": 1, "page": 1})
        if isinstance(payload, dict) and isinstance(payload.get("list"), list):
            return {"screen_name": self.self_uid or "(未知)", "id": self.self_uid}
        raise XueqiuAuthError(f"登录态校验未通过：{str(payload)[:200]}")

    def search_user(self, name: str, count: int = 10) -> list[dict]:
        payload = self._get_paged("/query/v1/search/user.json",
                                  {"q": name, "count": count, "page": 1})
        for key in ("list", "users", "data"):
            items = payload.get(key) if isinstance(payload, dict) else None
            if isinstance(items, list):
                return items
        return []

    def user_profile(self, uid: str) -> dict:
        return self._get_paged("/statuses/show.json", {"user_id": uid})

    def timeline(self, uid: str, page: int, count: int = 20) -> dict:
        """用户时间线（含转发）。返回原始 payload。"""
        return self._get_paged("/v4/statuses/user_timeline.json",
                               {"user_id": uid, "page": page, "count": count})

    def status_detail(self, status_id: str) -> dict:
        return self._get_paged("/statuses/show.json", {"id": status_id})

    def comments(self, status_id: str, page: int = 1, count: int = 20) -> dict:
        return self._get_paged("/statuses/comments.json",
                               {"id": status_id, "page": page, "count": count})


# ---------------------------------------------------------------- 转换

def _ts_to_iso(ms: Any) -> str:
    try:
        ts = int(ms) / 1000
    except (TypeError, ValueError):
        return datetime.now().isoformat(timespec="seconds")
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone().isoformat(
        timespec="seconds")


def status_to_rawdoc(status: dict, author_uid: str, author_name: str,
                     *, kind: str = "post") -> RawDoc | None:
    sid = status.get("id")
    if not sid:
        return None

    text = html_to_text(status.get("text") or "")
    description = html_to_text(status.get("description") or "")
    title = (status.get("title") or "").strip()

    body = text or description
    if title:
        body = f"{title}\n\n{body}" if body else title
    if not body.strip():
        return None

    retweeted = status.get("retweeted_status")
    is_retweet = bool(retweeted)
    if is_retweet:
        # 转发帖：把被转内容也留下来，否则"他转了什么"这个信息就丢了
        rt_author = ((retweeted or {}).get("user") or {}).get("screen_name", "")
        rt_text = html_to_text((retweeted or {}).get("text") or "")
        if rt_text:
            body = f"{body}\n\n【转发 @{rt_author}】\n{rt_text}"

    target = status.get("target") or ""
    permalink = f"{BASE}{target}" if target.startswith("/") else f"{BASE}/u/{author_uid}"

    return RawDoc(
        source="xueqiu",
        author_uid=str(author_uid),
        author_name=author_name,
        published_at=_ts_to_iso(status.get("created_at")),
        text=body.strip(),
        external_id=str(sid),
        kind="retweet" if is_retweet else kind,
        title=title or None,
        permalink=permalink,
        raw_meta={
            "reply_count": status.get("reply_count"),
            "like_count": status.get("like_count"),
            "retweet_count": status.get("retweet_count"),
            "view_count": status.get("view_count"),
            "truncated": status.get("truncated"),
            "is_retweet": is_retweet,
            "target": target,
        },
    )


# ---------------------------------------------------------------- Adapter

class XueqiuAdapter(Adapter):
    name = "xueqiu"

    def __init__(self, cfg, cookie: str | None = None,
                 browser: CurlRequest | None = None):
        self.cfg = cfg
        self.browser = browser if browser is not None else load_browser_request(cfg)
        self.cookie = cookie or load_cookie(cfg)
        if not self.cookie:
            raise XueqiuAuthError(
                "缺少雪球 Cookie。设置环境变量 STOCKTOOL_XUEQIU_COOKIE，"
                "或写入 config/xueqiu_cookie.txt，或用 --cookie 传入。"
            )
        self.client = XueqiuClient(cfg, self.cookie, self.browser)
        self.raw_dir = cfg.data_dir / "raw" / "xueqiu"
        self.raw_dir.mkdir(parents=True, exist_ok=True)

    def resolve_uid(self, who: str, expect_name: str | None = None) -> tuple[str, str]:
        """who 可以是纯数字 uid，也可以是昵称。返回 (uid, screen_name)。"""
        who = who.strip()
        if who.isdigit():
            return who, (expect_name or who)

        print(f"  搜索用户「{who}」…")
        users = self.client.search_user(who)
        if not users:
            raise SystemExit(f"搜不到用户「{who}」。可以改用数字 uid。")

        exact = [u for u in users if (u.get("screen_name") or "").strip() == who]
        if not exact:
            print("  ! 没有完全匹配的账号，候选如下：")
            for u in users[:8]:
                print(f"      uid={u.get('id')}  {u.get('screen_name')}  "
                      f"粉丝={u.get('followers_count')}")
            raise SystemExit(
                "  为避免抓错人，已中止。请用数字 uid 精确指定。")
        picked = exact[0]
        uid = str(picked.get("id") or picked.get("user_id") or "")
        name = picked.get("screen_name") or who
        if not uid:
            raise SystemExit(
                f"搜索结果里没有 uid：{json.dumps(picked, ensure_ascii=False)[:200]}")
        return uid, name

    def verify_author(self, statuses: list[dict], uid: str,
                      expect_name: str | None = None) -> str:
        """用时间线返回的作者信息确认账号身份。

        抓错人是这类归档最难事后发现的错误 —— 抓了几百条，
        抽了观点，跑了回测，最后发现整个语料库是别人的。
        所以这里不一致就直接中止，不给自己留侥幸。
        """
        if not statuses:
            return ""
        author = statuses[0].get("user") or {}
        actual_uid = str(author.get("id") or "")
        actual_name = (author.get("screen_name") or "").strip()

        print(f"  账号确认：{actual_name or '(无名)'}  uid={actual_uid or '(无)'}")
        if actual_uid and actual_uid != str(uid):
            raise SystemExit(
                f"! uid 不一致：请求 {uid}，但接口返回的是 {actual_uid}。已中止。")
        if expect_name and actual_name and actual_name != expect_name.strip():
            raise SystemExit(
                f"! 账号名不匹配：期望「{expect_name}」，实际「{actual_name}」。\n"
                f"  已中止 —— 宁可停下问清楚，也不要抓错人的语料。")
        if expect_name and actual_name == expect_name.strip():
            print(f"  OK  与预期账号名「{expect_name}」一致")
        return actual_name

    def fetch(self, *, who: str, expect_name: str | None = None,
              max_pages: int = 500,
              with_comments: bool = False,
              dump_raw: bool = True) -> Iterator[RawDoc]:
        uid, name = self.resolve_uid(who)
        print(f"  目标账号：{name} (uid={uid})")

        seen: set[str] = set()
        page = 1
        max_page_seen = None
        author_checked = False

        while page <= max_pages:
            print(f"  第 {page} 页…", end="", flush=True)
            payload = self.client.timeline(uid, page)

            if dump_raw:
                dump = self.raw_dir / f"{uid}_page_{page:04d}.json"
                dump.write_text(
                    json.dumps(payload, ensure_ascii=False, indent=1),
                    encoding="utf-8")

            statuses = payload.get("statuses") or []
            if max_page_seen is None:
                max_page_seen = payload.get("maxPage")
            print(f" {len(statuses)} 条（maxPage={max_page_seen}）")

            if not statuses:
                break

            if not author_checked:
                confirmed = self.verify_author(statuses, uid, expect_name)
                if confirmed:
                    name = confirmed
                author_checked = True

            fresh = 0
            for st in statuses:
                sid = str(st.get("id") or "")
                if not sid or sid in seen:
                    continue
                seen.add(sid)
                fresh += 1

                # 被截断的长文单独取全文
                if st.get("truncated"):
                    try:
                        detail = self.client.status_detail(sid)
                        if isinstance(detail, dict) and detail.get("id"):
                            st = {**st, **detail}
                    except Exception as exc:  # noqa: BLE001
                        print(f"    ! 取全文失败 {sid}: {type(exc).__name__}")

                doc = status_to_rawdoc(st, uid, name)
                if doc:
                    yield doc

                if with_comments and (st.get("reply_count") or 0) > 0:
                    yield from self._comments(st, uid, name)

            if fresh == 0:
                print("  ! 本页没有新内容，判定已到末尾")
                break
            if max_page_seen and page >= int(max_page_seen):
                print(f"  已到最后一页（maxPage={max_page_seen}）")
                break
            page += 1

        print(f"  共抓取 {len(seen)} 条，原始 JSON 已存入 {self.raw_dir}")

    def _comments(self, status: dict, uid: str, name: str) -> Iterator[RawDoc]:
        sid = str(status.get("id"))
        page = 1
        while page <= 20:
            try:
                payload = self.client.comments(sid, page)
            except Exception as exc:  # noqa: BLE001
                print(f"    ! 评论抓取失败 {sid}: {type(exc).__name__}")
                return
            items = (payload.get("comments") or []) if isinstance(payload, dict) else []
            if not items:
                return
            for c in items:
                # 只保留作者本人的评论（别人的评论不是"他的产出"）
                if str(c.get("user_id")) != str(uid):
                    continue
                text = html_to_text(c.get("text") or "")
                if not text.strip():
                    continue
                yield RawDoc(
                    source="xueqiu",
                    author_uid=str(uid),
                    author_name=name,
                    published_at=_ts_to_iso(c.get("created_at")),
                    text=text,
                    external_id=f"{sid}_c{c.get('id')}",
                    kind="comment",
                    permalink=f"{BASE}/u/{uid}",
                    raw_meta={"parent_status": sid,
                              "like_count": c.get("like_count")},
                )
            page += 1


_CURL_COOKIE = re.compile(
    r"""(?:-H|--header)\s+(['"])cookie:\s*(.*?)\1""", re.I | re.S)
_CURL_B = re.compile(r"""-b\s+(['"])(.*?)\1""", re.S)


@dataclass
class CurlRequest:
    """浏览器「Copy as cURL」解析结果。

    为什么要完整解析而不是只抠 Cookie：
    雪球的反爬会把 token 绑定到客户端指纹上。用 Edge 签发的 token
    配一个自己拼的 Chrome UA 去请求，会被判定为 token 无效（400016）。
    所以必须把浏览器当时发的请求头**原样重放**。
    """

    url: str = ""
    headers: dict[str, str] = field(default_factory=dict)   # 键统一小写
    cookie: str = ""

    @property
    def host(self) -> str:
        m = re.match(r"https?://([^/]+)", self.url)
        return m.group(1) if m else ""


def _tokenize_shell(s: str) -> list[str]:
    """按 shell 引号规则切词。"""
    tokens: list[str] = []
    cur: list[str] = []
    quote: str | None = None
    for ch in s:
        if quote:
            if ch == quote:
                quote = None
            else:
                cur.append(ch)
        elif ch in "'\"":
            quote = ch
        elif ch.isspace():
            if cur:
                tokens.append("".join(cur))
                cur = []
        else:
            cur.append(ch)
    if cur:
        tokens.append("".join(cur))
    return tokens


def parse_curl(raw: str) -> CurlRequest | None:
    """解析整段 cURL 命令。不是 cURL 就返回 None。"""
    text = str(raw)
    # 去掉行尾续行符
    text = re.sub(r"\\\s*\r?\n", " ", text)
    text = re.sub(r"\^\s*\r?\n", " ", text)          # cmd 版续行
    if "curl" not in text.lower():
        return None

    # 只取 curl 开头的那一段（文件里可能有注释或多行内容）
    start = text.lower().find("curl")
    text = text[start:]

    tokens = _tokenize_shell(text)
    req = CurlRequest()
    i = 1                                          # 跳过 "curl"
    while i < len(tokens):
        tok = tokens[i]
        low = tok.lower()
        if low in ("-h", "--header") and i + 1 < len(tokens):
            name, _, value = tokens[i + 1].partition(":")
            name = name.strip().lower()
            value = value.strip()
            if name == "cookie":
                req.cookie = value
            elif name:
                req.headers[name] = value
            i += 2
            continue
        if low in ("-b", "--cookie") and i + 1 < len(tokens):
            req.cookie = tokens[i + 1].strip()
            i += 2
            continue
        if low == "--url" and i + 1 < len(tokens):
            req.url = tokens[i + 1].strip()
            i += 2
            continue
        if tok.startswith("http") and not req.url:
            req.url = tok.strip()
            i += 1
            continue
        i += 1

    return req if (req.url or req.cookie) else None


def _extract_cookie_from_curl(raw: str) -> str | None:
    req = parse_curl(raw)
    return req.cookie or None if req else None


def _clean_cookie(raw: str) -> str | None:
    """容忍常见的复制错误：cURL 命令、引号、'Cookie:' 前缀、注释行、多余换行。

    多行时**取最后一个有效行** —— 用户重新粘贴时通常是追加在旧的那行下面，
    取最后一行能自动生效，不需要手动删旧的。
    """
    lines = [ln.strip() for ln in str(raw).splitlines()]
    lines = [ln for ln in lines if ln and not ln.startswith("#")]
    if not lines:
        return None

    joined = " ".join(lines)
    if "curl" in joined.lower():
        extracted = _extract_cookie_from_curl(joined)
        if extracted:
            return extracted

    s = lines[-1].strip()
    if s.lower().startswith("cookie:"):
        s = s.split(":", 1)[1].strip()
    s = s.strip().strip('"').strip("'").strip()
    return s or None


def docs_from_dump(path: Path, *, author_name: str | None = None,
                   expect_uid: str | None = None,
                   expect_name: str | None = None) -> tuple[list[RawDoc], dict]:
    """把浏览器控制台导出的 JSON 转成 RawDoc。

    这是目前唯一可用的采集通道：雪球上了阿里云 WAF 的 JS 挑战，
    外部 HTTP 客户端一律被拒（400016），只有真实浏览器能拿到数据。
    所以流程是「浏览器里跑脚本导出 JSON -> 这里导入」。

    返回 (文档列表, 元信息)。身份不符会直接抛 SystemExit。
    """
    path = Path(path)
    raw = json.loads(path.read_text(encoding="utf-8"))

    meta: dict = {"file": str(path)}
    if isinstance(raw, list):
        statuses = raw
        uid = None
    elif isinstance(raw, dict):
        statuses = raw.get("statuses") or raw.get("list") or []
        uid = str(raw.get("uid") or "") or None
        meta.update({k: raw.get(k) for k in
                     ("_source", "_harvested_at", "endpoint", "maxPage", "count")
                     if k in raw})
    else:
        raise SystemExit(f"无法识别的 JSON 结构：{type(raw).__name__}")

    if not statuses:
        raise SystemExit(f"{path} 里没有 statuses 数据")

    # 用返回数据里的作者信息确认身份 —— 这是唯一的权威来源
    author = (statuses[0].get("user") or {})
    actual_uid = str(author.get("id") or "") or uid
    actual_name = (author.get("screen_name") or "").strip()

    meta["author_uid"] = actual_uid
    meta["author_name"] = actual_name

    if expect_uid and actual_uid and str(expect_uid) != actual_uid:
        raise SystemExit(
            f"! uid 不匹配：期望 {expect_uid}，文件里是 {actual_uid}。已中止。")
    if expect_name and actual_name and actual_name != expect_name.strip():
        raise SystemExit(
            f"! 昵称不匹配：期望「{expect_name}」，文件里是「{actual_name}」。已中止。")

    name = actual_name or author_name or actual_uid or "unknown"
    docs: list[RawDoc] = []
    for st in statuses:
        doc = status_to_rawdoc(st, actual_uid or "unknown", name)
        if doc:
            doc.raw_meta["origin"] = "xueqiu_console_dump"
            docs.append(doc)
    meta["parsed"] = len(docs)
    meta["total_statuses"] = len(statuses)
    return docs, meta


def load_cookie(cfg) -> str | None:
    import os
    env = os.environ.get("STOCKTOOL_XUEQIU_COOKIE")
    if env and _clean_cookie(env):
        return _clean_cookie(env)
    return load_cookie_text(cfg) and _clean_cookie(load_cookie_text(cfg))


def load_cookie_text(cfg) -> str | None:
    """读取 Cookie 文件原文（可能是整段 cURL）。"""
    path = Path(cfg.values.get("xueqiu_cookie_file", "config/xueqiu_cookie.txt"))
    if not path.is_absolute():
        path = cfg.root / path
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def load_browser_request(cfg) -> CurlRequest | None:
    """如果用户贴的是整段 cURL，取出浏览器的完整请求头用于重放。"""
    text = load_cookie_text(cfg)
    if not text:
        return None
    lines = [ln.rstrip() for ln in text.splitlines()
             if ln.strip() and not ln.strip().startswith("#")]
    if not lines:
        return None
    req = parse_curl(" ".join(lines))
    return req if (req and req.cookie) else None
