"""SQLite 连接与初始化。"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import Config

SCHEMA_PATH = Path(__file__).with_name("schema.sql")

# 改 schema 时把它 +1，init_db 会检测旧库并给出明确提示
SCHEMA_VERSION = "6"

_DROP_ORDER = [
    "opinion_eval", "opinion", "quote_daily", "alias", "instrument",
    "doc_text", "doc_revision", "doc", "author_profile", "author",
    "run_log", "baseline", "meta",
]


def connect(cfg: Config) -> sqlite3.Connection:
    cfg.db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(cfg.db_path, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA synchronous = NORMAL")
    return con


def reset_db(con: sqlite3.Connection) -> None:
    con.execute("PRAGMA foreign_keys = OFF")
    con.execute("DROP VIEW IF EXISTS v_opinion")
    for table in _DROP_ORDER:
        con.execute(f"DROP TABLE IF EXISTS {table}")
    con.execute("PRAGMA foreign_keys = ON")
    con.commit()


def _table_exists(con: sqlite3.Connection, table: str) -> bool:
    return con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


# 增量迁移：(表, 列, DDL 类型)。只做**追加列**这种向后兼容的改动。
# 为什么需要它：抽取一次要花真金白银（千条观点量级约一两元），
# 为了加个列就把库重置掉是不可接受的。
_MIGRATIONS: list[tuple[str, str, str]] = [
    ("opinion", "evidence_hash", "TEXT"),
    ("opinion", "is_dup", "INTEGER NOT NULL DEFAULT 0"),
    ("author_profile", "persona", "TEXT"),
    ("author", "platforms", "TEXT"),
]


def migrate(con: sqlite3.Connection) -> list[str]:
    """补齐缺失的列。返回迁移说明列表。"""
    done: list[str] = []
    for table, column, ddl in _MIGRATIONS:
        if not _table_exists(con, table):
            continue
        cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
        if column not in cols:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
            done.append(f"{table}.{column}")
    if done:
        con.commit()
    return done


def _detect_schema_mismatch(con: sqlite3.Connection) -> str | None:
    """老库缺**关键**列时报清楚的错，而不是抛 OperationalError。

    注意：可以靠 migrate() 补上的追加列不在这里拦，
    真正不兼容的是像「主键换了」这种没法在线迁移的改动。
    """
    tables = {
        r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    if "opinion" in tables:
        cols = {r[1] for r in con.execute("PRAGMA table_info(opinion)")}
        if "subject_secid" not in cols:
            return "opinion.subject_secid 不存在（旧库用的是 subject_code）"
    if "instrument" in tables:
        cols = {r[1] for r in con.execute("PRAGMA table_info(instrument)")}
        if "secid" not in cols:
            return "instrument.secid 不存在（旧库用 code 做主键）"
        if "exchange" not in cols:
            return "instrument.exchange 不存在（旧库缺交易所字段）"
    return None


def init_db(con: sqlite3.Connection, *, reset: bool = False) -> None:
    if reset:
        reset_db(con)
    else:
        problem = _detect_schema_mismatch(con)
        if problem:
            raise SystemExit(
                f"数据库 schema 与当前代码不匹配：{problem}\n"
                f"当前 schema 版本 {SCHEMA_VERSION}。\n"
                f"请在 initdb 上加 --reset 重建（会清空所有数据）：\n"
                f"    python run.py initdb --reset"
            )
        # 先把可增量补齐的列补上，再跑 schema（否则建索引会失败）
        for item in migrate(con):
            print(f"  · schema 迁移：已补列 {item}")
    con.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    con.execute(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        (SCHEMA_VERSION,),
    )
    con.commit()


@contextmanager
def session(cfg: Config) -> Iterator[sqlite3.Connection]:
    con = connect(cfg)
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()


def upsert_author(con: sqlite3.Connection, source: str, uid: str, name: str,
                  note: str | None, now: str) -> int:
    con.execute(
        """
        INSERT INTO author (source, source_uid, name, note, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (source, source_uid)
        DO UPDATE SET name = excluded.name,
                      note = COALESCE(excluded.note, author.note)
        """,
        (source, uid, name, note, now),
    )
    row = con.execute(
        "SELECT id FROM author WHERE source = ? AND source_uid = ?", (source, uid)
    ).fetchone()
    return int(row["id"])


def upsert_doc(con: sqlite3.Connection, *, author_id: int, source: str,
               external_id: str, kind: str, title: str | None,
               published_at: str, published_date: str, permalink: str | None,
               media_refs: str | None, raw_meta: str | None, now: str) -> int:
    con.execute(
        """
        INSERT INTO doc (author_id, source, external_id, kind, title, published_at,
                         published_date, permalink, media_refs, raw_meta,
                         created_at, last_seen_at, is_deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT (source, external_id)
        DO UPDATE SET title        = excluded.title,
                      published_at = excluded.published_at,
                      published_date = excluded.published_date,
                      permalink    = excluded.permalink,
                      media_refs   = excluded.media_refs,
                      last_seen_at = excluded.last_seen_at,
                      is_deleted   = 0
        """,
        (author_id, source, external_id, kind, title, published_at, published_date,
         permalink, media_refs, raw_meta, now, now),
    )
    row = con.execute(
        "SELECT id FROM doc WHERE source = ? AND external_id = ?",
        (source, external_id),
    ).fetchone()
    return int(row["id"])


def save_revision(con: sqlite3.Connection, doc_id: int, text: str,
                  content_hash: str, now: str) -> bool:
    """保存正文快照。返回 True 表示内容有变化（新增了一个版本）。"""
    cur = con.execute(
        """
        INSERT OR IGNORE INTO doc_revision (doc_id, captured_at, content_hash, text)
        VALUES (?, ?, ?, ?)
        """,
        (doc_id, now, content_hash, text),
    )
    changed = cur.rowcount > 0
    con.execute(
        """
        INSERT INTO doc_text (doc_id, text, char_len) VALUES (?, ?, ?)
        ON CONFLICT (doc_id) DO UPDATE SET text = excluded.text,
                                           char_len = excluded.char_len
        """,
        (doc_id, text, len(text)),
    )
    return changed


def log_run(con: sqlite3.Connection, task: str, started_at: str,
            status: str, detail: str | None = None,
            finished_at: str | None = None) -> None:
    con.execute(
        """INSERT INTO run_log (task, started_at, finished_at, status, detail)
           VALUES (?, ?, ?, ?, ?)""",
        (task, started_at, finished_at, status, detail),
    )
