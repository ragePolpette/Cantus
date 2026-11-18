import sqlite3
import os.path

_connection = None


def save(order: dict) -> None:
    connection = sqlite3.connect(os.path.join("data", "shop.db"))
    connection.execute("insert into orders values (?)", (str(order),))
