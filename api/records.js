const SUPABASE_TABLE = "single_user_app_records";
const RECORD_ID = "main";
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
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

async function supabaseRequest(method, body) {
  const response = await fetch(SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/" + SUPABASE_TABLE + (method === "GET" ? "?id=eq." + RECORD_ID : "?on_conflict=id"), {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
      "Cache-Control": "no-store",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    throw new Error("Supabase record request failed: HTTP " + response.status);
  }
  return response.json();
}

async function readRecord() {
  const rows = await supabaseRequest("GET");
  const row = rows[0];
  return row ? { state: row.state, updatedAt: row.updated_at } : null;
}

async function writeRecord(state) {
  const updatedAt = new Date().toISOString();
  await supabaseRequest("POST", { id: RECORD_ID, state, updated_at: updatedAt });
  return updatedAt;
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

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return send(res, 503, { error: "Supabase record storage is not connected." });
  }

  try {
    if (req.method === "GET") {
      const record = await readRecord();
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
      const existing = await readRecord();
      const mainSystem = existing?.state?.["moyo-life-system-v1"];
      if (mainSystem) state["moyo-life-system-v1"] = mainSystem;
      else delete state["moyo-life-system-v1"];
    }

    if (payload.ifEmpty === true) {
      const existing = await readRecord();
      if (existing) {
        return send(res, 200, { saved: false, exists: true, state: existing.state, updatedAt: existing.updatedAt });
      }
    }

    const updatedAt = await writeRecord(state);
    return send(res, 200, { saved: true, exists: true, updatedAt });
  } catch (error) {
    console.error("Shared record storage error:", error);
    return send(res, 500, { error: "Shared record storage is temporarily unavailable." });
  }
};
