TAX: float = 0.22


def total(items: list[float], discount: float = 0) -> float:
    """Sum of the items, discounted, with tax."""
    return sum(items) * (1 - discount) * (1 + TAX)
