from shop import create_order
from shop.orders import service
import shop.pricing.rules
from shop.missing import nothing
from . import nowhere


def handle(payload: dict) -> dict:
    first = create_order(payload["items"], payload["customer"])
    second = service.OrderService(payload["customer"]).place(payload["items"])
    preview = shop.pricing.rules.total(payload["items"], discount=0.1)
    return {"first": first, "second": second, "preview": preview}
