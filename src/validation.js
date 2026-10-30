import { z } from "zod";

const productFields = z.object({
  name: z.string().trim().min(2).max(120),
  sku: z.string().trim().min(2).max(50),
  description: z.string().max(5000).optional().default(""),
  price: z.coerce.number().nonnegative(),
  mrp: z.coerce.number().nonnegative(),
  images: z.array(z.string().url()).max(12).optional().default([]),
  categories: z.array(z.string()).optional().default([]),
  material: z.string().max(80).optional().default(""),
  colour: z.string().max(80).optional().default(""),
  plating: z.string().max(80).optional().default(""),
  jewelleryType: z.string().max(80).optional().default(""),
  tags: z.array(z.string().trim().max(40)).max(30).optional().default([]),
  stock: z.coerce.number().int().nonnegative().optional().default(0),
  lowStockThreshold: z.coerce.number().int().nonnegative().optional().default(5),
  isNew: z.boolean().optional().default(false),
  isBestseller: z.boolean().optional().default(false),
  featured: z.boolean().optional().default(false),
  status: z.enum(["draft", "published", "archived"]).optional().default("draft")
});

export const productInput = productFields.refine((product) => product.price === undefined || product.mrp === undefined || product.mrp >= product.price, {
  message: "MRP must be equal to or higher than the selling price."
});
export const productUpdateInput = productFields.partial();

export const orderInput = z.object({
  customer: z.object({
    name: z.string().trim().min(2).max(100),
    email: z.string().email().max(254),
    phone: z.string().trim().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number.")
  }),
  address: z.object({
    line1: z.string().trim().min(5).max(200),
    landmark: z.string().max(100).optional().default(""),
    city: z.string().trim().min(2).max(80),
    state: z.string().trim().min(2).max(80),
    pinCode: z.string().regex(/^[1-9][0-9]{5}$/, "Enter a valid 6-digit PIN code.")
  }),
  items: z.array(z.object({ productId: z.string(), quantity: z.coerce.number().int().min(1).max(20) })).min(1).max(30),
  paymentMethod: z.enum(["cod", "razorpay"]),
  account: z.object({ password: z.string().min(10).max(100) }).optional()
});
