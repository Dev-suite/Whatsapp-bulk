require("dotenv").config();
const express = require("express");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const SQLiteStore = require("connect-sqlite3")(session);

const app = express();
const uploadsDir = path.join(__dirname, "uploads");
try {
  fs.mkdirSync(uploadsDir, { recursive: true });
} catch (err) {
  // If the directory can't be created, multer will fail on first upload.
  console.error("Failed to create uploads directory", err);
}
const upload = multer({ dest: uploadsDir });

app.use(express.json());
app.use(
  session({
    store: new SQLiteStore({
      dir: __dirname,
      db: "sessions.sqlite"
    }),
    secret: process.env.SESSION_SECRET || "dev_only_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    }
  })
);

const TEMPLATE_NAME = "order";
const LANGUAGE_CODE = "en";
const DELAY_MS = 1200;
const BULK_BATCH_SIZE = Number(process.env.BULK_BATCH_SIZE || 10);
const BULK_BATCH_DELAY_MS = Number(process.env.BULK_BATCH_DELAY_MS || DELAY_MS);

const messages = [];
const incomingMessages = [];

const dbPath = path.join(__dirname, "data.sqlite");
const db = new sqlite3.Database(dbPath);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

async function initDb() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: "unauthorized" });
}

function normalizePhone(input) {
  let phone = String(input || "").trim();
  phone = phone.replace(/[^\d+]/g, "");
  if (phone.startsWith("+234")) return phone.slice(1);
  if (phone.startsWith("234")) return phone;
  if (phone.startsWith("0")) return "234" + phone.slice(1);
  return phone;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTemplateMessage(to, videoLink) {
  const url = `https://graph.facebook.com/v25.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: "services",
      language: { code: "en" },
      components: [
        {
          type: "header",
          parameters: [
            {
              type: "video",
              video: { link: videoLink }
            }
          ]
        }
      ]
    }
  };

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    }
  });

  return response.data;
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, template: TEMPLATE_NAME, language: LANGUAGE_CODE });
});

app.get("/api/messages", requireAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const pageSize = Math.max(
    1,
    Math.min(100, parseInt(req.query.pageSize || "10", 10))
  );

  // Most recent first
  const reversed = messages.slice().reverse();
  const total = reversed.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const start = (page - 1) * pageSize;
  const items = reversed.slice(start, start + pageSize);

  res.json({ items, page, pageSize, total, totalPages });
});

app.get("/api/my-messages", requireAuth, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const pageSize = Math.max(
    1,
    Math.min(100, parseInt(req.query.pageSize || "10", 10))
  );

  const userMessages = messages.filter((m) => m.userId === req.session.userId);

  // Most recent first
  const reversed = userMessages.slice().reverse();
  const total = reversed.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const start = (page - 1) * pageSize;
  const items = reversed.slice(start, start + pageSize);

  res.json({ items, page, pageSize, total, totalPages });
});

app.get("/api/inbox", requireAuth, (req, res) => {
  res.json(incomingMessages.slice().reverse());
});

app.post("/api/send-single", requireAuth, async (req, res) => {
  const { phone, videoUrl } = req.body;
  const to = normalizePhone(phone);

  if (!to || !videoUrl) {
    return res.status(400).json({ error: "phone and videoUrl are required" });
  }

  try {
    const data = await sendTemplateMessage(to, videoUrl);
    const record = {
      userId: req.session.userId,
      phone: to,
      status: data?.messages?.[0]?.message_status || "accepted",
      wamid: data?.messages?.[0]?.id || null,
      sentAt: new Date().toISOString()
    };
    messages.push(record);
    res.json(record);
  } catch (error) {
    const record = {
      userId: req.session.userId,
      phone: to,
      status: "failed",
      error: error.response?.data || error.message,
      sentAt: new Date().toISOString()
    };
    messages.push(record);
    res.status(500).json(record);
  }
});

app.post("/api/upload-csv", requireAuth, upload.single("file"), async (req, res) => {
  const videoUrl = req.body.videoUrl;
  if (!req.file) return res.status(400).json({ error: "CSV file is required" });
  if (!videoUrl) return res.status(400).json({ error: "videoUrl is required" });

  const results = [];
  const seen = new Set();

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (row) => {
      const rawPhone = row.phone || row.Phone || row.PHONE || "";
      const rawName = row.name || row.Name || row.NAME || "";
      const phone = normalizePhone(rawPhone);

      if (phone && !seen.has(phone)) {
        seen.add(phone);
        results.push({ name: rawName, phone });
      }
    })
    .on("end", async () => {
      const output = [];

      // Batch sending: send N messages concurrently, then pause before next batch.
      for (let i = 0; i < results.length; i += BULK_BATCH_SIZE) {
        const batch = results.slice(i, i + BULK_BATCH_SIZE);

        const records = await Promise.all(
          batch.map(async (contact) => {
            try {
              const data = await sendTemplateMessage(contact.phone, videoUrl);
              return {
                userId: req.session.userId,
                name: contact.name,
                phone: contact.phone,
                status: data?.messages?.[0]?.message_status || "accepted",
                wamid: data?.messages?.[0]?.id || null,
                sentAt: new Date().toISOString()
              };
            } catch (error) {
              return {
                userId: req.session.userId,
                name: contact.name,
                phone: contact.phone,
                status: "failed",
                error: error?.response?.data || error?.message,
                sentAt: new Date().toISOString()
              };
            }
          })
        );

        records.forEach((record) => {
          messages.push(record);
          output.push(record);
        });

        await sleep(BULK_BATCH_DELAY_MS);
      }

      fs.unlink(req.file.path, () => { });
      res.json({
        total: output.length,
        success: output.filter((x) => x.status !== "failed").length,
        failed: output.filter((x) => x.status === "failed").length,
        results: output
      });
    });
});

app.get("/login", (req, res) => {
  if (req.session?.userId) return res.redirect("/");
  return res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/signup", (req, res) => {
  if (req.session?.userId) return res.redirect("/");
  return res.sendFile(path.join(__dirname, "public", "signup.html"));
});

app.get("/", (req, res) => {
  if (!req.session?.userId) return res.redirect("/login");
  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/auth/me", async (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: "unauthorized" });
  try {
    const user = await dbGet("SELECT id, email, created_at FROM users WHERE id = ?", [
      req.session.userId
    ]);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    return res.json({ user });
  } catch (err) {
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/auth/signup", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (!email.includes("@") || password.length < 8) {
    return res.status(400).json({ error: "invalid_email_or_password" });
  }

  try {
    const existing = await dbGet("SELECT id FROM users WHERE email = ?", [email]);
    if (existing) return res.status(409).json({ error: "email_in_use" });

    const passwordHash = await bcrypt.hash(password, 12);
    const createdAt = new Date().toISOString();
    const result = await dbRun(
      "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)",
      [email, passwordHash, createdAt]
    );

    req.session.userId = result.lastID;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/auth/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  if (!email || !password) return res.status(400).json({ error: "invalid_credentials" });

  try {
    const user = await dbGet("SELECT id, email, password_hash FROM users WHERE email = ?", [
      email
    ]);
    if (!user) return res.status(401).json({ error: "invalid_credentials" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });

    req.session.userId = user.id;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "server_error" });
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.use(
  express.static(path.join(__dirname, "public"), {
    index: false
  })
);

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === "my_verify_token") {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  try {
    const entry = req.body.entry || [];
    entry.forEach((e) => {
      (e.changes || []).forEach((change) => {
        const value = change.value || {};

        if (value.messages) {
          value.messages.forEach((msg) => {
            incomingMessages.push({
              from: msg.from,
              type: msg.type,
              text: msg.text?.body || "",
              time: new Date().toISOString()
            });
          });
        }

        if (value.statuses) {
          value.statuses.forEach((status) => {
            const existing = messages.find((m) => m.wamid === status.id);
            if (existing) {
              existing.status = status.status;
              existing.updatedAt = new Date().toISOString();
            }
          });
        }
      });
    });

    res.sendStatus(200);
  } catch (error) {
    console.error(error);
    res.sendStatus(500);
  }
});

async function start() {
  await initDb();
  app.listen(process.env.PORT || 3000, () => {
    console.log(`Server running on http://localhost:${process.env.PORT || 3000}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server", err);
  process.exit(1);
});
