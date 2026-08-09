"""Data access. All SQL lives here; routes never touch a cursor."""
from typing import Any
from .db import connect

COLS = ("date", "type", "category", "subcategory", "description",
        "amount", "payment", "account", "recurring", "notes")


def _row(r) -> dict[str, Any]:
    d = dict(r)
    d["date"] = str(d["date"])[:10]
    return d


def list_transactions() -> list[dict]:
    with connect() as c:
        rows = c.execute(
            "SELECT id, date, type, category, subcategory, description, amount, "
            "payment, account, recurring, notes FROM transactions "
            "ORDER BY date DESC, id DESC"
        ).fetchall()
    return [_row(r) for r in rows]


def get_transaction(tid: int) -> dict | None:
    with connect() as c:
        r = c.execute("SELECT * FROM transactions WHERE id = ?", (tid,)).fetchone()
    return _row(r) if r else None


def _values(data: dict) -> tuple:
    return tuple(str(data[k])[:10] if k == "date" else data[k] for k in COLS)


def create_transaction(data: dict) -> dict:
    ph = ", ".join("?" * len(COLS))
    with connect() as c:
        cur = c.execute(f"INSERT INTO transactions ({', '.join(COLS)}) VALUES ({ph})", _values(data))
        tid = cur.lastrowid
    return {**data, "date": str(data["date"])[:10], "id": tid}


def create_many(items: list[dict]) -> int:
    """One transaction, one commit — a partial import is worse than none."""
    ph = ", ".join("?" * len(COLS))
    with connect() as c:
        c.executemany(f"INSERT INTO transactions ({', '.join(COLS)}) VALUES ({ph})",
                      [_values(d) for d in items])
    return len(items)


def update_transaction(tid: int, data: dict) -> dict | None:
    sets = ", ".join(f"{k} = ?" for k in COLS)
    with connect() as c:
        cur = c.execute(f"UPDATE transactions SET {sets} WHERE id = ?", (*_values(data), tid))
        if cur.rowcount == 0:
            return None
    return {**data, "date": str(data["date"])[:10], "id": tid}


def delete_transaction(tid: int) -> bool:
    with connect() as c:
        return c.execute("DELETE FROM transactions WHERE id = ?", (tid,)).rowcount > 0


def delete_all() -> None:
    with connect() as c:
        c.execute("DELETE FROM transactions")
        c.execute("DELETE FROM budget")


def get_budget() -> dict[str, dict[int, float]]:
    with connect() as c:
        rows = c.execute("SELECT category, month, amount FROM budget").fetchall()
    out: dict[str, dict[int, float]] = {}
    for r in rows:
        out.setdefault(r["category"], {})[r["month"]] = r["amount"]
    return out


def set_budget(budget: dict[str, dict]) -> dict:
    payload = [(cat, int(m), float(a or 0)) for cat, months in budget.items()
               for m, a in months.items()]
    with connect() as c:
        c.execute("DELETE FROM budget")
        c.executemany("INSERT INTO budget (category, month, amount) VALUES (?, ?, ?)", payload)
    return get_budget()
