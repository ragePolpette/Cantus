package com.shop.web;

import com.shop.orders.Order;
import com.shop.orders.OrderService;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class OrderController {
    private final OrderService service;

    public OrderController(OrderService service) { this.service = service; }

    public Order place(String id) {
        return service.create(id, new double[0], null);
    }
}
