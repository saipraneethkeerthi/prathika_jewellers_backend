import crypto from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { User } from "./models.js";
import { clearAuthCookie, cookieOptions, setAuthCookie } from "./auth.js";

export const hashResetToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const emailInput = z.string().trim().toLowerCase().email().max(254);
const genericResetMessage = "If an account uses that email address, you will receive a password reset link. Check your inbox and spam folder.";
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const googleReady = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
const mailReady = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
const clientOrigin = () => new URL(process.env.CLIENT_ORIGIN || "http://localhost:5173").origin;
const googleClient = () => new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);

export function createAccountRouter({ sendResetEmail, getGoogleClient = googleClient } = {}) {
  const router = Router();
  router.get("/config", (_req, res) => res.json({ googleEnabled: googleReady(), passwordResetEnabled: mailReady() }));
  const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false, message: { message: "Too many reset attempts. Please try again in 15 minutes." } });
  router.post("/forgot-password", resetLimiter, asyncRoute(async (req, res) => {
    const email = emailInput.parse(req.body.email);
    if (!mailReady() && !sendResetEmail) return res.status(503).json({ message: "Password reset email is currently unavailable. Please contact the store." });
    const user = await User.findOne({ email });
    if (user) {
      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashResetToken(token);
      await User.updateOne({ _id: user.id }, { $set: { passwordResetHash: tokenHash, passwordResetExpires: new Date(Date.now() + 30 * 60 * 1000) } });
      const resetUrl = `${clientOrigin()}/account#reset=${token}`;
      try {
        if (sendResetEmail) await sendResetEmail({ email, resetUrl });
        else {
          const transport = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 587),
            secure: process.env.SMTP_SECURE === "true",
            requireTLS: process.env.SMTP_SECURE !== "true",
            connectionTimeout: 10000,
            socketTimeout: 15000,
            ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } } : {})
          });
          await transport.sendMail({ from: process.env.SMTP_FROM, to: email, subject: "Reset your Prathika Jewellers password", text: `Reset your password using this link:\n\n${resetUrl}\n\nThis link expires in 30 minutes and can be used once. If you did not request this, you can ignore this email.` });
        }
      } catch {
        await User.updateOne({ _id: user.id, passwordResetHash: tokenHash }, { $unset: { passwordResetHash: 1, passwordResetExpires: 1 } });
        console.error("Password reset email could not be delivered. Check SMTP configuration and availability.");
      }
    }
    res.json({ message: genericResetMessage });
  }));
  router.post("/reset-password", resetLimiter, asyncRoute(async (req, res) => {
    const input = z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), password: z.string().min(10).max(100) }).parse(req.body);
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await User.findOneAndUpdate({ passwordResetHash: hashResetToken(input.token), passwordResetExpires: { $gt: new Date() } }, { $set: { passwordHash }, $inc: { sessionVersion: 1 }, $unset: { passwordResetHash: 1, passwordResetExpires: 1 } });
    if (!user) return res.status(400).json({ message: "This reset link is invalid or has expired. Please request a new one." });
    clearAuthCookie(res);
    res.json({ message: "Your password has been updated. Please sign in with your new password." });
  }));

  const oauthCookie = () => ({ ...cookieOptions(), maxAge: 10 * 60 * 1000 });
  router.get("/google", asyncRoute(async (_req, res) => {
    if (!googleReady()) return res.redirect(`${clientOrigin()}/account?auth_error=google_unavailable`);
    const client = getGoogleClient();
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = crypto.randomBytes(32).toString("hex");
    const nonce = crypto.randomBytes(32).toString("hex");
    res.cookie("pj_google", JSON.stringify({ state, nonce, codeVerifier }), oauthCookie());
    res.redirect(client.generateAuthUrl({ scope: ["openid", "email", "profile"], state, nonce, code_challenge: codeChallenge, code_challenge_method: "S256", prompt: "select_account" }));
  }));
  router.get("/google/callback", asyncRoute(async (req, res) => {
    res.clearCookie("pj_google", { ...oauthCookie(), maxAge: undefined });
    const fail = (code) => res.redirect(`${clientOrigin()}/account?auth_error=${code}`);
    if (!googleReady()) return fail("google_unavailable");
    let saved;
    try { saved = JSON.parse(req.cookies?.pj_google || "null"); } catch { return fail("google_failed"); }
    if (!saved?.state || typeof req.query.state !== "string" || saved.state !== req.query.state) return fail("google_failed");
    if (req.query.error) return fail("google_cancelled");
    if (typeof req.query.code !== "string") return fail("google_failed");
    try {
      const client = getGoogleClient();
      const { tokens } = await client.getToken({ code: req.query.code, codeVerifier: saved.codeVerifier });
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
      const identity = ticket.getPayload();
      if (!identity?.sub || !identity.email_verified || identity.nonce !== saved.nonce) return fail("google_failed");
      const email = emailInput.parse(identity.email);
      let user = await User.findOne({ googleId: identity.sub });
      if (!user) {
        user = await User.findOne({ email });
        if (user) {
          if (user.googleId || (!email.endsWith("@gmail.com") && !identity.hd)) return fail("use_password");
          user.googleId = identity.sub;
          await user.save();
        } else user = await User.create({ name: identity.name || email.split("@")[0], email, googleId: identity.sub, role: "customer" });
      }
      setAuthCookie(res, user);
      return res.redirect(`${clientOrigin()}${user.role === "admin" ? "/admin" : "/account"}`);
    } catch {
      return fail("google_failed");
    }
  }));
  return router;
}
