from flask import Blueprint, Flask, jsonify, request

app = Flask(__name__)
orders = Blueprint("orders", __name__, url_prefix="/api/orders")


@orders.route("/", methods=["GET", "POST"])
def orders_root():
    if request.method == "POST":
        return jsonify(created=True)
    return jsonify(items=[])


@orders.get("/<int:order_id>")
def order_detail(order_id):
    return jsonify(id=order_id)


@app.route("/health")
def health():
    return "ok"


app.register_blueprint(orders)
