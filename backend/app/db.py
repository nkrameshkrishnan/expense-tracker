"""SQLite access. stdlib sqlite3 rather than an ORM: one user, one file,
no migrations worth the dependency. Schema is created on first run."""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "expenses.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,
    type        TEXT    NOT NULL DEFAULT 'Expense',
    category    TEXT    NOT NULL,
    subcategory TEXT    NOT NULL DEFAULT '',
    description TEXT    NOT NULL DEFAULT '',
    amount      REAL    NOT NULL CHECK (amount > 0),
    payment     TEXT    NOT NULL DEFAULT '',
    account     TEXT    NOT NULL DEFAULT '',
    recurring   TEXT    NOT NULL DEFAULT 'No',
    notes       TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_tx_date     ON transactions(date);
CREATE INDEX IF NOT EXISTS ix_tx_category ON transactions(category);

CREATE TABLE IF NOT EXISTS budget (
    category TEXT    NOT NULL,
    month    INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    amount   REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (category, month)
);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
