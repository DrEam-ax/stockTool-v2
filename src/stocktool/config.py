"""全局配置。

优先级：环境变量 > config/settings.json > 内置默认值。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# src/stocktool/config.py -> parents[2] == 项目根
ROOT = Path(__file__).resolve().parents[2]

DEFAULT_SETTINGS: dict[str, Any] = {
    "db_path": "data/stocktool.db",
    "data_dir": "data",
    "seed_dir": "data/seed",
    "report_dir": "reports",
    "lexicon_path": "config/lexicon.json",
    "sectors_path": "config/sectors.json",
    # 回测。
    # 必须包含长周期：实测某左侧+长期持有型大V，
    # T+5/20/60 全部"与随机无异"，T+250 却是"显著强于随机"（p=0.000）。
    # 只跑短周期会把这类人误判成没水平 —— 这是本项目踩过的最大的方法论坑。
    "benchmark_secid": "1.000300",          # 沪深300
    "horizons": [5, 20, 60, 250],
    "entry_rule": "next_close",             # next_close | same_day_if_before_close
    "close_hour": 15,                       # same_day_* 规则用的收盘时刻
    "min_samples_for_rank": 10,             # 上绩效榜的最少样本数
    # 行情抓取
    "quote_beg": "20190101",
    "quote_days": 800,                      # 腾讯K线上限约 800 根（免费源的历史深度限制）
    "price_sources": ["tencent", "sina", "eastmoney"],   # 故障转移顺序
    "request_sleep": 0.25,                  # 请求间隔，礼貌限速
    "request_retries": 3,
    "request_timeout": 20,
    # 雪球（风控较严，间隔给足；语料冻结，一次全量归档即可）
    "xueqiu_cookie_file": "config/xueqiu_cookie.txt",
    "xueqiu_host": "xueqiu.com",
    "xueqiu_sleep_min": 2.5,
    "xueqiu_sleep_max": 5.0,
    # LLM 抽取（可选）
    "llm_base_url": "https://api.deepseek.com/v1",
    "llm_model": "deepseek-chat",
    "llm_timeout": 120,
    "llm_api_key_file": "config/llm_api_key.txt",
}

ENV_MAP = {
    "STOCKTOOL_DB": "db_path",
    "STOCKTOOL_BENCHMARK": "benchmark_secid",
    "STOCKTOOL_LLM_BASE_URL": "llm_base_url",
    "STOCKTOOL_LLM_MODEL": "llm_model",
}


@dataclass
class Config:
    values: dict[str, Any] = field(default_factory=dict)
    api_key: str | None = None

    def __getattr__(self, item: str) -> Any:
        try:
            return self.values[item]
        except KeyError as exc:  # pragma: no cover
            raise AttributeError(item) from exc

    # ---- 便捷路径 ----
    @property
    def root(self) -> Path:
        return ROOT

    def path(self, key: str) -> Path:
        raw = Path(str(self.values[key]))
        return raw if raw.is_absolute() else (ROOT / raw)

    @property
    def db_path(self) -> Path:
        return self.path("db_path")

    @property
    def data_dir(self) -> Path:
        return self.path("data_dir")

    @property
    def seed_dir(self) -> Path:
        return self.path("seed_dir")

    @property
    def report_dir(self) -> Path:
        p = self.path("report_dir")
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def lexicon_path(self) -> Path:
        return self.path("lexicon_path")

    @property
    def sectors_path(self) -> Path:
        return self.path("sectors_path")

    @property
    def has_llm(self) -> bool:
        return bool(self.api_key)


def load_config(settings_file: Path | None = None) -> Config:
    values = dict(DEFAULT_SETTINGS)

    candidate = settings_file or (ROOT / "config" / "settings.json")
    if candidate.exists():
        try:
            values.update(json.loads(candidate.read_text(encoding="utf-8")))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"配置文件 JSON 解析失败: {candidate}\n{exc}") from exc

    for env_name, key in ENV_MAP.items():
        if os.environ.get(env_name):
            values[key] = os.environ[env_name]

    # LLM key：环境变量优先，其次读文件（方便不把密钥贴进对话）
    api_key = (
        os.environ.get("STOCKTOOL_LLM_API_KEY")
        or os.environ.get("DEEPSEEK_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
    )
    if not api_key:
        key_file = Path(str(values.get("llm_api_key_file", "config/llm_api_key.txt")))
        if not key_file.is_absolute():
            key_file = ROOT / key_file
        if key_file.exists():
            for line in key_file.read_text(encoding="utf-8").splitlines():
                line = line.strip().strip('"').strip("'")
                if line and not line.startswith("#"):
                    api_key = line
                    break

    return Config(values=values, api_key=api_key)
