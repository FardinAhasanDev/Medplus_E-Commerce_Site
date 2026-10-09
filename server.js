require("dotenv").config();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");
const session = require("express-session");
const mongoose = require("mongoose");

const app = express();
const PORT = 7000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const LOCAL_MONGO_URI = "mongodb://127.0.0.1:27017/medplus_db";
mongoose
  .connect(LOCAL_MONGO_URI)
  .then(() => console.log("MongoDB connected: " + LOCAL_MONGO_URI))
  .catch((err) => console.error("MongoDB connection error:", err));

const UserSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, required: true },
});
const User = mongoose.model("User", UserSchema);

const ProductSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  category: { type: String, default: "General" },
  badge: { type: String, default: "OTC" },
  stock: { type: Number, default: 0 },
  emoji: { type: String, default: "💊" },
  imagePath: { type: String, default: null },
  brand: { type: String, default: "" },
  sub: { type: String, default: "" },
  oldPrice: { type: Number, default: null },
  highlight: { type: Boolean, default: false },
});
const Product = mongoose.model("Product", ProductSchema);

const SaleSchema = new mongoose.Schema({
  saleId: { type: String, required: true, unique: true },
  receiptId: { type: String, required: true },
  customerName: { type: String, default: "Walk-in Customer" },
  customerAddress: { type: String, default: "Counter" },
  paymentMethod: { type: String, default: "Cash" },
  productId: { type: String, required: true },
  productName: { type: String, required: true },
  category: { type: String, default: "General" },
  emoji: { type: String, default: "💊" },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true },
  totalAmount: { type: Number, required: true },
  saleDate: { type: String, default: () => new Date().toISOString() },
  cashier: { type: String, required: true },
});
const Sale = mongoose.model("Sale", SaleSchema);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 8 },
  }),
);

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

if (!fs.existsSync("./uploads")) fs.mkdirSync("./uploads");

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

const requireAuth = (req, res, next) => {
  if (req.session?.user) return next();
  res.redirect("/login");
};

const requireAdmin = (req, res, next) => {
  if (req.session?.user) {
    const { role, username } = req.session.user;
    if (role === "admin" || username.toLowerCase() === "admin") return next();
  }
  res
    .status(403)
    .render("error", { message: "Access Denied: Admin privileges required." });
};

const broadcast = (payload) => {
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(JSON.stringify(payload));
  });
};

app.get("/register", (req, res) =>
  res.render("register", { error: null, success: null }),
);

app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.render("register", {
      error: "All fields are required.",
      success: null,
    });

  try {
    const exists = await User.findOne({
      username: { $regex: new RegExp(`^${username.trim()}$`, "i") },
    });
    if (exists)
      return res.render("register", {
        error: "Username already registered.",
        success: null,
      });

    const role =
      username.trim().toLowerCase() === "admin" ? "admin" : "cashier";
    await new User({
      id: "USR-" + Date.now(),
      username: username.trim(),
      password,
      role,
    }).save();

    res.render("register", {
      error: null,
      success: "Account created! You can now log in.",
    });
  } catch (err) {
    res.render("register", { error: "Database error.", success: null });
  }
});

app.get("/login", (req, res) => res.render("login", { error: null }));

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({
      username: { $regex: new RegExp(`^${username.trim()}$`, "i") },
      password,
    });

    if (!user)
      return res.render("login", { error: "Invalid username or password." });

    req.session.user = {
      id: user.id,
      username: user.username,
      role:
        user.role ||
        (user.username.toLowerCase() === "admin" ? "admin" : "cashier"),
      loginTime: new Date(),
    };
    if (!req.session.cart) req.session.cart = [];
    res.redirect("/terminal");
  } catch (err) {
    res.render("login", { error: "Authentication error." });
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/", async (req, res) => {
  try {
    const products = await Product.find({});
    res.render("home", { products });
  } catch (err) {
    res.status(500).send("Error loading home page.");
  }
});

app.get("/terminal", requireAuth, async (req, res) => {
  try {
    const products = await Product.find({});
    const cart = req.session.cart || [];
    const cartTotal = cart.reduce((s, i) => s + i.price * i.quantity, 0);
    res.render("terminal", {
      products,
      cart,
      cartTotal: cartTotal.toFixed(2),
    });
  } catch (err) {
    res.status(500).send("Error loading terminal.");
  }
});

