import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Cart, Order, Product } from "./models.js";
import { requireUser } from "./auth.js";

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const cartInput = z.object({ items: z.array(z.object({ productId: z.string().refine((id) => mongoose.isValidObjectId(id)), quantity: z.number().int().min(1).max(20) })).max(30) });

export function createCustomerRouter() {
  const router = Router();
  router.use(requireUser, (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.get("/cart", asyncRoute(async (req, res) => {
    const cart = await Cart.findOne({ user: req.user._id }).populate("items.product").lean();
    const items = (cart?.items || []).filter((item) => item.product?.status === "published" && item.product.stock > 0).map(({ product, quantity }) => ({ ...product, quantity: Math.min(quantity, product.stock, 20) }));
    res.json({ items });
  }));
  router.put("/cart", asyncRoute(async (req, res) => {
    // An old tab/request must never save another account's cart after switching users.
    if (req.get("X-Cart-Owner") !== req.user.id) return res.status(409).json({ message: "Your account changed. Reload your cart before making changes." });
    const { items } = cartInput.parse(req.body);
    const ids = items.map((item) => item.productId);
    if (new Set(ids).size !== ids.length) return res.status(400).json({ message: "Duplicate cart products are not allowed." });
    const products = await Product.find({ _id: { $in: ids }, status: "published" }).select("stock").lean();
    const byId = new Map(products.map((product) => [String(product._id), product]));
    if (items.some((item) => !byId.has(item.productId) || byId.get(item.productId).stock < item.quantity)) return res.status(409).json({ message: "A product is unavailable or has insufficient stock. Refresh your cart and try again." });
    await Cart.findOneAndUpdate({ user: req.user._id }, { $set: { items: items.map((item) => ({ product: item.productId, quantity: item.quantity })) } }, { upsert: true, runValidators: true });
    res.json({ ok: true });
  }));
  router.get("/orders/mine", asyncRoute(async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = 20;
    const filter = { user: req.user._id };
    const [orders, total] = await Promise.all([
      Order.find(filter).select("-user -inventoryReserved -reservationExpiresAt -__v").sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Order.countDocuments(filter)
    ]);
    res.json({ orders, total, page, pages: Math.ceil(total / limit) });
  }));
  return router;
}
