import "dotenv/config";
import express from "express";
import twilio from "twilio";
import OpenAI from "openai";
import fs from "fs-extra";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.urlencoded({ extended: false }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- DB ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, "assistant_db.json");

const DEFAULT_PROFILE = {
  name: "Zakaria Oulqaid",
  role: "Cybersecurity PhD student (dev profile)",
  phd_topic:
    "Security-by-Design for Smart Factories: Intelligent Threat Detection and Resilience for Industrial IoT and Critical Infrastructures",
  focus:
    "AI-based threat detection, zero trust, resilience for IIoT; datasets & simulation.",
  languages: "Arabic/French/English",
  style: "assistant", // assistant | formal
  preferences:
    "Help me with wellbeing, stress management, and my relationship with Hasnae. Be empathetic, practical, and concise.",
};

const DEFAULT_USER = {
  prefs: { mode: "assistant", lang: "auto" },
  profile: { ...DEFAULT_PROFILE },
  notes: [],
  todos: [],
  plans: {},
  planCursor: null,
  mood: [], // { v: number, note?: string, ts }
  rituals: {
    morning: {}, // { "YYYY-MM-DD": { intention, top3:[], stress, step } }
    night: {}, // { "YYYY-MM-DD": { win, hard, learn, tomorrow } }
  },
  balance: {
    // daily target hours
    targets: { sleep: 7, work: 6, love: 2, health: 1, rest: 1 },
  },
  memory: [],
};

let db = { users: {} };

const nowISO = () => new Date().toISOString();
const newId = () => Math.random().toString(36).slice(2, 10);
const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => {
  const x = new Date(d + "T00:00:00");
  x.setDate(x.getDate() + n);
  return x.toISOString().slice(0, 10);
};
const cap = (a, n) => a.slice(-n);

async function loadDB() {
  if (!(await fs.pathExists(DB_PATH))) await fs.writeJson(DB_PATH, db, { spaces: 2 });
  db = await fs.readJson(DB_PATH);
  db.users ||= {};
}
async function saveDB() {
  await fs.writeJson(DB_PATH, db, { spaces: 2 });
}
function getUser(from) {
  if (!db.users[from]) db.users[from] = structuredClone(DEFAULT_USER);
  // ensure shape if you upgraded from old DB
  const u = db.users[from];
  u.prefs ||= { mode: "assistant", lang: "auto" };
  u.profile ||= { ...DEFAULT_PROFILE };
  u.notes ||= [];
  u.todos ||= [];
  u.plans ||= {};
  u.planCursor ??= null;
  u.mood ||= [];
  u.rituals ||= { morning: {}, night: {} };
  u.rituals.morning ||= {};
  u.rituals.night ||= {};
  u.balance ||= { targets: { sleep: 7, work: 6, love: 2, health: 1, rest: 1 } };
  u.balance.targets ||= { sleep: 7, work: 6, love: 2, health: 1, rest: 1 };
  u.memory ||= [];
  return u;
}

// ---------- Internet (Tavily) ----------
async function webSearch(query) {
  if (!process.env.TAVILY_API_KEY) return { error: "Missing TAVILY_API_KEY" };
  const r = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query, max_results: 5, include_answer: true }),
  });
  return r.json();
}
const fmtSearch = (d) =>
  d?.error
    ? `❌ ${d.error}`
    : !d?.results?.length
    ? "ما لقيتش نتائج."
    : `${d.answer ? `🧠 ${d.answer}\n\n` : ""}🔗 Links:\n` +
      d.results.map((r, i) => `${i + 1}) ${r.title}\n${r.url}`).join("\n\n");

// ---------- Prompt ----------
function systemPrompt(u) {
  const lang =
    u.prefs.lang !== "auto" ? `Reply ONLY in ${u.prefs.lang.toUpperCase()}.` : "Reply in Arabic/French/English.";
  const tone = u.profile.style === "formal" ? "Use formal academic tone when relevant." : "Be warm, empathetic, practical.";
  return [
    "You are a personal WhatsApp assistant.",
    "Adapt to the USER PROFILE and support wellbeing, relationships, focus, and study.",
    lang,
    tone,
    "",
    "USER PROFILE:",
    `Name: ${u.profile.name}`,
    `Role: ${u.profile.role}`,
    `PhD: ${u.profile.phd_topic}`,
    `Focus: ${u.profile.focus}`,
    `Preferences: ${u.profile.preferences}`,
  ].join("\n");
}

