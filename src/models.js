import mongoose from "mongoose";

const { Schema, model } = mongoose;

const categorySchema = new Schema({
  name: { type: String, required: true, trim: true, unique: true },
  slug: { type: String, required: true, unique: true },
  image: { type: String, default: "" },
  visible: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 }
}, { timestamps: true });

const productSchema = new Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true },
  sku: { type: String, required: true, uppercase: true, trim: true, unique: true },
  description: { type: String, default: "" },
  price: { type: Number, required: true, min: 0 },
  mrp: { type: Number, required: true, min: 0 },
  images: [{ type: String }],
  categories: [{ type: Schema.Types.ObjectId, ref: "Category" }],
  material: { type: String, default: "" },
  colour: { type: String, default: "" },
  plating: { type: String, default: "" },
  jewelleryType: { type: String, default: "" },
  tags: [{ type: String }],
  stock: { type: Number, default: 0, min: 0 },
  lowStockThreshold: { type: Number, default: 5, min: 0 },
  isNew: { type: Boolean, default: false },
  isBestseller: { type: Boolean, default: false },
  featured: { type: Boolean, default: false },
  status: { type: String, enum: ["draft", "published", "archived"], default: "draft" },
  archivedAt: { type: Date, default: null }
}, { timestamps: true });

productSchema.index({ name: "text", description: "text", sku: "text", tags: "text", material: "text", colour: "text" });
productSchema.index({ status: 1, createdAt: -1 });
productSchema.index({ categories: 1, price: 1 });

const userSchema = new Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, default: null },
  googleId: { type: String, unique: true, sparse: true },
  sessionVersion: { type: Number, default: 0 },
  passwordResetHash: { type: String, select: false },
  passwordResetExpires: { type: Date, select: false },
  role: { type: String, enum: ["customer", "admin"], default: "customer" }
}, { timestamps: true });

const cartSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  items: [{ _id: false, product: { type: Schema.Types.ObjectId, ref: "Product", required: true }, quantity: { type: Number, min: 1, max: 20, required: true } }]
}, { timestamps: true });

const orderItemSchema = new Schema({
  product: { type: Schema.Types.ObjectId, ref: "Product", required: true },
  name: { type: String, required: true },
  sku: { type: String, required: true },
  image: { type: String, default: "" },
  unitPrice: { type: Number, required: true },
  quantity: { type: Number, required: true, min: 1 }
}, { _id: false });

const orderSchema = new Schema({
  reference: { type: String, required: true, unique: true },
  user: { type: Schema.Types.ObjectId, ref: "User", default: null },
  customer: {
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true },
    phone: { type: String, required: true }
  },
  address: {
    line1: { type: String, required: true },
    landmark: { type: String, default: "" },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pinCode: { type: String, required: true }
  },
  items: { type: [orderItemSchema], required: true },
  subtotal: { type: Number, required: true },
  shipping: { type: Number, required: true },
  total: { type: Number, required: true },
  paymentMethod: { type: String, enum: ["cod", "razorpay"], required: true },
  paymentStatus: { type: String, enum: ["pending", "paid", "failed"], default: "pending" },
  status: { type: String, enum: ["pending_payment", "confirmed", "processing", "packed", "shipped", "delivered", "cancelled"], default: "pending_payment" },
  razorpayOrderId: { type: String, default: null },
  razorpayPaymentId: { type: String, default: null },
  inventoryReserved: { type: Boolean, default: false },
  reservationExpiresAt: { type: Date, default: null }
}, { timestamps: true });

orderSchema.index({ user: 1, createdAt: -1 });

export const Category = model("Category", categorySchema);
export const Product = model("Product", productSchema);
export const User = model("User", userSchema);
export const Order = model("Order", orderSchema);

export const Cart = model("Cart", cartSchema);