app.post("/cart/add", requireAuth, async (req, res) => {
  if (!req.session.cart) req.session.cart = [];
  try {
    const product = await Product.findOne({ id: req.body.productId });
    if (product) {
      const existing = req.session.cart.find((i) => i.id === product.id);
      existing
        ? existing.quantity++
        : req.session.cart.push({ ...product.toObject(), quantity: 1 });
    }
    broadcast({ type: "REFRESH_DATA" });
    res.redirect("/terminal");
  } catch (err) {
    res.redirect("/terminal");
  }
});

app.post("/cart/remove", requireAuth, (req, res) => {
  if (!req.session.cart) req.session.cart = [];
  const idx = req.session.cart.findIndex((i) => i.id === req.body.productId);
  if (idx !== -1) {
    req.session.cart[idx].quantity > 1
      ? req.session.cart[idx].quantity--
      : req.session.cart.splice(idx, 1);
  }
  broadcast({ type: "REFRESH_DATA" });
  res.redirect("/terminal");
});

app.post("/cart/remove-all", requireAuth, (req, res) => {
  if (!req.session.cart) req.session.cart = [];
  req.session.cart = req.session.cart.filter(
    (i) => i.id !== req.body.productId,
  );
  broadcast({ type: "REFRESH_DATA" });
  res.redirect("/terminal");
});

app.post("/cart/clear", requireAuth, (req, res) => {
  req.session.cart = [];
  broadcast({ type: "REFRESH_DATA" });
  res.redirect("/terminal");
});

app.post("/cart/checkout", requireAuth, async (req, res) => {
  const cart = req.session.cart || [];
  if (!cart.length) return res.redirect("/terminal");

  const {
    customerName = "Walk-in Customer",
    customerAddress = "Counter",
    paymentMethod = "Cash",
  } = req.body;

  const receiptId = "RCP-" + Date.now();

  try {
    const salesDocs = cart.map((item) => ({
      saleId: "SALE-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
      receiptId,
      customerName,
      customerAddress,
      paymentMethod,
      productId: item.id,
      productName: item.name,
      category: item.category || "General",
      emoji: item.emoji || "💊",
      price: parseFloat(item.price),
      quantity: parseInt(item.quantity),
      totalAmount: parseFloat((item.price * item.quantity).toFixed(2)),
      saleDate: new Date().toISOString(),
      cashier: req.session.user.username,
    }));

    await Sale.insertMany(salesDocs);

    for (const item of cart) {
      await Product.findOneAndUpdate(
        { id: item.id },
        { $inc: { stock: -item.quantity } },
      );
    }

    const itemCount = cart.reduce((s, i) => s + i.quantity, 0);
    const grandTotal = cart
      .reduce((s, i) => s + i.price * i.quantity, 0)
      .toFixed(2);

    req.session.cart = [];
    broadcast({ type: "REFRESH_DATA" });

    const isAjax = req.xhr || (req.headers.accept || "").includes("json");
    if (isAjax)
      return res.json({
        success: true,
        receiptId,
        customerName,
        customerAddress,
        itemCount,
        grandTotal,
      });

    const params = new URLSearchParams({
      receipt: receiptId,
      name: customerName,
      address: customerAddress,
      items: itemCount,
      total: grandTotal,
    });
    res.redirect("/checkout-success?" + params.toString());
  } catch (err) {
    res.status(500).json({ success: false, message: "Checkout failed." });
  }
});

app.get("/checkout-success", requireAuth, (req, res) => {
  res.render("checkout-success", {
    receiptId: req.query.receipt || "N/A",
    customerName: req.query.name || "Valued Customer",
    customerAddress: req.query.address || "Walk-in Counter Sale",
    itemCount: req.query.items || "0",
    grandTotal: req.query.total || "0.00",
  });
});

app.get("/admin/inventory", requireAdmin, async (req, res) => {
  try {
    const products = await Product.find({});
    res.render("admin-inventory", { products });
  } catch (err) {
    res.status(500).send("Error loading inventory.");
  }
});

