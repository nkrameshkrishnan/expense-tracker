"""Local expense API — FastAPI + SQLite.

Runs on your machine only. There is no authentication because it binds to
127.0.0.1 by default and is therefore not reachable from the network. If you
ever change the host, add auth first.
"""
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from . import repository as repo
from .db import init
from .schemas import BulkResult, TransactionCreate, TransactionOut, TransactionUpdate
from .xlsx_export import build

# GitHub Pages origins that may call this API. Add your own after forking.
ALLOWED_ORIGIN_REGEX = r"^https://[a-zA-Z0-9-]+\.github\.io$"
ALLOWED_ORIGINS = [
    "http://localhost:8080", "http://127.0.0.1:8080",
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:3000", "http://127.0.0.1:3000",
]
EXPORT_DIR = Path(__file__).resolve().parent.parent / "exports"


@asynccontextmanager
async def lifespan(app: FastAPI):
    init()
    yield


def create_app() -> FastAPI:
    # Idempotent, and deliberately not only in the lifespan hook: any harness that
    # constructs the app without running lifespan would otherwise hit "no such table".
    init()
    app = FastAPI(title="Ledger Expense API", version="1.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_origin_regex=ALLOWED_ORIGIN_REGEX,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "service": "ledger", "version": "1.0.0"}

    @app.get("/api/transactions", response_model=list[TransactionOut])
    def list_all():
        return repo.list_transactions()

    @app.post("/api/transactions", response_model=TransactionOut, status_code=201)
    def create(payload: TransactionCreate):
        return repo.create_transaction(payload.model_dump())

    @app.post("/api/transactions/bulk", response_model=BulkResult, status_code=201)
    def create_bulk(payload: list[TransactionCreate]):
        if not payload:
            raise HTTPException(400, "Empty payload.")
        if len(payload) > 5000:
            raise HTTPException(413, "Import capped at 5000 rows per request.")
        return BulkResult(inserted=repo.create_many([p.model_dump() for p in payload]))

    @app.patch("/api/transactions/{tid}", response_model=TransactionOut)
    def update(tid: int, payload: TransactionUpdate):
        out = repo.update_transaction(tid, payload.model_dump())
        if out is None:
            raise HTTPException(404, f"Transaction {tid} not found.")
        return out

    @app.delete("/api/transactions/{tid}", status_code=204)
    def delete(tid: int):
        if not repo.delete_transaction(tid):
            raise HTTPException(404, f"Transaction {tid} not found.")
        return Response(status_code=204)

    @app.delete("/api/transactions", status_code=204)
    def delete_all():
        repo.delete_all()
        return Response(status_code=204)

    @app.get("/api/budget")
    def get_budget() -> dict:
        return repo.get_budget()

    @app.put("/api/budget")
    def put_budget(payload: dict) -> dict:
        return repo.set_budget(payload)

    @app.get("/api/export/xlsx")
    def export_xlsx(year: int = 2026):
        rows = repo.list_transactions()
        if not rows:
            raise HTTPException(404, "Nothing to export yet.")
        path = build(rows, repo.get_budget(), year, EXPORT_DIR / f"Expense_Tracker_{year}.xlsx")
        return FileResponse(
            path,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename=path.name,
        )

    return app


app = create_app()
