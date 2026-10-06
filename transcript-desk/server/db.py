"""SQLite 连接与建表。WAL 模式 + 检查外键，所有连接短生命周期。"""
from __future__ import annotations

import os
import sqlite3
import threading
from pathlib import Path

DATA_DIR = Path(os.environ.get("TRANSCRIPT_DESK_HOME")
                or (Path(__file__).resolve().parent.parent / "data"))
DB_PATH = DATA_DIR / "desk.db"

_lock = threading.Lock()


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=15, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=15000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    token        TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'open',          -- open / finalized
    audio_file   TEXT,                                  -- uploads 内文件名
    audio_name   TEXT,
    audio_mime   TEXT,
    audio_size   INTEGER,
    audio_dur    REAL,                                  -- 秒，由前端元数据回填
    created_by   TEXT REFERENCES users(id),
    created_at   INTEGER NOT NULL,
    finalized_at INTEGER
);

CREATE TABLE IF NOT EXISTS segments (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    idx          INTEGER NOT NULL,
    start_ms     INTEGER NOT NULL,
    end_ms       INTEGER NOT NULL,
    original     TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    UNIQUE(project_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_segments_project ON segments(project_id, idx);

-- 每个 (校对员, 分段) 只保留一条：再次提交即更新（仍留下审计日志）
CREATE TABLE IF NOT EXISTS versions (
    id           TEXT PRIMARY KEY,
    segment_id   TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id),
    text         TEXT NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    UNIQUE(segment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id);

-- 合并结果：冲突段的 resolution 必须由人工写定后才允许 finalize
CREATE TABLE IF NOT EXISTS merges (
    segment_id   TEXT PRIMARY KEY REFERENCES segments(id) ON DELETE CASCADE,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    chosen       TEXT NOT NULL,                         -- auto / user_a / user_b / manual / none
    chosen_user  TEXT REFERENCES users(id),
    text         TEXT NOT NULL DEFAULT '',
    conflict     INTEGER NOT NULL DEFAULT 0,
    resolved_by  TEXT REFERENCES users(id),
    resolved_at  INTEGER,
    updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_merges_project ON merges(project_id);

CREATE TABLE IF NOT EXISTS audit_logs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   TEXT,
    user_id      TEXT,
    action       TEXT NOT NULL,
    detail       TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs(project_id, id);

CREATE TABLE IF NOT EXISTS presence (
    user_id      TEXT NOT NULL,
    project_id   TEXT NOT NULL,
    segment_id   TEXT,
    seen_at      INTEGER NOT NULL,
    PRIMARY KEY(user_id, project_id)
);
"""


def init_db() -> None:
    with _lock:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        conn = get_conn()
        try:
            conn.executescript(SCHEMA)
            conn.commit()
        finally:
            conn.close()
