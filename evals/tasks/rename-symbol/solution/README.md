# orders

Small helpers for pricing an order.

## API

- `computeOrderTotal(lines)` adds up `price * qty` for every line and returns the sum in cents.
- `calcTotalWithTax(lines, rate)` is `computeOrderTotal` plus tax, rounded to a whole cent.
- `invoiceText(order)` renders an order as plain text (it calls `computeOrderTotal` for the last line).
- `summarize(orders)` totals many orders with `computeOrderTotal`.
