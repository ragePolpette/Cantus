from __future__ import annotations

from ..pricing import total
from shop.db.store import save
import requests

DEFAULT_CURRENCY = "EUR"


def create_order(items: list[float], customer: str, *, discount: float = 0) -> dict:
    """Creates an order and stores it.

    The total includes the discount."""
    order = {"customer": customer, "total": total(items, discount)}
    save(order)
    return order


class OrderService:
    """Orders for one customer."""

    currency: str

    def __init__(self, customer: str):
        self.customer = customer

    def place(self, items: list[float]) -> dict:
        return create_order(items, self.customer)

    def _audit(self):
        pass


def _helper():
    pass
