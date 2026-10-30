import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import bcrypt from "bcryptjs";
import Razorpay from "razorpay";
import slugify from "slugify";
import { z } from "zod";
import { Cart, Category, Order, Product, User } from "./models.js";
import { clearAuthCookie, optionalUser, requireAdmin, requireUser, setAuthCookie } from "./auth.js";
import { calculateOrderAmounts } from "./commerce.js";
import { createCustomerRouter } from "./customer-routes.js";
import { createAccountRouter } from "./account-routes.js";
import { orderInput, productInput, productUpdateInput } from "./validation.js";

const app = express();
const customerRouter = createCustomerRouter();
const port = Number(process.env.PORT || 5000);
const origin = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be set to a random value of at least 32 characters.");
}
if (process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "true") {
  throw new Error("COOKIE_SECURE=true is required in production.");
}
if (process.env.NODE_ENV === "production" &&
  (!Number.isFinite(Number(process.env.SHIPPING_FLAT_RATE)) || !Number.isFinite(Number(process.env.FREE_SHIPPING_THRESHOLD)))) {
  throw new Error("Set SHIPPING_FLAT_RATE and FREE_SHIPPING_THRESHOLD before starting in production.");
}

app.use(helmet({
  crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  contentSecurityPolicy: {
    directives: {
      "img-src": ["'self'", "data:", "https://images.unsplash.com"],
      "script-src": ["'self'", "https://checkout.razorpay.com"],
      "style-src": ["'self'", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com"],
      "connect-src": ["'self'", origin, "https://api.razorpay.com"],
      "frame-src": ["https://checkout.razorpay.com", "https://api.razorpay.com"],
      "object-src": ["'none'"]
    }
  }
}));
app.use(cors({ origin, credentials: true }));
app.use(cookieParser());
app.use(express.json({
  limit: "1mb",
  verify: (req, _res, buffer) => {
    if (req.originalUrl.startsWith("/api/payments/razorpay/webhook")) req.rawBody = Buffer.from(buffer);
  }
}));
app.use("/api/auth", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
app.use(["/api/auth/login", "/api/auth/register"], rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false }));
app.use("/api/auth", createAccountRouter());
app.use("/api/orders", rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false }));
const objectId = (id) => mongoose.isValidObjectId(id);
function messageFrom(error) {
  if (error?.name === "ZodError") return error.issues[0]?.message || "Please check your input.";
  if (error?.code === 11000) return `A record with this ${Object.keys(error.keyPattern || {})[0] || "value"} already exists.`;
  return "Something went wrong. Please try again.";
}

