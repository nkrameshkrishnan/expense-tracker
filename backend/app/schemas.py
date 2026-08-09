"""Pydantic v2 request/response schemas."""
from datetime import date as Date
from typing import Literal
from pydantic import BaseModel, Field, field_validator

TxType = Literal["Expense", "Income", "Transfer"]


class TransactionBase(BaseModel):
    date: Date
    type: TxType = "Expense"
    category: str = Field(min_length=1, max_length=64)
    subcategory: str = ""
    description: str = ""
    amount: float = Field(gt=0, description="Always positive; `type` carries the sign.")
    payment: str = ""
    account: str = ""
    recurring: Literal["Yes", "No"] = "No"
    notes: str = ""

    @field_validator("amount")
    @classmethod
    def round_cents(cls, v: float) -> float:
        return round(abs(v), 2)


class TransactionCreate(TransactionBase):
    pass


class TransactionUpdate(TransactionBase):
    pass


class TransactionOut(TransactionBase):
    id: int


class BulkResult(BaseModel):
    inserted: int
