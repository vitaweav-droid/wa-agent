// index.js (ESM) — General + Scientific WhatsApp Assistant with Minimal Memory + Optional Real-time Search
// Works on Render + Twilio. No personal profile. Memory is only short-term context per user.
// ENV required: OPENAI_API_KEY
// ENV optional: OPENAI_MODEL (default gpt-4.1-mini), TAVILY_API_KEY, PORT (Render sets this)

import "dotenv/config";
import express from "express";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import twilio from "twilio";
import OpenAI from "openai";

// -------------------- Config --------------------
const PORT = Number(process.env.PORT || 5050);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, "assistant_db.json");

// Memory settings
const MEMORY_TURNS = 10; // 10 turns = 20 messages (user+assistant)
const MAX_MESSAGES = MEMORY_TURNS * 2;

// -------------------- App + Clients --------------------
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Twilio sends x-www-form-urlencoded by default
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// -------------------- Minimal DB --------------------
let db = { users: {} };

async function loadDB() {
  try {
    if (await fs.pathExists(DB_PATH)) {
      const raw = await fs.readFile(DB_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") db = parsed;
      if (!db.users) db.users = {};
    }
  } catch {
    db = { users: {} };
  }
}

async function saveDB() {
  // Note: Render free filesystem can reset on redeploy/restart.
  // For persistent memory use a DB (Postgres/Supabase) or Render Disk.
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

function getUser(from) {
  if (!db.users[from]) db.users[from] = { memory: [] };
  if (!Array.isArray(db.users[from].memory)) db.users[from].memory = [];
  return db.users[from];
}

function cap(arr, n) {
  return arr.length <= n ? arr : arr.slice(arr.length - n);
}

// -------------------- Prompts --------------------
function systemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return [
    "You are a neutral, objective, and scientific AI assistant.",
    `Today's date is ${today} (provided by the server).`,
    "",
    "Rules:",
    "- Do NOT assume user identity or personal details.",
    "- Do NOT invent dates like 'as of today' unless the server date is given or you cite web sources.",
    "- Be precise, structured, and evidence-based.",
    "- If the question depends on up-to-date information, use provided real-time sources if available; otherwise say you cannot verify in real time.",
    "",
    "Memory rule:",
    "- You may use short-term conversation memory only to preserve technical context.",
    "- Do not store or infer sensitive personal information.",
  ].join("\n");
}

const INTENT_PROMPT = [
  "You are an intent classifier.",
  "",
  "Decide if the user's message requires real-time internet information to answer correctly.",
  "Answer with exactly one word:",
  "- REALTIME (needs current events, latest updates, live data, prices, recent changes, 'what's happening now')",
  "- GENERAL (can be answered with stable/established knowledge)",
  "",
  "No explanations. No punctuation.",
].join("\n");

// -------------------- Real-time Web Search (Tavily) --------------------
async function webSearch(query) {
  if (!TAVILY_API_KEY) return { error: "NO_TAVILY_KEY", results: [] };

  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
      }),
    });

    if (!resp.ok) return { error: `TAVILY_HTTP_${resp.status}`, results: [] };

    const data = await resp.json();
    const results = Array.isArray(data.results) ? data.results : [];
    return {
      error: null,
      results: results.map((r) => ({
        title: r.title || "Untitled",
        url: r.url || "",
        content: (r.content || "").slice(0, 500),
      })),
    };
  } catch (e) {
    return { error: "TAVILY_FETCH_FAILED", results: [] };
  }
}

function formatSources(results) {
  const clean = (results || []).filter((r) => r.url);
  if (!clean.length) return "";

  const lines = clean.slice(0, 5).map((r) => `- ${r.title} (${r.url})`);
  return "\n\nREAL-TIME SOURCES:\n" + lines.join("\n");
}

// -------------------- Routes --------------------
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) =>
  res.status(200).json({ ok: true, model: OPENAI_MODEL, has_tavily: !!TAVILY_API_KEY })
);

// Optional: reset memory for the current user
function isResetCommand(text) {
  return /^\/reset\b/i.test(text);
}

app.post("/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const body = req.body || {};
    const text = (body.Body || "").toString().trim();
    const from = (body.From || "").toString().trim() || "unknown";

    // Ignore empty pings
    if (!text) return res.sendStatus(200);

    const user = getUser(from);

    // Allow user to reset their own short-term memory
    if (isResetCommand(text)) {
      user.memory = [];
      await saveDB();
      twiml.message("✅ Context reset. (Short-term memory cleared)");
      return res.type("text/xml").send(twiml.toString());
    }

    // 1) Decide if we need real-time info (semantic intent)
    const intentResp = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: INTENT_PROMPT },
        { role: "user", content: text },
      ],
    });

    const intent = (intentResp.output_text || "").trim();

    // 2) If REALTIME, fetch web sources (optional)
    let webContext = "";
    if (intent === "REALTIME") {
      const ws = await webSearch(text);
      if (!ws.error && ws.results.length) {
        webContext = formatSources(ws.results);
      } else {
        webContext =
          "\n\nNote: Real-time web search is not available or returned no results, so I cannot fully verify up-to-date details.";
      }
    }

    // 3) Build final assistant input with minimal memory
    const input = [
      { role: "system", content: systemPrompt() + webContext },
      ...(user.memory || []),
      { role: "user", content: text },
    ];

    const finalResp = await openai.responses.create({
      model: OPENAI_MODEL,
      input,
    });

    const reply = (finalResp.output_text || "").trim() || "…";

    // 4) Save minimal memory (context only)
    user.memory = cap(
      [
        ...(user.memory || []),
        { role: "user", content: text },
        { role: "assistant", content: reply },
      ],
      MAX_MESSAGES
    );

    await saveDB();

    twiml.message(reply);
    return res.type("text/xml").send(twiml.toString());
  } catch (err) {
    console.error("WHATSAPP ERROR:", err);
    // Always return 200/TwiML to reduce Twilio retry storms
    return res.type("text/xml").send(twiml.toString());
  }
});

// -------------------- Start --------------------
await loadDB();
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
