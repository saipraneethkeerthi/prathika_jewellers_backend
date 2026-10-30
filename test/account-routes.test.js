import test, { mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createAccountRouter, hashResetToken } from "../src/account-routes.js";
import { User } from "../src/models.js";
import { optionalUser, requireUser, setAuthCookie } from "../src/auth.js";

async function withServer(options, run) {
  const app = express();
  app.use(express.json(), cookieParser());
  app.use("/auth", createAccountRouter(options));
  app.use((error, _req, res, _next) => res.status(error.name === "ZodError" ? 400 : 500).json({ message: "Invalid input" }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/auth`;
  const request = (path, body) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try { await run({ base, request }); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); mock.restoreAll(); }
}

test("reset emails contain a single-use expiring token; reset revokes old sessions", async () => {
  let stored = {};
  let resetUrl;
  mock.method(User, "findOne", async ({ email }) => email === "customer@example.com" ? { id: "customer" } : null);
  mock.method(User, "updateOne", async (_query, update) => { Object.assign(stored, update.$set); });
  mock.method(User, "findOneAndUpdate", async (query, update) => {
    if (stored.passwordResetHash !== query.passwordResetHash || stored.passwordResetExpires <= query.passwordResetExpires.$gt) return null;
    assert.equal(update.$inc.sessionVersion, 1);
    stored = { passwordHash: update.$set.passwordHash };
    return { id: "customer" };
  });
  await withServer({ sendResetEmail: async (mail) => { resetUrl = mail.resetUrl; } }, async ({ request }) => {
    const known = await request("/forgot-password", { email: " CUSTOMER@example.com " });
    const unknown = await request("/forgot-password", { email: "unknown@example.com" });
    assert.equal(known.status, 200);
    assert.deepEqual(await known.json(), await unknown.json());
    const token = new URLSearchParams(new URL(resetUrl).hash.slice(1)).get("reset");
    assert.equal(stored.passwordResetHash, hashResetToken(token));
    assert.notEqual(stored.passwordResetHash, token);
    assert.ok(stored.passwordResetExpires > new Date());
    const success = await request("/reset-password", { token, password: "NewPassword123!" });
    assert.equal(success.status, 200);
    assert.ok(success.headers.get("set-cookie").includes("pj_session="));
    assert.ok(await bcrypt.compare("NewPassword123!", stored.passwordHash));
    assert.equal((await request("/reset-password", { token, password: "OtherPassword123!" })).status, 400);
    assert.equal((await request("/reset-password", { token: "bad", password: "short" })).status, 400);
  });
});

test("expired reset links cannot change the password", async () => {
  mock.method(User, "findOneAndUpdate", async (query) => {
    assert.ok(query.passwordResetExpires.$gt instanceof Date);
    return null;
  });
  await withServer({}, async ({ request }) => {
    assert.equal((await request("/reset-password", { token: "a".repeat(64), password: "NewPassword123!" })).status, 400);
  });
});

test("Google callback checks state and verified identity before issuing a session", async () => {
  process.env.GOOGLE_CLIENT_ID = "test-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.GOOGLE_REDIRECT_URI = "http://localhost:5173/api/auth/google/callback";
  process.env.JWT_SECRET = "test-only-secret-with-more-than-32-characters";
  let authOptions;
  let tokenExchanges = 0;
  let created;
  const client = {
    generateCodeVerifierAsync: async () => ({ codeVerifier: "verifier", codeChallenge: "challenge" }),
    generateAuthUrl: (options) => { authOptions = options; return "https://accounts.google.com/test"; },
    getToken: async (options) => { assert.equal(options.codeVerifier, "verifier"); tokenExchanges++; return { tokens: { id_token: "test-token" } }; },
    verifyIdToken: async ({ audience }) => { assert.equal(audience, "test-client"); return { getPayload: () => ({ sub: "google-sub", email: "customer@gmail.com", email_verified: true, nonce: authOptions.nonce, name: "Google Customer" }) }; }
  };
  mock.method(User, "findOne", async () => null);
  mock.method(User, "create", async (input) => { created = input; return { ...input, id: "customer" }; });
  await withServer({ getGoogleClient: () => client }, async ({ base }) => {
    const start = await fetch(base + "/google", { redirect: "manual" });
    const cookie = start.headers.get("set-cookie").split(";")[0];
    assert.equal(start.status, 302);
    assert.equal(authOptions.code_challenge_method, "S256");
    const badState = await fetch(base + "/google/callback?code=code&state=wrong", { redirect: "manual", headers: { Cookie: cookie } });
    assert.ok(badState.headers.get("location").includes("google_failed"));
    assert.equal(tokenExchanges, 0);
    const callback = await fetch(base + `/google/callback?code=code&state=${authOptions.state}`, { redirect: "manual", headers: { Cookie: cookie } });
    assert.equal(callback.status, 302);
    assert.ok(callback.headers.get("set-cookie").includes("pj_session="));
    assert.equal(created.role, "customer");
    assert.equal(created.googleId, "google-sub");
    assert.ok(callback.headers.get("location").endsWith("/account"));
  });
});

test("password reset invalidates pre-existing JWTs for protected and optional sessions", async () => {
  process.env.JWT_SECRET = "test-only-secret-with-more-than-32-characters";
  const user = { id: "customer", name: "Customer", sessionVersion: 2 };
  mock.method(User, "findById", () => ({ select: async () => user }));
  const token = jwt.sign({ sub: user.id, sv: 1 }, process.env.JWT_SECRET);
  let status;
  await requireUser({ cookies: { pj_session: token } }, { status: (value) => { status = value; return { json() {} }; } }, () => assert.fail("Old session must be rejected"));
  assert.equal(status, 401);
  const req = { cookies: { pj_session: token } };
  await new Promise((resolve) => optionalUser(req, {}, resolve));
  assert.equal(req.user, null);
  let issuedToken;
  setAuthCookie({ cookie: (_name, value) => { issuedToken = value; } }, user);
  assert.equal(jwt.verify(issuedToken, process.env.JWT_SECRET).sv, 2);
  mock.restoreAll();
});