function getShippingSettings() {
  const flatRate = Number(process.env.SHIPPING_FLAT_RATE);
  const freeShippingThreshold = Number(process.env.FREE_SHIPPING_THRESHOLD);
  if (!Number.isFinite(flatRate) || flatRate < 0 || !Number.isFinite(freeShippingThreshold) || freeShippingThreshold < 0) {
    throw Object.assign(new Error("Shipping settings are not configured."), { status: 503 });
  }
  return { flatRate, freeShippingThreshold };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function reserveInventory(items) {
  const reserved = [];
  for (const item of items) {
    const updated = await Product.findOneAndUpdate(
      { _id: item.product, status: "published", stock: { $gte: item.quantity } },
      { $inc: { stock: -item.quantity } }
    );
    if (!updated) {
      for (const prior of reserved) await Product.updateOne({ _id: prior.product }, { $inc: { stock: prior.quantity } });
      throw Object.assign(new Error(`${item.name} just sold out. Please update your cart.`), { status: 409 });
    }
    reserved.push(item);
  }
}

async function releaseInventory(order) {
  const reservation = await Order.findOneAndUpdate(
    { _id: order._id, inventoryReserved: true, paymentStatus: { $ne: "paid" } },
    { $set: { inventoryReserved: false, reservationExpiresAt: null } },
    { new: true }
  );
  if (!reservation) return false;
  for (const item of reservation.items) {
    await Product.updateOne({ _id: item.product }, { $inc: { stock: item.quantity } });
  }
  return true;
}

async function validateCategoryIds(ids) {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.some((id) => !objectId(id))) throw Object.assign(new Error("Choose valid product categories."), { status: 400 });
  const count = await Category.countDocuments({ _id: { $in: uniqueIds } });
  if (count !== uniqueIds.length) throw Object.assign(new Error("One or more selected categories no longer exist."), { status: 400 });
  return uniqueIds;
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.get("/api/store-config", (_req, res) => res.json({ shipping: getShippingSettings() }));

app.get("/api/categories", asyncRoute(async (_req, res) => {
  const categories = await Category.find({ visible: true }).sort({ sortOrder: 1, name: 1 }).lean();
  res.json(categories);
}));

app.get("/api/products", asyncRoute(async (req, res) => {
  const { search = "", category, sort = "newest", minPrice, maxPrice, page = "1", limit = "24", featured } = req.query;
  const query = { status: "published", stock: { $gte: 0 } };
  if (category) {
    const categoryDoc = await Category.findOne({ slug: String(category), visible: true }).select("_id");
    query.categories = categoryDoc?._id || null;
  }
  const price = {};
  if (minPrice !== undefined && Number.isFinite(Number(minPrice))) price.$gte = Math.max(0, Number(minPrice));
  if (maxPrice !== undefined && Number.isFinite(Number(maxPrice))) price.$lte = Math.max(0, Number(maxPrice));
  if (Object.keys(price).length) query.price = price;
  if (featured === "true") query.featured = true;
  if (String(search).trim()) {
    const terms = String(search).trim().split(/\s+/).slice(0, 8);
    query.$or = terms.map((term) => ({
      $or: ["name", "description", "sku", "tags", "material", "colour", "plating", "jewelleryType"]
        .map((field) => ({ [field]: { $regex: term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }))
    }));
  }
  const sortMap = {
    newest: { createdAt: -1 },
    price_asc: { price: 1 },
    price_desc: { price: -1 },
    popular: { isBestseller: -1, createdAt: -1 }
  };
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safeLimit = Math.min(48, Math.max(1, Number.parseInt(limit, 10) || 24));
  const [products, total] = await Promise.all([
    Product.find(query).populate("categories", "name slug").sort(sortMap[sort] || sortMap.newest).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    Product.countDocuments(query)
  ]);
  res.json({ products, total, page: safePage, pages: Math.ceil(total / safeLimit) });
}));

app.get("/api/products/:slug", asyncRoute(async (req, res) => {
  const product = await Product.findOne({ slug: req.params.slug, status: "published" }).populate("categories", "name slug").lean();
  if (!product) return res.status(404).json({ message: "This piece could not be found." });
  const related = await Product.find({
    _id: { $ne: product._id },
    status: "published",
    $or: [{ categories: { $in: product.categories.map((category) => category._id) } }, { material: product.material }, { colour: product.colour }]
  }).sort({ isBestseller: -1, stock: -1 }).limit(4).lean();
  res.json({ product, related });
}));

app.post("/api/auth/register", asyncRoute(async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2).max(100), email: z.string().email(), password: z.string().min(10).max(100) }).parse(req.body);
  const user = await User.create({ ...input, email: input.email.toLowerCase(), passwordHash: await bcrypt.hash(input.password, 12), role: "customer" });
  setAuthCookie(res, user);
  res.status(201).json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const input = z.object({ email: z.string().email(), password: z.string().min(1).max(100) }).parse(req.body);
  const user = await User.findOne({ email: input.email.toLowerCase() });
  if (!user?.passwordHash || !(await bcrypt.compare(input.password, user.passwordHash))) return res.status(401).json({ message: "Email or password is incorrect." });
  setAuthCookie(res, user);
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));

app.post("/api/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", optionalUser, (req, res) => {
  res.json({ user: req.user ? { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role } : null });
});

app.use("/api", (req, res, next) => {
  if (req.path === "/cart" || req.path === "/orders/mine") return customerRouter(req, res, next);
  next();
});

