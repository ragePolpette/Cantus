package com.shop.orders;

import java.util.List;
import com.shop.db.Store;
import com.shop.pricing.*;

/** Creates and stores orders. */
public class OrderService implements Auditable {
    private final Store store;

    public OrderService(Store store) { this.store = store; }

    /** Builds an order and saves it. */
    public Order create(String id, double[] lines, Discount discount) {
        double total = discount.apply(Rules.total(lines));
        Order order = new Order(id, total);
        store.save(order);
        return order;
    }

    protected void helper() {}

    private void hidden() {}
}
