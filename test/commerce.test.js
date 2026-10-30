import test from "node:test";
import assert from "node:assert/strict";
import { calculateOrderAmounts } from "../src/commerce.js";
import { orderInput, productInput, productUpdateInput } from "../src/validation.js";

test("shipping is complimentary at the configured threshold", () => {
  assert.deepEqual(calculateOrderAmounts([{ unitPrice: 1999, quantity: 1 }], { flatRate: 99, freeShippingThreshold: 1999 }), {
    subtotal: 1999,
    shipping: 0,
    total: 1999
  });
});

test("shipping is charged below the configured threshold", () => {
  assert.deepEqual(calculateOrderAmounts([{ unitPrice: 899, quantity: 2 }], { flatRate: 99, freeShippingThreshold: 1999 }), {
    subtotal: 1798,
    shipping: 99,
    total: 1897
  });
});

test("product prices reject an MRP below the selling price", () => {
  const result = productInput.safeParse({ name: "Fine chain", sku: "PJ-01", price: 1200, mrp: 900 });
  assert.equal(result.success, false);
});

test("product schema supports partial admin edits", () => {
  const result = productUpdateInput.safeParse({ price: 1200 });
  assert.equal(result.success, true);
});

test("checkout validates Indian mobile numbers and PIN codes", () => {
  const checkout = {
    customer: { name: "A Customer", email: "customer@example.com", phone: "9876543210" },
    address: { line1: "14 Market Road", city: "Chennai", state: "Tamil Nadu", pinCode: "600001" },
    items: [{ productId: "product-id", quantity: 1 }],
    paymentMethod: "cod"
  };
  assert.equal(orderInput.safeParse(checkout).success, true);
  assert.equal(orderInput.safeParse({ ...checkout, customer: { ...checkout.customer, phone: "123" } }).success, false);
  assert.equal(orderInput.safeParse({ ...checkout, address: { ...checkout.address, pinCode: "000000" } }).success, false);
  assert.equal(orderInput.safeParse({ ...checkout, account: { password: "GuestPass123!" } }).success, true);
  assert.equal(orderInput.safeParse({ ...checkout, account: { password: "short" } }).success, false);
});
