from shop import create_order


def test_create():
    assert create_order([1.0], "a")
