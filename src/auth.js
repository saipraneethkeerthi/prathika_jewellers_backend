import jwt from "jsonwebtoken";
import { User } from "./models.js";

export const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === "true",
  sameSite: "lax",
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000
});

export function setAuthCookie(res, user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is required");
  const token = jwt.sign({ sub: user.id, sv: user.sessionVersion || 0 }, secret, { expiresIn: "7d" });
  res.cookie("pj_session", token, cookieOptions());
}

export function clearAuthCookie(res) {
  res.clearCookie("pj_session", { ...cookieOptions(), maxAge: undefined });
}

export async function requireUser(req, res, next) {
  try {
    const token = req.cookies?.pj_session;
    if (!token || !process.env.JWT_SECRET) return res.status(401).json({ message: "Please sign in to continue." });
    const { sub, sv = 0 } = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(sub).select("_id name email role sessionVersion");
    if (!user || (user.sessionVersion || 0) !== sv) return res.status(401).json({ message: "Your session is no longer valid." });
    req.user = user;
    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Please sign in again." });
    }
    next(error);
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ message: "Administrator access required." });
  next();
}

export function optionalUser(req, _res, next) {
  const token = req.cookies?.pj_session;
  if (!token || !process.env.JWT_SECRET) return next();
  try {
    const { sub, sv = 0 } = jwt.verify(token, process.env.JWT_SECRET);
    User.findById(sub).select("_id name email role sessionVersion").then((user) => {
      req.user = user && (user.sessionVersion || 0) === sv ? user : null;
      next();
    }).catch(next);
  } catch {
    next();
  }
}