app.post("/api/orders", optionalUser, asyncRoute(async (req, res) => {
  const input = orderInput.parse(req.body);
  if (!req.user && !input.account) return res.status(400).json({ message: "Create an account with a password to continue to checkout." });
  const checkoutEmail = input.customer.email.trim().toLowerCase();
  if (!req.user && await User.exists({ email: checkoutEmail })) return res.status(409).json({ message: "An account already uses this email. Sign in first, then return to checkout." });
  const ids = [...new Set(input.items.map((item) => item.productId))];
  if (ids.length !== input.items.length || ids.some((id) => !objectId(id))) return res.status(400).json({ message: "Cart contains a duplicate or invalid product." });
  const products = await Product.find({ _id: { $in: ids }, status: "published" });
  if (products.length !== ids.length) return res.status(409).json({ message: "A product in your cart is no longer available." });
  const byId = new Map(products.map((product) => [product.id, product]));
  const items = input.items.map(({ productId, quantity }) => {
    const product = byId.get(productId);
    if (!product || product.stock < quantity) throw Object.assign(new Error(`${product?.name || "A product"} does not have enough stock.`), { status: 409 });
    return { product: product._id, name: product.name, sku: product.sku, image: product.images[0] || "", unitPrice: product.price, quantity };
  });
  const { subtotal, shipping, total } = calculateOrderAmounts(items, getShippingSettings());
  const reference = `PJ-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  let checkoutUser = req.user;
  let createdUser = null;
  let order;
  try {
    if (!checkoutUser) {
      createdUser = await User.create({ name: input.customer.name, email: checkoutEmail, passwordHash: await bcrypt.hash(input.account.password, 12), role: "customer" });
      checkoutUser = createdUser;
    }
    order = await Order.create({
      reference,
      user: checkoutUser._id,
      customer: { ...input.customer, email: checkoutEmail },
      address: input.address,
      items,
      subtotal,
      shipping,
      total,
      paymentMethod: input.paymentMethod,
      paymentStatus: "pending",
      status: input.paymentMethod === "cod" ? "confirmed" : "pending_payment",
      inventoryReserved: true,
      reservationExpiresAt: input.paymentMethod === "razorpay" ? new Date(Date.now() + 20 * 60 * 1000) : null
    });
    await reserveInventory(items);
  } catch (error) {
    if (order) await Order.deleteOne({ _id: order._id });
    if (createdUser) await User.deleteOne({ _id: createdUser._id });
    throw error;
  }
  const accountResult = createdUser ? { user: { id: checkoutUser.id, name: checkoutUser.name, email: checkoutUser.email, role: checkoutUser.role }, accountCreated: true } : {};
  if (input.paymentMethod === "cod") {
    if (createdUser) setAuthCookie(res, checkoutUser);
    return res.status(201).json({ order: { reference, total: order.total, status: order.status }, ...accountResult });
  }
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    await releaseInventory(order);
    await Order.deleteOne({ _id: order._id });
    if (createdUser) await User.deleteOne({ _id: createdUser._id });
    return res.status(503).json({ message: "Online payment is not configured. Please choose another payment method." });
  }
  const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  try {
    const paymentOrder = await razorpay.orders.create({
      amount: Math.round(order.total * 100),
      currency: "INR",
      receipt: reference,
      expire_by: Math.floor(Date.now() / 1000) + 20 * 60,
      notes: { orderReference: reference }
    });
    order.razorpayOrderId = paymentOrder.id;
    await order.save();
    if (createdUser) {
      await Cart.findOneAndUpdate({ user: checkoutUser._id }, { $set: { items: items.map((item) => ({ product: item.product, quantity: item.quantity })) } }, { upsert: true });
      setAuthCookie(res, checkoutUser);
    }
    res.status(201).json({ order: { reference, total: order.total }, payment: { id: paymentOrder.id, amount: paymentOrder.amount, currency: paymentOrder.currency, keyId: process.env.RAZORPAY_KEY_ID }, ...accountResult });
  } catch (error) {
    await releaseInventory(order);
    await Order.deleteOne({ _id: order._id });
    if (createdUser) {
      await Cart.deleteOne({ user: createdUser._id });
      await User.deleteOne({ _id: createdUser._id });
    }
    throw error;
  }
}));

app.post("/api/orders/verify-payment", asyncRoute(async (req, res) => {
  const input = z.object({
    orderReference: z.string().min(5),
    razorpay_order_id: z.string().min(5),
    razorpay_payment_id: z.string().min(5),
    razorpay_signature: z.string().min(20)
  }).parse(req.body);
  const order = await Order.findOne({ reference: input.orderReference });
  if (!order || order.razorpayOrderId !== input.razorpay_order_id) return res.status(404).json({ message: "Payment order not found." });
  if (order.paymentStatus === "paid") return res.json({ order: { reference: order.reference, status: order.status } });
  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
    .update(`${input.razorpay_order_id}|${input.razorpay_payment_id}`).digest("hex");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(input.razorpay_signature);
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    return res.status(400).json({ message: "Payment verification failed." });
  }
  const updated = await Order.findOneAndUpdate(
    { _id: order._id, paymentStatus: "pending" },
    { $set: { paymentStatus: "paid", status: "confirmed", razorpayPaymentId: input.razorpay_payment_id, inventoryReserved: false, reservationExpiresAt: null } },
    { new: true }
  );
  if (!updated) return res.status(409).json({ message: "Payment is already being processed." });
  for (const item of updated.items) {
    const product = await Product.findOneAndUpdate({ _id: item.product, status: "published", stock: { $gte: item.quantity } }, { $inc: { stock: -item.quantity } });
    if (!product) {
      await Order.updateOne({ _id: updated._id }, { $set: { paymentStatus: "paid", status: "pending_payment" } });
      return res.status(409).json({ message: "Payment received, but inventory needs staff review. Please contact support with your order reference." });
    }
  }
  if (updated.user) await Cart.findOneAndUpdate({ user: updated.user }, { $set: { items: [] } });
  res.json({ order: { reference: updated.reference, status: updated.status } });
}));

app.post("/api/payments/razorpay/webhook", asyncRoute(async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.get("x-razorpay-signature");
  if (!secret || !signature || !Buffer.isBuffer(req.rawBody)) return res.status(400).json({ message: "Webhook verification is not configured." });
  const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) return res.status(400).json({ message: "Invalid webhook signature." });
  const event = JSON.parse(req.rawBody.toString("utf8"));
  if (event.event === "payment.captured") {
    const payment = event.payload?.payment?.entity;
    if (payment?.order_id && payment?.id) {
      await Order.findOneAndUpdate(
        { razorpayOrderId: payment.order_id, paymentStatus: "pending" },
        { $set: { paymentStatus: "paid", status: "confirmed", razorpayPaymentId: payment.id, inventoryReserved: false, reservationExpiresAt: null } }
      );
    }
  } else if (event.event === "payment.failed") {
    const payment = event.payload?.payment?.entity;
    if (payment?.order_id) {
      const order = await Order.findOne({ razorpayOrderId: payment.order_id, paymentStatus: "pending" });
      if (order) {
        await Order.updateOne({ _id: order._id, paymentStatus: "pending" }, { $set: { paymentStatus: "failed", reservationExpiresAt: null } });
        await releaseInventory(order);
      }
    }
  }
  res.json({ received: true });
}));

app.get("/api/admin/summary", requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  const [products, orders, lowStock, sales] = await Promise.all([
    Product.countDocuments({ status: { $ne: "archived" } }),
    Order.countDocuments(),
    Product.countDocuments({ status: "published", stock: { $lte: 5 } }),
    Order.aggregate([{ $match: { paymentStatus: "paid" } }, { $group: { _id: null, revenue: { $sum: "$total" }, count: { $sum: 1 } } }])
  ]);
  res.json({ products, orders, lowStock, revenue: sales[0]?.revenue || 0, paidOrders: sales[0]?.count || 0 });
}));

app.get("/api/admin/products", requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  res.json(await Product.find().populate("categories", "name").sort({ updatedAt: -1 }).lean());
}));

app.post("/api/admin/products", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const input = productInput.parse(req.body);
  input.categories = await validateCategoryIds(input.categories);
  const nameSlug = slugify(input.name, { lower: true, strict: true });
  const slug = `${nameSlug}-${input.sku.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const product = await Product.create({ ...input, sku: input.sku.toUpperCase(), slug });
  res.status(201).json(product);
}));

app.patch("/api/admin/products/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  if (!objectId(req.params.id)) return res.status(400).json({ message: "Invalid product id." });
  const input = productUpdateInput.parse(req.body);
  if (input.categories) input.categories = await validateCategoryIds(input.categories);
  if (input.sku) input.sku = input.sku.toUpperCase();
  const current = await Product.findById(req.params.id).select("name sku price mrp");
  if (!current) return res.status(404).json({ message: "Product not found." });
  const nextPrice = input.price ?? current.price;
  const nextMrp = input.mrp ?? current.mrp;
  if (nextMrp < nextPrice) return res.status(400).json({ message: "MRP must be equal to or higher than the selling price." });
  if (input.name || input.sku) {
    const name = input.name || current.name;
    const sku = input.sku || current.sku;
    input.slug = `${slugify(name, { lower: true, strict: true })}-${sku.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  }
  const product = await Product.findByIdAndUpdate(req.params.id, input, { new: true, runValidators: true });
  res.json(product);
}));

app.delete("/api/admin/products/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  if (!objectId(req.params.id)) return res.status(400).json({ message: "Invalid product id." });
  if (await Order.exists({ "items.product": req.params.id })) return res.status(409).json({ message: "This product belongs to an order. Archive it to preserve order history." });
  const product = await Product.findByIdAndDelete(req.params.id);
  if (!product) return res.status(404).json({ message: "Product not found." });
  res.json({ ok: true });
}));

app.post("/api/admin/categories", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const input = z.object({ name: z.string().trim().min(2).max(80), image: z.string().url().optional().or(z.literal("")) }).parse(req.body);
  const category = await Category.create({ name: input.name, slug: slugify(input.name, { lower: true, strict: true }), image: input.image || "", visible: true });
  res.status(201).json(category);
}));

app.get("/api/admin/categories", requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  res.json(await Category.find().sort({ sortOrder: 1, name: 1 }).lean());
}));

app.patch("/api/admin/categories/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  if (!objectId(req.params.id)) return res.status(400).json({ message: "Invalid category id." });
  const input = z.object({ name: z.string().trim().min(2).max(80), image: z.string().url().optional().or(z.literal("")) }).parse(req.body);
  const category = await Category.findByIdAndUpdate(req.params.id, { ...input, slug: slugify(input.name, { lower: true, strict: true }) }, { new: true, runValidators: true });
  if (!category) return res.status(404).json({ message: "Category not found." });
  res.json(category);
}));

app.delete("/api/admin/categories/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  if (!objectId(req.params.id)) return res.status(400).json({ message: "Invalid category id." });
  if (await Product.exists({ categories: req.params.id })) return res.status(409).json({ message: "Move or remove products from this category before deleting it, including archived products." });
  const category = await Category.findByIdAndDelete(req.params.id);
  if (!category) return res.status(404).json({ message: "Category not found." });
  res.json({ ok: true });
}));

app.get("/api/admin/orders", requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  res.json(await Order.find().sort({ createdAt: -1 }).limit(100).lean());
}));

app.patch("/api/admin/orders/:id/status", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const status = z.enum(["confirmed", "processing", "packed", "shipped", "delivered", "cancelled"]).parse(req.body.status);
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ message: "Order not found." });
  const transitions = {
    confirmed: ["processing", "cancelled"],
    processing: ["packed", "cancelled"],
    packed: ["shipped", "cancelled"],
    shipped: ["delivered"],
    delivered: [],
    cancelled: []
  };
  if (!transitions[order.status]?.includes(status)) return res.status(409).json({ message: `Cannot move an order from ${order.status} to ${status}.` });
  if (status === "cancelled" && order.paymentStatus === "paid") {
    return res.status(409).json({ message: "Paid orders require a refund review before they can be cancelled." });
  }
  if (status === "cancelled") await releaseInventory(order);
  order.status = status;
  if (status === "delivered" && order.paymentMethod === "cod") {
    order.paymentStatus = "paid";
    order.inventoryReserved = false;
    order.reservationExpiresAt = null;
  }
  await order.save();
  res.json(order);
}));

app.use("/api", (_req, res) => res.status(404).json({ message: "API route not found." }));
app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  const status = error.status || (error.name === "ZodError" ? 400 : error.code === 11000 ? 409 : 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ message: messageFrom(error) });
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/prathika-jewellers")
  .then(() => {
    const expireReservations = async () => {
      try {
        const expired = await Order.find({
          inventoryReserved: true,
          paymentMethod: "razorpay",
          paymentStatus: "pending",
          reservationExpiresAt: { $lte: new Date() }
        });
        for (const order of expired) {
          await Order.updateOne({ _id: order._id, paymentStatus: "pending" }, { $set: { paymentStatus: "failed" } });
          await releaseInventory(order);
        }
      } catch (error) {
        console.error("Could not release expired payment reservations:", error.message);
      }
    };
    const reservationTimer = setInterval(expireReservations, 60_000);
    reservationTimer.unref();
    // app.listen(port, () => console.log(`Prathika API listening on http://localhost:${port}`));
  })
  .catch((error) => {
    console.error("Could not connect to MongoDB:", error.message);
    process.exit(1);
  });