// ---------- Helpers ----------
const planDate = (u) => u.planCursor || todayStr();
const planList = (u, d) => (u.plans[d] ||= []);
const showPlan = (u, d) =>
  planList(u, d).length
    ? `📅 ${d}\n` + planList(u, d).map((p) => `${p.done ? "✅" : "⬜"} ${p.id} — ${p.text}`).join("\n")
    : `📅 ${d}\n(empty)`;

function help() {
  return [
    "🤖 Commands:",
    "/help",
    "/profile | /profile set key=value",
    "/checkin | /stress | /breath",
    "/couple <situation>",
    "/focus 45",
    "/plan | /plan add <task> | /plan done <id> | /plan tomorrow",
    "/note <text> | /notes",
    "/todo <text> | /list",
    "/morning | /morning set ...",
    "/night | /night set ...",
    "/balance | /balance set sleep=7 work=6 love=2 health=1 rest=1",
    "/search <q> | /verify <claim>",
  ].join("\n");
}

// ---------- Rituals: Morning / Night ----------
function showMorning(u, date = todayStr()) {
  const m = u.rituals.morning[date];

  const header = [`☀️ Morning + Balance (${date})`];

  const saved = m
    ? [
        `Intention: ${m.intention || "-"}`,
        `Top3: ${(m.top3 || []).join(", ") || "-"}`,
        `Stress: ${m.stress ?? "-"}`,
        `First step: ${m.step || "-"}`,
      ].join("\n")
    : [
        "1) نية اليوم (intention)؟",
        "2) أهم 3 حاجات اليوم؟",
        "3) مستوى الستريس (0–10)؟",
        "4) خطوة صغيرة دابا؟",
        "",
        "Save example:",
        "/morning set intention=Peace top3=thesis,gym,message_hasnae stress=5 step=Start_10min_thesis",
      ].join("\n");

  return [
    header.join("\n"),
    saved,
    "",
    showBalanceSchedule(u, date),
    "",
    "Auto plan: /morning auto",
  ].join("\n");
}

function showNight(u, date = todayStr()) {
  const n = u.rituals.night[date];
  if (!n) {
    return [
      `🌙 Night (${date})`,
      "1) شنو ربحتي/داز مزيان اليوم؟ (win)",
      "2) شنو كان صعيب؟ (hard)",
      "3) شنو تعلمتي؟ (learn)",
      "4) شنو أول حاجة غدا؟ (tomorrow)",
      "",
      "Save example:",
      "/night set win=Finished section hard=Stress learn=Take breaks tomorrow=Write outline",
    ].join("\n");
  }
  return [
    `🌙 Night (${date})`,
    `Win: ${n.win || "-"}`,
    `Hard: ${n.hard || "-"}`,
    `Learn: ${n.learn || "-"}`,
    `Tomorrow: ${n.tomorrow || "-"}`,
  ].join("\n");
}

