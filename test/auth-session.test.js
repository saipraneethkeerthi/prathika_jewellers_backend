import test from "node:test";
import assert from "node:assert/strict";
import { createAuthSession } from "../../client/src/auth-session.js";

test("sign-out publishes immediately after success and ignores an older session response", async () => {
  let resolveSession;
  const session = createAuthSession(async (path) => {
    if (path === "/auth/me") return new Promise((resolve) => { resolveSession = resolve; });
    if (path === "/auth/login") return { user: { name: "Customer", role: "customer" } };
    return { ok: true };
  });
  let updates = 0;
  session.subscribe(() => updates++);
  await session.signIn("login", {});
  const staleRefresh = session.refresh();
  await session.signOut();
  assert.equal(session.getSnapshot(), null);
  resolveSession({ user: { name: "Old session", role: "admin" } });
  await staleRefresh;
  assert.equal(session.getSnapshot(), null);
  assert.equal(updates, 2);
});

test("failed sign-out retains the current user and reports the error", async () => {
  const user = { name: "Customer" };
  const session = createAuthSession(async (path) => {
    if (path === "/auth/logout") throw new Error("Network unavailable");
    return { user };
  });
  await session.refresh();
  await assert.rejects(session.signOut(), /Network unavailable/);
  assert.equal(session.getSnapshot(), user);
});

test("a delayed anonymous response cannot overwrite a successful login", async () => {
  let resolveSession;
  const user = { name: "Customer" };
  const session = createAuthSession(async (path) => path === "/auth/me"
    ? new Promise((resolve) => { resolveSession = resolve; }) : { user });
  const refresh = session.refresh();
  await session.signIn("login", {});
  resolveSession({ user: null });
  await refresh;
  assert.equal(session.getSnapshot(), user);
});
