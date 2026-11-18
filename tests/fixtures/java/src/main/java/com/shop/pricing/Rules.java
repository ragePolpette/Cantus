package com.shop.pricing;

public final class Rules {
    private Rules() {}

    /** Total of the lines. */
    public static double total(double[] lines) {
        double sum = 0;
        for (double line : lines) sum += line;
        return sum;
    }
}
