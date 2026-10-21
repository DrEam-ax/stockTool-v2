-- ============================================================
-- stocktool schema  (SQLite)
-- 设计目标：把"大V说了什么"变成"可回测的结构化观点"
--
-- 关键约定：标的用 secid 做主键，不用 6 位代码。
-- 因为 000001 既是深市「平安银行」(0.000001) 又是沪市「上证指数」(1.000001)，
-- 用代码做主键会把指数和个股混在一起，直接污染回测。
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------- 元信息（schema 版本等）----------
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------- 作者 ----------
CREATE TABLE IF NOT EXISTS author (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,              -- 来源平台标识（如 xueqiu / weibo / podcast）
  source_uid  TEXT NOT NULL,              -- 平台内唯一 ID
  name        TEXT NOT NULL,
  note        TEXT,
  -- 同一人在**其他平台**的别名，JSON 数组：
  -- [{"source":"某平台","name":"某别名","note":"该平台上的称呼"}]
  -- 同一个人跨平台 = 一个军师、多份语料：语料要合并，身份要统一，
  -- 而且粉丝会用这些名字直接称呼他，抽取和画像都得认得出。
  platforms   TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (source, source_uid)
);

-- ---------- 原始文档 ----------
CREATE TABLE IF NOT EXISTS doc (
  id             INTEGER PRIMARY KEY,
  author_id      INTEGER NOT NULL REFERENCES author(id),
  source         TEXT NOT NULL,
  external_id    TEXT,                    -- 平台内文档 ID（雪球 status id 等）
  kind           TEXT NOT NULL DEFAULT 'post',
                                          -- post / comment / live_replay / live_segment / community
  title          TEXT,
  published_at   TEXT NOT NULL,           -- ISO8601 本地时间
  published_date TEXT NOT NULL,           -- YYYY-MM-DD，回测对齐用
  permalink      TEXT,
  media_refs     TEXT,                    -- JSON 数组
  raw_meta       TEXT,                    -- JSON 对象
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  is_deleted     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_doc_author  ON doc(author_id);
CREATE INDEX IF NOT EXISTS idx_doc_pubdate ON doc(published_date);
CREATE INDEX IF NOT EXISTS idx_doc_kind    ON doc(kind);

-- ---------- 文档版本快照（防删帖 / 防改帖）----------
CREATE TABLE IF NOT EXISTS doc_revision (
  id           INTEGER PRIMARY KEY,
  doc_id       INTEGER NOT NULL REFERENCES doc(id) ON DELETE CASCADE,
  captured_at  TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  text         TEXT NOT NULL,
  UNIQUE (doc_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_rev_doc ON doc_revision(doc_id);

-- ---------- 当前正文（从最新 revision 冗余，便于全文检索）----------
CREATE TABLE IF NOT EXISTS doc_text (
  doc_id   INTEGER PRIMARY KEY REFERENCES doc(id) ON DELETE CASCADE,
  text     TEXT NOT NULL,
  char_len INTEGER NOT NULL
);

-- ---------- 标的（个股 / 板块ETF / 指数 / 行业概念板块）----------
CREATE TABLE IF NOT EXISTS instrument (
  secid      TEXT PRIMARY KEY,            -- 1.600519 / 0.300750 / 1.512480 / 1.000300
  code       TEXT NOT NULL,               -- 600519（仅展示，可能跨市场重复）
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,               -- stock / fund / index / industry / concept
  market     INTEGER,                     -- 1=沪 0=深/北 90=板块
  exchange   TEXT,                        -- SH / SZ / BJ；板块类为 NULL
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inst_type ON instrument(type);
CREATE INDEX IF NOT EXISTS idx_inst_name ON instrument(name);
CREATE INDEX IF NOT EXISTS idx_inst_code ON instrument(code);

-- ---------- 别名（口语称呼 → 标的）----------
CREATE TABLE IF NOT EXISTS alias (
  alias  TEXT NOT NULL,
  secid  TEXT NOT NULL REFERENCES instrument(secid) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 1.0,
  origin TEXT NOT NULL DEFAULT 'manual',  -- manual / derived
  PRIMARY KEY (alias, secid)
);
CREATE INDEX IF NOT EXISTS idx_alias_alias ON alias(alias);

-- ---------- 结构化观点 ----------
CREATE TABLE IF NOT EXISTS opinion (
  id            INTEGER PRIMARY KEY,
  opinion_key   TEXT NOT NULL UNIQUE,     -- 幂等键：doc + 位置 + 标的
  doc_id        INTEGER NOT NULL REFERENCES doc(id) ON DELETE CASCADE,
  author_id     INTEGER NOT NULL REFERENCES author(id),
  stated_at     TEXT NOT NULL,
  stated_date   TEXT NOT NULL,
  sentence      TEXT NOT NULL,
  char_start    INTEGER,
  char_end      INTEGER,
  subject_raw   TEXT,                     -- 文本中出现的原始写法
  subject_secid TEXT REFERENCES instrument(secid),
  subject_type  TEXT,                     -- stock/industry/concept/index/unresolved
  resolved      INTEGER NOT NULL DEFAULT 0,
  match_conf    REAL,
  polarity      INTEGER NOT NULL,         -- 1 看多 / -1 看空
  strength      INTEGER NOT NULL DEFAULT 3,
  horizon       TEXT,                     -- short / mid / long / unspecified
  thesis        TEXT,                     -- 逻辑要点
  triggers      TEXT,                     -- JSON 数组
  evidence      TEXT,                     -- 原文引用（必须保留）
  extractor     TEXT NOT NULL,            -- rule@1 / llm:deepseek-chat
  confidence    REAL,
  created_at    TEXT NOT NULL,
  -- 同一段话的指纹。大V 会反复顶帖、分别回复不同人，
  -- 生成多条内容相同的帖子。不去重的话样本量虚高、
  -- Wilson 区间变窄、p 值假性显著 —— 实测同一个观点能重复 5 次。
  evidence_hash TEXT,
  is_dup        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_op_evhash ON opinion(evidence_hash);
CREATE INDEX IF NOT EXISTS idx_op_dup    ON opinion(is_dup);
CREATE INDEX IF NOT EXISTS idx_op_author ON opinion(author_id);
CREATE INDEX IF NOT EXISTS idx_op_secid  ON opinion(subject_secid);
CREATE INDEX IF NOT EXISTS idx_op_date   ON opinion(stated_date);
CREATE INDEX IF NOT EXISTS idx_op_doc    ON opinion(doc_id);

-- ---------- 日线行情 ----------
CREATE TABLE IF NOT EXISTS quote_daily (
  secid      TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  open       REAL,
  close      REAL,
  high       REAL,
  low        REAL,
  volume     REAL,
  amount     REAL,
  pct_chg    REAL,
  source     TEXT NOT NULL DEFAULT 'eastmoney',
  PRIMARY KEY (secid, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_quote_date ON quote_daily(trade_date);

-- ---------- 观点回测结果 ----------
CREATE TABLE IF NOT EXISTS opinion_eval (
  id               INTEGER PRIMARY KEY,
  opinion_id       INTEGER NOT NULL REFERENCES opinion(id) ON DELETE CASCADE,
  horizon_days     INTEGER NOT NULL,
  benchmark_secid  TEXT NOT NULL,
  entry_date       TEXT, entry_close REAL,
  exit_date        TEXT, exit_close REAL,
  bench_entry      REAL, bench_exit REAL,
  raw_return       REAL, bench_return REAL, excess_return REAL,
  signed_excess    REAL,                  -- excess * polarity
  hit              INTEGER,               -- signed_excess > 0
  max_adverse      REAL,                  -- 期间最大不利偏移（含方向）
  status           TEXT NOT NULL,         -- ok / pending / no_data
  evaluated_at     TEXT NOT NULL,
  UNIQUE (opinion_id, horizon_days, benchmark_secid)
);
CREATE INDEX IF NOT EXISTS idx_eval_op ON opinion_eval(opinion_id);
CREATE INDEX IF NOT EXISTS idx_eval_hz ON opinion_eval(horizon_days);

-- ---------- 作者画像（"skill"本体，由 LLM 归纳） ----------
-- summary / methodology / known_biases 是知识库最有价值的部分：
-- 它让 App 能解释「他为什么这么说」，而不是只丢一堆历史观点。
CREATE TABLE IF NOT EXISTS author_profile (
  author_id     INTEGER PRIMARY KEY REFERENCES author(id) ON DELETE CASCADE,
  summary       TEXT,
  methodology   TEXT,
  style_tags    TEXT,          -- JSON 数组
  known_biases  TEXT,          -- JSON 数组
  horizon_bias  TEXT,
  focus_subjects TEXT,         -- JSON 数组
  -- 「数字化的他」本体：可迁移的决策框架，不是历史观点清单。
  -- summary/methodology 回答"他是谁"，
  -- persona 回答"遇到没见过的新情况，他会怎么想"。
  persona       TEXT,          -- JSON 对象，结构见 extract/persona.py
  generated_by  TEXT NOT NULL,
  generated_at  TEXT NOT NULL
);

-- ---------- 随机选股基线 ----------
-- 为什么必须有这张表：
--   A 股里中位数个股本来就跑输市值加权的沪深300，
--   随机选股在同一批日期上的"命中率"只有 ~44%，不是 50%。
--   拿 50% 当原假设会把所有大V都判成"显著差于随机"。
--   所以判定必须对着实测基线，而不是对着 50%。
CREATE TABLE IF NOT EXISTS baseline (
  benchmark_secid TEXT NOT NULL,
  horizon_days    INTEGER NOT NULL,
  scope_start     TEXT,
  scope_end       TEXT,
  n               INTEGER NOT NULL,   -- 对照样本数
  hit_rate        REAL NOT NULL,      -- 随机选股+看多 的命中率
  mean_excess     REAL,
  sample_stocks   INTEGER,            -- 抽了多少只股票
  seed            INTEGER,
  computed_at     TEXT NOT NULL,
  PRIMARY KEY (benchmark_secid, horizon_days)
);

-- ---------- 任务日志 ----------
CREATE TABLE IF NOT EXISTS run_log (
  id          INTEGER PRIMARY KEY,
  task        TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,
  detail      TEXT
);

-- ---------- 便捷视图 ----------
DROP VIEW IF EXISTS v_opinion;
CREATE VIEW v_opinion AS
SELECT
  o.id                AS opinion_id,
  a.name              AS author,
  a.source            AS source,
  o.stated_date       AS stated_date,
  o.subject_secid     AS subject_secid,
  COALESCE(i.name, o.subject_raw) AS subject_name,
  o.subject_type      AS subject_type,
  o.resolved          AS resolved,
  o.polarity          AS polarity,
  o.strength          AS strength,
  o.horizon           AS horizon,
  o.sentence          AS sentence,
  o.extractor         AS extractor,
  d.permalink         AS permalink
FROM opinion o
JOIN author a ON a.id = o.author_id
JOIN doc    d ON d.id = o.doc_id
LEFT JOIN instrument i ON i.secid = o.subject_secid;