function parseKeyValues(raw) {
  // supports: key=value key2=value2 ...
  // and top3=a,b,c
  const parts = raw.split(" ").filter(Boolean);
  const out = {};
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

// ---------- Balance ----------
function showBalance(u) {
  const t = u.balance.targets;
  return [
    "⚖️ Balance targets (hours/day):",
    `sleep=${t.sleep}, work=${t.work}, love=${t.love}, health=${t.health}, rest=${t.rest}`,
    "",
    "Tip: دير plan اليوم ووزّع وقتك عليها.",
    "Edit example: /balance set sleep=7 work=6 love=2 health=1 rest=1",
  ].join("\n");
}
function showBalanceSchedule(u, date = todayStr()) {
  const t = u.balance.targets;
  const plan = planList(u, date);
  const tasks = plan.filter(x => !x.done).map(x => x.text);

  // Simple schedule proposal (not strict times, just blocks)
  const blocks = [
    `🛌 Sleep: ${t.sleep}h`,
    `💼 Work/Thesis: ${t.work}h`,
    `❤️ Love/Relationship: ${t.love}h`,
    `🏃 Health: ${t.health}h`,
    `🧘 Rest: ${t.rest}h`,
  ];

  const tasksLine = tasks.length ? `📌 Today tasks (from /plan): ${tasks.slice(0,5).join(" | ")}` : "📌 No tasks yet. Add with /plan add ...";

  return [
    `⚖️ Balance schedule (${date})`,
    blocks.join("\n"),
    "",
    tasksLine,
    "",
    "Tip: دير 2 blocs ديال thesis (مثلاً 2×90min) وخلّي وقت للحياة ❤️",
  ].join("\n");
}


function setBalance(u, raw) {
  const kv = parseKeyValues(raw);
  const keys = ["sleep", "work", "love", "health", "rest"];
  let changed = 0;

  for (const k of keys) {
    if (kv[k] !== undefined) {
      const num = Number(kv[k]);
      if (!Number.isFinite(num) || num < 0 || num > 24) continue;
      u.balance.targets[k] = num;
      changed++;
    }
  }
  return changed ? "✅ Balance updated." : "Use: /balance set sleep=7 work=6 love=2 health=1 rest=1";
}

// ---------- Commands ----------
async function handleCommand(text, from) {
  const u = getUser(from);
  const low = text.toLowerCase();

  // help/profile
  if (low === "/help") return help();
  if (low === "/profile")
    return Object.entries(u.profile)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
  if (low.startsWith("/profile set ")) {
    const rest = text.replace("/profile set ", "");
    const idx = rest.indexOf("=");
    if (idx === -1) return "Use: /profile set key=value";
    const key = rest.slice(0, idx).trim();
    const value = rest.slice(idx + 1).trim();
    if (!key || !value) return "Use: /profile set key=value";
    u.profile[key] = value;
    await saveDB();
    return "✅ Profile updated.";
  }

  // wellbeing
  if (low === "/checkin") return "كيف داير دابا (0–10)؟ شنو السبب؟ شنو محتاج دابا؟ خطوة صغيرة؟";
  if (low === "/stress") return "⏸️ Pause 30s → تنفّس → رتب فكرة وحدة → دير خطوة 2 دقايق.";
  if (low === "/breath") return "😮‍💨 4-4-6: شهيق 4، حبس 4، زفير 6 ×5 مرات.";

  // relationship
  if (low.startsWith("/couple ")) {
    const s = text.slice(8).trim();
    return [
      "💙 Couple coach (3 رسائل):",
      `1) هادئة: "كنحس بالضغط شوية، وباغي نهضرو بهدوء باش نفهموك ونفهميني."`,
      `2) رومانسية: "حسناء كنقدّرك بزاف، وبغيت نصلحوها بيناتنا بحب وهدوء."`,
      `3) واضحة: "بغيت نتفقو على… باش ما يتعاودش نفس المشكل."`,
      "",
      `📌 Situation: ${s}`,
      "بغيتك تجاوبني: شنو بغيتي منها بالضبط؟ وشنو الحاجة اللي كتحسها ناقصة دابا؟",
    ].join("\n");
  }

  // focus
  if (low.startsWith("/focus")) {
    const m = Number(text.split(" ")[1] || 45);
    const minutes = Number.isFinite(m) ? m : 45;
    return `🎯 Focus ${minutes}min: هدف واحد، notifications off، break 5min، ومن بعد راجع شنو درتي.`;
  }

  // plan
  if (low === "/plan") return showPlan(u, planDate(u));
  if (low === "/plan tomorrow") {
    u.planCursor = addDays(todayStr(), 1);
    await saveDB();
    return showPlan(u, u.planCursor);
  }
  if (low.startsWith("/plan add ")) {
    const t = text.slice(10).trim();
    if (!t) return "Use: /plan add <task>";
    const d = planDate(u);
    planList(u, d).push({ id: newId(), text: t, done: false, ts: nowISO() });
    await saveDB();
    return `✅ Added to plan (${d}).`;
  }
  if (low.startsWith("/plan done ")) {
    const id = text.slice(11).trim();
    const it = planList(u, planDate(u)).find((x) => x.id === id);
    if (!it) return "Not found. Use /plan to see ids.";
    it.done = true;
    await saveDB();
    return "✅ Done.";
  }

  // notes / todos
  if (low.startsWith("/note ")) {
    const t = text.slice(6).trim();
    if (!t) return "Use: /note <text>";
    u.notes.push({ id: newId(), text: t, ts: nowISO() });
    await saveDB();
    return "📝 Saved.";
  }
  if (low === "/notes") return u.notes.map((n) => `• ${n.id} ${n.text}`).join("\n") || "No notes.";
  if (low.startsWith("/todo ")) {
    const t = text.slice(6).trim();
    if (!t) return "Use: /todo <text>";
    u.todos.push({ id: newId(), text: t, done: false, ts: nowISO() });
    await saveDB();
    return "✅ Todo added.";
  }
  if (low === "/list") return u.todos.map((t) => `${t.done ? "✅" : "⬜"} ${t.id} ${t.text}`).join("\n") || "No todos.";

  // morning / night
  if (low === "/morning") return showMorning(u, todayStr());
if (low === "/morning auto") {
  const d = todayStr();
  // Build a simple plan based on balance targets + top3
  const t = u.balance.targets;
  const m = u.rituals.morning[d] || {};
  const top3 = Array.isArray(m.top3) ? m.top3 : [];

  // reset today's plan
  u.plans[d] = [];

  // Core blocks
  u.plans[d].push({ id: newId(), text: `Thesis/Work block 1 (≈${Math.max(1, Math.round(t.work/2))}h)`, done: false, ts: nowISO() });
  u.plans[d].push({ id: newId(), text: `Thesis/Work block 2 (≈${Math.max(1, Math.round(t.work/2))}h)`, done: false, ts: nowISO() });
  u.plans[d].push({ id: newId(), text: `Health (≈${t.health}h): walk/gym/stretch`, done: false, ts: nowISO() });
  u.plans[d].push({ id: newId(), text: `Love/Connection (≈${t.love}h): message/call quality time`, done: false, ts: nowISO() });
  u.plans[d].push({ id: newId(), text: `Rest (≈${t.rest}h): calm time, no phone`, done: false, ts: nowISO() });

  // Add Top3 as explicit tasks
  for (const x of top3.slice(0, 3)) {
    u.plans[d].push({ id: newId(), text: `Top3: ${x}`, done: false, ts: nowISO() });
  }

  await saveDB();
  return "✅ Built today's plan from Balance + Morning. Send /plan to see it.";
}

  if (low.startsWith("/morning set ")) {
    const raw = text.slice("/morning set ".length).trim();
    const kv = parseKeyValues(raw);
    const d = todayStr();
    u.rituals.morning[d] ||= {};
    if (kv.intention) u.rituals.morning[d].intention = kv.intention.replace(/_/g, " ");
    if (kv.top3) u.rituals.morning[d].top3 = kv.top3.split(",").map((x) => x.trim()).filter(Boolean);
    if (kv.stress !== undefined) {
      const s = Number(kv.stress);
      if (Number.isFinite(s)) u.rituals.morning[d].stress = s;
    }
    if (kv.step) u.rituals.morning[d].step = kv.step.replace(/_/g, " ");
    await saveDB();
    return showMorning(u, d);
  }

  if (low === "/night") return showNight(u, todayStr());
  if (low.startsWith("/night set ")) {
    const raw = text.slice("/night set ".length).trim();
    const kv = parseKeyValues(raw);
    const d = todayStr();
    u.rituals.night[d] ||= {};
    if (kv.win) u.rituals.night[d].win = kv.win.replace(/_/g, " ");
    if (kv.hard) u.rituals.night[d].hard = kv.hard.replace(/_/g, " ");
    if (kv.learn) u.rituals.night[d].learn = kv.learn.replace(/_/g, " ");
    if (kv.tomorrow) u.rituals.night[d].tomorrow = kv.tomorrow.replace(/_/g, " ");
    await saveDB();
    return showNight(u, d);
  }

  // balance
  if (low === "/balance") return showBalance(u);
  if (low.startsWith("/balance set ")) {
    const raw = text.slice("/balance set ".length).trim();
    const msg = setBalance(u, raw);
    await saveDB();
    return msg + "\n\n" + showBalance(u);
  }

  // internet
  if (low.startsWith("/search ")) return fmtSearch(await webSearch(text.slice(8).trim()));
  if (low.startsWith("/verify ")) return fmtSearch(await webSearch(("verify " + text.slice(8)).trim()));

  return null;
}

// ---------- Routes ----------
app.get("/", (_, res) => res.send("OK"));

app.post("/whatsapp", async (req, res) => {
  const twiml = new twilio.twiml.MessagingResponse();
  const text = (req.body.Body || "").trim();
  const from = req.body.From || "unknown";

  if (!text) {
    twiml.message("Send a message 🙂");
    return res.type("text/xml").send(twiml.toString());
  }

  if (text.startsWith("/")) {
    twiml.message((await handleCommand(text, from)) || "Unknown. /help");
    return res.type("text/xml").send(twiml.toString());
  }

  const u = getUser(from);

  const input = [
    { role: "system", content: systemPrompt(u) },
    ...u.memory,
    { role: "user", content: text },
  ];

  const r = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input,
  });

  const reply = (r.output_text || "").trim() || "…";

  u.memory = cap([...u.memory, { role: "user", content: text }, { role: "assistant", content: reply }], 20);
  await saveDB();

  twiml.message(reply);
  res.type("text/xml").send(twiml.toString());
});

// ---------- Start ----------
await loadDB();
app.listen(process.env.PORT || 3000, () => console.log("✅ Assistant ready"));
