const { list, get, put } = require("@vercel/blob");

const FILE = "easy-do-it/shared-records.json";
const KEYS = new Set([
  "moyo-dashboard-v1",
  "moyo-calendar-names-v1",
  "moyo-day-time-notes-v1",
  "moyo-day-time-ratings-v1",
  "moyo-time-score-10-v1",
  "moyo-auto-diary-collapsed",
  "moyo-auto-diary-sections-v1",
  "moyo-quick-done-v1",
  "moyo-life-system-v1",
]);

function isDevelopmentOrigin(origin) {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return host === "bodydouble-dev.vercel.app"
      || host === "bodydouble-dev-hyejum-sudo.vercel.app"
      || /^bodydouble-dev-[a-z0-9-]+-hyejum-sudo\.vercel\.app$/.test(host);
  } catch {
    return false;
  }
}

async function readBlob() {
  const result = await list({ prefix: FILE });
  const exists = result.blobs.some((blob) => blob.pathname === FILE);
  if (!exists) return null;
  const file = await get(FILE, { access: "private" });
  if (!file) return null;
  return JSON.parse(await new Response(file.stream).text());
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (isDevelopmentOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return send(res, 503, { error: "Shared record storage is not connected." });
  }

  try {
    if (req.method === "GET") {
      const record = await readBlob();
      const state = record?.state ? { ...record.state } : null;
      if (state && isDevelopmentOrigin(origin)) delete state["moyo-life-system-v1"];
      return send(res, 200, {
        exists: Boolean(record),
        primary: process.env.EASY_DO_IT_RECORDS_PRIMARY === "true",
        state,
        updatedAt: record?.updatedAt || null,
      });
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST, OPTIONS");
      return send(res, 405, { error: "Method not allowed." });
    }

    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!payload || typeof payload !== "object" || !payload.state || typeof payload.state !== "object" || Array.isArray(payload.state)) {
      return send(res, 400, { error: "Invalid record payload." });
    }

    const state = {};
    for (const [key, value] of Object.entries(payload.state)) {
      if (KEYS.has(key) && typeof value === "string") state[key] = value;
    }
    if (!Object.keys(state).length) {
      return send(res, 400, { error: "No supported records were provided." });
    }

    if (isDevelopmentOrigin(origin)) {
      const existing = await readBlob();
      const mainSystem = existing?.state?.["moyo-life-system-v1"];
      if (mainSystem) state["moyo-life-system-v1"] = mainSystem;
      else delete state["moyo-life-system-v1"];
    }

    if (payload.ifEmpty === true) {
      const existing = await readBlob();
      if (existing) {
        return send(res, 200, { saved: false, exists: true, state: existing.state, updatedAt: existing.updatedAt });
      }
    }

    const record = { schema: 1, state, updatedAt: new Date().toISOString() };
    await put(FILE, JSON.stringify(record), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json; charset=utf-8",
    });
    return send(res, 200, { saved: true, exists: true, updatedAt: record.updatedAt });
  } catch (error) {
    console.error("Shared record storage error:", error);
    return send(res, 500, { error: "Shared record storage is temporarily unavailable." });
  }
};
