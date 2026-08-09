# Ledger backend — FastAPI + SQLite

Optional. The frontend runs fine without it using IndexedDB.

## Run

```bash
./run.sh
```

Creates `.venv`, installs `requirements.txt`, serves on `http://127.0.0.1:8000`.
Docs at `/docs`. The database is `expenses.db`, created on first start.

## Connect the UI

**Data → Storage backend →** `http://127.0.0.1:8000` → **Connect**.

If it says unreachable, the app silently falls back to browser storage rather than
breaking — check the server is running and that you are not on Safari (which blocks
HTTPS pages from calling `http://localhost`).

## Security

Binds to loopback only, so it is unreachable from your network, which is why there
is no auth. **If you change the host, add authentication first.**

`expenses.db` is gitignored. Do not commit it — it is your financial history.

## Layers

`main.py` routes and CORS · `schemas.py` Pydantic validation · `repository.py` all SQL ·
`db.py` connection and schema · `xlsx_export.py` charted workbook via openpyxl.

Routes never touch a cursor; SQL never leaves the repository.
