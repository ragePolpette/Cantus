package com.shop.db;

import java.util.List;

/** Persists orders. */
public class Store {
    public static final int LIMIT = 100;

    public void save(Object order) {}

    public List<Object> all() { return null; }

    private void flush() {}

    public static class Handle {}
}