app.post(
  "/product/create",
  requireAdmin,
  upload.single("productImage"),
  async (req, res) => {
    const {
      name,
      price,
      category,
      badge,
      stock,
      emoji,
      brand,
      sub,
      oldPrice,
      highlight,
    } = req.body;
    try {
      await new Product({
        id: "PROD-" + Date.now(),
        name,
        price: parseFloat(price),
        category: category || "General",
        badge: badge || "OTC",
        stock: parseInt(stock) || 0,
        emoji: emoji || "💊",
        imagePath: req.file ? `/uploads/${req.file.filename}` : null,
        brand: brand || "",
        sub: sub || "",
        oldPrice: oldPrice ? parseFloat(oldPrice) : null,
        highlight: highlight === "on" || highlight === "true",
      }).save();
      broadcast({ type: "REFRESH_DATA" });
      res.redirect("/admin/inventory");
    } catch (err) {
      res.status(500).send("Error creating product.");
    }
  },
);

app.post(
  "/product/update",
  requireAdmin,
  upload.single("productImage"),
  async (req, res) => {
    const { productId, name, price, category, badge, stock, emoji } = req.body;
    try {
      const updateFields = {
        name,
        price: parseFloat(price),
        category,
        badge,
        stock: parseInt(stock),
        emoji,
      };
      if (req.file) updateFields.imagePath = `/uploads/${req.file.filename}`;

      await Product.findOneAndUpdate({ id: productId }, updateFields, {
        new: true,
      });

      if (req.session.cart) {
        req.session.cart = req.session.cart.map((item) => {
          if (item.id === productId) {
            return {
              ...item,
              name,
              price: parseFloat(price),
              category,
              badge,
              stock: parseInt(stock),
              emoji,
              ...(req.file
                ? { imagePath: `/uploads/${req.file.filename}` }
                : {}),
            };
          }
          return item;
        });
      }

      broadcast({ type: "REFRESH_DATA" });
      res.redirect("/admin/inventory");
    } catch (err) {
      res.status(500).send("Error updating product.");
    }
  },
);

app.post("/product/delete", requireAdmin, async (req, res) => {
  const { productId } = req.body;
  try {
    const product = await Product.findOne({ id: productId });
    if (!product)
      return res
        .status(404)
        .json({ success: false, message: "Product not found." });

    const hasSales = await Sale.exists({ productId });
    if (hasSales) {
      return res.status(403).json({
        success: false,
        message: `Access Denied:\n\nThe item '${product.name}' cannot be deleted because it is linked to active sales transaction logs.`,
      });
    }

    await Product.deleteOne({ id: productId });

    if (req.session.cart)
      req.session.cart = req.session.cart.filter((i) => i.id !== productId);

    broadcast({ type: "REFRESH_DATA" });
    res.json({ success: true });
  } catch (err) {
    res
      .status(500)
      .json({ success: false, message: "Error deleting product." });
  }
});

app.get("/sales", requireAdmin, async (req, res) => {
  try {
    const sales = await Sale.find({}).sort({ _id: -1 });
    const totalRevenue = sales.reduce((s, i) => s + i.totalAmount, 0);
    const totalOrders = [...new Set(sales.map((s) => s.receiptId))].length;
    res.render("sales-log", {
      sales,
      totalRevenue: totalRevenue.toFixed(2),
      totalOrders,
    });
  } catch (err) {
    res.status(500).send("Error loading sales log.");
  }
});

app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q) return res.json([]);
  try {
    const results = await Product.find({
      $or: [
        { name: { $regex: q, $options: "i" } },
        { brand: { $regex: q, $options: "i" } },
        { category: { $regex: q, $options: "i" } },
        { sub: { $regex: q, $options: "i" } },
      ],
    });
    res.json(results);
  } catch (err) {
    res.json([]);
  }
});

app.get("/api/products", async (req, res) => {
  try {
    res.json(await Product.find({}));
  } catch {
    res.json([]);
  }
});

app.get("/api/cart", requireAuth, (req, res) =>
  res.json(req.session.cart || []),
);

app.get("/api/sales", requireAdmin, async (req, res) => {
  try {
    res.json(await Sale.find({}).sort({ _id: -1 }));
  } catch {
    res.json([]);
  }
});

app.use((req, res) =>
  res.status(404).render("error", { message: "Page not found." }),
);

wss.on("connection", (socket) => {
  console.log("Client connected via WebSocket");
  socket.on("message", (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === "CHAT_MSG") {
        broadcast({
          type: "CHAT_MSG",
          sender: data.sender,
          message: data.message,
          timestamp: new Date().toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
        });
      }
    } catch (e) {
      console.error("WS parse error:", e);
    }
  });
});

server.listen(PORT, () =>
  console.log(`MedPlus running at http://localhost:${PORT}`),
);
