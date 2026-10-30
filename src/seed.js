import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import slugify from "slugify";
import { Category, Product, User } from "./models.js";

const categories = [
  ["Anti-Tarnish Chains", "https://images.unsplash.com/photo-1611652022419-a9419f74343d?auto=format&fit=crop&w=900&q=85"],
  ["Delicate Chains", "https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=900&q=85"],
  ["AD Necklaces", "https://images.unsplash.com/photo-1599643477877-530eb83abc8e?auto=format&fit=crop&w=900&q=85"],
  ["Earrings", "https://images.unsplash.com/photo-1630019852942-f89202989a59?auto=format&fit=crop&w=900&q=85"],
  ["Bracelets", "https://images.unsplash.com/photo-1611591437281-460bfbe1220a?auto=format&fit=crop&w=900&q=85"],
  ["Jewellery Sets", "https://images.unsplash.com/photo-1617038220319-276d3cfab638?auto=format&fit=crop&w=900&q=85"]
];

const sampleProducts = [
  ["Saanvi Everyday Chain", "PJ-AT-001", 1299, 1799, "Gold-plated anti-tarnish everyday chain with a softly polished finish.", "Anti-Tarnish Chains", "Stainless steel", "Gold", "Anti-tarnish", true, true, 18, "photo-1611652022419-a9419f74343d"],
  ["Mira Fine Layering Chain", "PJ-DC-002", 899, 1299, "A delicate chain designed to layer beautifully or wear on its own.", "Delicate Chains", "Brass", "Gold", "Gold plated", true, false, 24, "photo-1599643478518-a784e5dc4c8f"],
  ["Ira Celestial Pendant", "PJ-PC-003", 1599, 2199, "A refined pendant necklace with a delicate, light-catching detail.", "AD Necklaces", "Brass", "Gold", "American diamond", false, true, 12, "photo-1599643477877-530eb83abc8e"],
  ["Tara Pearl Drop Earrings", "PJ-ER-004", 1099, 1499, "Graceful pearl-look drops for celebrations and everyday dressing.", "Earrings", "Alloy", "Gold", "Pearl finish", true, true, 16, "photo-1630019852942-f89202989a59"],
  ["Aarya Slim Cuff Bracelet", "PJ-BR-005", 999, 1399, "A minimalist open cuff that adds a subtle golden accent.", "Bracelets", "Stainless steel", "Gold", "Gold plated", true, false, 20, "photo-1611591437281-460bfbe1220a"],
  ["Anika Occasion Necklace Set", "PJ-JS-006", 2499, 3299, "An occasion-ready necklace set with coordinated statement styling.", "Jewellery Sets", "Alloy", "Gold", "American diamond", false, true, 8, "photo-1617038220319-276d3cfab638"],
  ["Nila Sculpted Hoop Earrings", "PJ-ER-007", 799, 1199, "Sculpted gold-tone hoops with a clean, modern profile.", "Earrings", "Stainless steel", "Gold", "Gold plated", true, false, 30, "photo-1611652022419-a9419f74343d"],
  ["Diya Layered Charm Necklace", "PJ-DC-008", 1899, 2499, "A softly layered necklace made for effortless day-to-evening styling.", "Delicate Chains", "Brass", "Gold", "Gold plated", true, true, 11, "photo-1599643478518-a784e5dc4c8f"]
];

try {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/prathika-jewellers");
  const categoryDocs = new Map();
  for (let index = 0; index < categories.length; index += 1) {
    const [name, image] = categories[index];
    const category = await Category.findOneAndUpdate(
      { slug: slugify(name, { lower: true, strict: true }) },
      { $setOnInsert: { name, slug: slugify(name, { lower: true, strict: true }), image, visible: true, sortOrder: index } },
      { upsert: true, new: true }
    );
    categoryDocs.set(name, category);
  }
  for (const [name, sku, price, mrp, description, categoryName, material, colour, plating, isNew, isBestseller, stock, photo] of sampleProducts) {
    const category = categoryDocs.get(categoryName);
    const slug = `${slugify(name, { lower: true, strict: true })}-${sku.toLowerCase()}`;
    await Product.updateOne({ sku }, { $setOnInsert: {
      name, sku, slug, price, mrp, description,
      images: [`https://images.unsplash.com/${photo}?auto=format&fit=crop&w=1200&q=90`],
      categories: [category._id], material, colour, plating, jewelleryType: categoryName,
      tags: [categoryName, material, colour, plating], stock, lowStockThreshold: 5,
      isNew, isBestseller, featured: isNew || isBestseller, status: "published"
    } }, { upsert: true });
  }
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    await User.findOneAndUpdate(
      { email: process.env.ADMIN_EMAIL.trim().toLowerCase() },
      { $set: { role: "admin" }, $setOnInsert: {
        name: process.env.ADMIN_NAME || "Store Admin",
        email: process.env.ADMIN_EMAIL.trim().toLowerCase(),
        passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12)
      } },
      { upsert: true }
    );
  }
  console.log("Sample categories/products seeded. Existing catalog records were left unchanged.");
} catch (error) {
  console.error("Seed failed:", error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
