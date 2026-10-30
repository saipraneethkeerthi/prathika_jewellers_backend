import test from "node:test";
import assert from "node:assert/strict";
import { createCartSession } from "../../client/src/cart-session.js";

const product = { _id: "product-1", name: "Ring", price: 100, stock: 5 };

test("authenticated carts load from the server and persist mutations in order", async () => {
  const calls = [];
  const session = createCartSession(async (path, options) => {
    if (!options) return { items: [{ ...product, quantity: 1 }] };
    calls.push(JSON.parse(options.body).items);
    return { ok: true };
  }, "user-1");
  await session.load();
  session.add(product);
  session.setQuantity(product._id, 3);
  await session.settled();
  assert.deepEqual(calls, [
    [{ productId: product._id, quantity: 2 }],
    [{ productId: product._id, quantity: 3 }]
  ]);
  assert.equal(session.getSnapshot().items[0].quantity, 3);
  assert.equal(session.getSnapshot().saving, false);
});

test("guest carts stay in memory and begin empty", async () => {
  let requests = 0;
  const session = createCartSession(async () => { requests++; }, null);
  await session.load();
  session.add(product);
  await session.settled();
  assert.equal(session.getSnapshot().items.length, 1);
  assert.equal(requests, 0);
  const newGuestSession = createCartSession(async () => { requests++; }, null);
  await newGuestSession.load();
  assert.deepEqual(newGuestSession.getSnapshot().items, []);
});

test("failed persistence restores the last server-confirmed cart", async () => {
  const session = createCartSession(async (_path, options) => {
    if (!options) return { items: [{ ...product, quantity: 1 }] };
    throw new Error("offline");
  }, "user-1");
  await session.load();
  session.add(product);
  await session.settled();
  assert.equal(session.getSnapshot().items[0].quantity, 1);
  assert.match(session.getSnapshot().error, /could not be saved/i);
});

test("disposing an old account session prevents late responses from appearing", async () => {
  let resolveLoad;
  const session = createCartSession(() => new Promise((resolve) => { resolveLoad = resolve; }), "user-1");
  const loading = session.load();
  session.dispose();
  resolveLoad({ items: [{ ...product, quantity: 4 }] });
  await loading;
  assert.deepEqual(session.getSnapshot().items, []);
});
