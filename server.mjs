// =====================================================================================
// LOVE IN LAGOS: BACKEND (PostgreSQL).
// Run inside this backend folder: npm install, then DATABASE_URL=postgres://... node server.mjs (needs Node.js 22.13 or newer)
// Then open http://localhost:3000. Website files are in the ../frontend folder.
// Settings (environment variables): DATABASE_URL (required), JWT_SECRET, PORT, ALLOWED_ORIGIN, DEMO=false, PG_POOL_MAX, PGSSL=false
// =====================================================================================
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  console.error(`\nLove in Lagos needs Node.js 22.13 or newer. You have ${process.versions.node}.\nInstall the current version from https://nodejs.org, close and reopen your terminal, then try again.\n`);
  process.exit(1);
}

if (existsSync(".env")) {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
let {
  JWT_SECRET,
  ALLOWED_ORIGIN = "*",
  DEMO = "true"
} = process.env;

const DEMO_MODE = String(DEMO).trim().toLowerCase() !== "false";

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("PORT must be a valid TCP port number.");
  process.exit(1);
}

const FRONT = [
  process.env.FRONTEND_DIR,
  path.join(import.meta.dirname, "..", "frontend"),
  path.join(import.meta.dirname, "..", "love-in-lagos-frontend"),
  path.join(import.meta.dirname, "frontend")
].filter(Boolean);

const PUBLIC = FRONT.find(d => existsSync(path.join(d, "index.html"))) || null;

process.on("unhandledRejection", e => console.error("error:", e && e.message));

if (!JWT_SECRET || JWT_SECRET.length < 24) {
  JWT_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("No JWT_SECRET set: using a temporary one. Everyone is logged out when the server restarts. Set JWT_SECRET for a real launch.");
}

// ---------- database: PostgreSQL ----------
const DATABASE_URL = process.env.DATABASE_URL || "";
if (!DATABASE_URL) {
  console.error("\nDATABASE_URL is not set.\nOn Render: create a PostgreSQL database, copy its INTERNAL Database URL, and add it to this service as the environment variable DATABASE_URL.");
  process.exit(1);
}
let pg;
try { pg = (await import("pg")).default; } catch {
  console.error("\nThe 'pg' package is not installed.\nOn Render set the service's Build Command to: npm install      (locally run: npm install)");
  process.exit(1);
}
const { AsyncLocalStorage } = await import("node:async_hooks");
pg.types.setTypeParser(20, v => Number(v));     // BIGINT and COUNT(*) come back as numbers
pg.types.setTypeParser(1700, v => Number(v));   // NUMERIC and SUM(...) come back as numbers

const needSsl = (() => {
  try { const h = new URL(DATABASE_URL).hostname; return h.includes(".") && !/^(localhost|127\.|10\.|192\.168\.)|\.internal$/.test(h); }
  catch { return false; }
})();
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ssl: process.env.PGSSL === "false" ? false : needSsl ? { rejectUnauthorized: false } : false
});
pool.on("error", e => console.error("database pool error:", e.message));

// Every query goes through these. SQL keeps the simple ? placeholders; they are turned into $1, $2... here.
const als = new AsyncLocalStorage();   // while a transaction runs, its queries all use that transaction's connection
const q = (sql, a) => {
  let n = 0;
  const text = sql.replace(/\?/g, () => "$" + (++n));
  // PostgreSQL is stricter than SQLite: no true/false into number columns, no NaN, no decimals into whole-number columns.
  const params = a.map(v => v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" ? (Number.isFinite(v) ? (Number.isInteger(v) ? v : Math.round(v)) : null) : v);
  return (als.getStore() || pool).query(text, params);
};
const one = async (s, ...a) => (await q(s, a)).rows[0];
const all = async (s, ...a) => (await q(s, a)).rows;
const run = async (s, ...a) => { const r = await q(s, a); return { changes: r.rowCount, rows: r.rows }; };
const tx = async fn => {
  const c = await pool.connect();
  try { await c.query("BEGIN"); const r = await als.run(c, fn); await c.query("COMMIT"); return r; }
  catch (e) { try { await c.query("ROLLBACK"); } catch {} throw e; }
  finally { c.release(); }
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users(
    id BIGSERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    name TEXT NOT NULL,
    age INTEGER NOT NULL DEFAULT 0,
    gender TEXT NOT NULL DEFAULT '',
    bio TEXT DEFAULT '',
    area TEXT DEFAULT '',
    fav TEXT DEFAULT '',
    look TEXT DEFAULT '[]',
    interests TEXT DEFAULT '[]',
    avatar TEXT DEFAULT '{}',
    photo TEXT DEFAULT '',
    loc INTEGER NOT NULL DEFAULT -1,
    seen BIGINT NOT NULL DEFAULT 0,
    bot INTEGER NOT NULL DEFAULT 0,
    pw TEXT NOT NULL,
    game TEXT DEFAULT '{}',
    created BIGINT NOT NULL,
    tv INTEGER NOT NULL DEFAULT 0,
    xp BIGINT NOT NULL DEFAULT 0,
    boost_until BIGINT NOT NULL DEFAULT 0,
    spent BIGINT NOT NULL DEFAULT 0,
    gin BIGINT NOT NULL DEFAULT 0,
    outfits TEXT NOT NULL DEFAULT '[]',
    streak INTEGER NOT NULL DEFAULT 0,
    best INTEGER NOT NULL DEFAULT 0,
    last_day TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users(LOWER(username))`,
  `CREATE INDEX IF NOT EXISTS users_bot ON users(bot)`,
  `CREATE TABLE IF NOT EXISTS requests(
    id BIGSERIAL PRIMARY KEY,
    from_id BIGINT NOT NULL,
    to_id BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    pct INTEGER NOT NULL DEFAULT 0,
    created BIGINT NOT NULL,
    auto INTEGER NOT NULL DEFAULT 0,
    UNIQUE(from_id,to_id)
  )`,
  `CREATE INDEX IF NOT EXISTS requests_to ON requests(to_id,status)`,
  `CREATE INDEX IF NOT EXISTS requests_from ON requests(from_id,status)`,
  `CREATE TABLE IF NOT EXISTS messages(
    id BIGSERIAL PRIMARY KEY,
    from_id BIGINT NOT NULL,
    to_id BIGINT NOT NULL,
    text TEXT NOT NULL,
    created BIGINT NOT NULL
  )`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to BIGINT`,
  `CREATE INDEX IF NOT EXISTS messages_pair ON messages(from_id,to_id,id)`,
  `CREATE INDEX IF NOT EXISTS messages_to ON messages(to_id,from_id,id)`,
  `CREATE TABLE IF NOT EXISTS blocks(
    by_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    PRIMARY KEY(by_id,user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS reports(
    id BIGSERIAL PRIMARY KEY,
    by_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    reason TEXT NOT NULL,
    created BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS games(
    id BIGSERIAL PRIMARY KEY,
    a_id BIGINT NOT NULL,
    b_id BIGINT NOT NULL,
    status TEXT NOT NULL,
    qs TEXT NOT NULL DEFAULT '[]',
    i INTEGER NOT NULL DEFAULT 0,
    asked INTEGER NOT NULL DEFAULT 0,
    created BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS games_a ON games(a_id)`,
  `CREATE INDEX IF NOT EXISTS games_b ON games(b_id)`,
  `CREATE TABLE IF NOT EXISTS game_answers(
    game_id BIGINT NOT NULL,
    qi INTEGER NOT NULL,
    user_id BIGINT NOT NULL,
    text TEXT NOT NULL,
    created BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY(game_id,qi)
  )`,
  `CREATE TABLE IF NOT EXISTS game_used(
    user_id BIGINT NOT NULL,
    q INTEGER NOT NULL,
    PRIMARY KEY(user_id,q)
  )`,
  `CREATE TABLE IF NOT EXISTS profile_views(
    viewer_id BIGINT NOT NULL,
    viewed_id BIGINT NOT NULL,
    created BIGINT NOT NULL,
    PRIMARY KEY(viewer_id,viewed_id)
  )`,
  `CREATE TABLE IF NOT EXISTS activity(
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    created BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS activity_user ON activity(user_id,id)`,
  `CREATE TABLE IF NOT EXISTS daily_answers(
    user_id BIGINT NOT NULL,
    day TEXT NOT NULL,
    q TEXT NOT NULL,
    answer TEXT NOT NULL,
    correct TEXT NOT NULL,
    ok INTEGER NOT NULL,
    created BIGINT NOT NULL,
    PRIMARY KEY(user_id,day)
  )`,
  `CREATE TABLE IF NOT EXISTS resets(
    user_id BIGINT PRIMARY KEY,
    code TEXT NOT NULL,
    exp BIGINT NOT NULL,
    tries INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS xp_events(
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    day TEXT NOT NULL,
    amount BIGINT NOT NULL,
    reason TEXT NOT NULL,
    created BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS xp_events_user_day ON xp_events(user_id,day)`,
  `CREATE INDEX IF NOT EXISTS xp_events_day ON xp_events(day)`,
  `CREATE TABLE IF NOT EXISTS notifs(
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    from_id BIGINT NOT NULL DEFAULT 0,
    created BIGINT NOT NULL,
    isread INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS notifs_user ON notifs(user_id,id)`,
  `CREATE TABLE IF NOT EXISTS cupid(
    id BIGSERIAL PRIMARY KEY,
    from_id BIGINT NOT NULL,
    a BIGINT NOT NULL,
    b BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created BIGINT NOT NULL
  )`,
  // Amebo of the Day
  `CREATE TABLE IF NOT EXISTS amebo_gists(
    id TEXT PRIMARY KEY,
    day TEXT NOT NULL,
    user_id BIGINT NOT NULL,
    category TEXT NOT NULL,
    body TEXT NOT NULL,
    anonymous INTEGER NOT NULL DEFAULT 1,
    created BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS amebo_gists_day_idx ON amebo_gists(day, created)`,
  `CREATE TABLE IF NOT EXISTS amebo_posted(
    user_id BIGINT NOT NULL,
    day TEXT NOT NULL,
    gist_id TEXT NOT NULL PRIMARY KEY
  )`,
  `CREATE INDEX IF NOT EXISTS amebo_posted_user_day ON amebo_posted(user_id, day)`,
  `CREATE TABLE IF NOT EXISTS amebo_reactions(
    gist_id TEXT NOT NULL,
    user_id BIGINT NOT NULL,
    emoji TEXT NOT NULL,
    created BIGINT NOT NULL,
    PRIMARY KEY(gist_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS amebo_reports(
    gist_id TEXT NOT NULL,
    user_id BIGINT NOT NULL,
    created BIGINT NOT NULL,
    PRIMARY KEY(gist_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS amebo_reads(
    user_id BIGINT NOT NULL,
    day TEXT NOT NULL,
    gist_id TEXT NOT NULL,
    created BIGINT NOT NULL,
    PRIMARY KEY(user_id, day, gist_id)
  )`,
  `CREATE TABLE IF NOT EXISTS amebo_streaks(
    user_id BIGINT PRIMARY KEY,
    streak INTEGER NOT NULL DEFAULT 0,
    best INTEGER NOT NULL DEFAULT 0,
    last_day TEXT NOT NULL DEFAULT ''
  )`
];
{
  // A lock makes this safe even if two copies of the server start at the same moment.
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock(727274)");
    for (const stmt of SCHEMA) await c.query(stmt);
  } catch (e) {
    console.error("Could not set up the database:", e.message);
    process.exit(1);
  } finally {
    try { await c.query("SELECT pg_advisory_unlock(727274)"); } catch {}
    c.release();
  }
}
process.on("SIGTERM", () => { pool.end().finally(() => process.exit(0)); });   // Render sends this on every redeploy

const QCOUNT = 700;


// Passwords: scrypt hash. Sessions: signed token valid for 30 days.
const hash = pw => {
  const s = crypto.randomBytes(16);
  return s.toString("hex") + ":" + crypto.scryptSync(pw, s, 64).toString("hex");
};

// Validate the stored hash before decoding or comparing it.
// This prevents malformed database values from crashing login.
const check = (pw, h) => {
  try {
    if (typeof h !== "string" || !/^[a-f0-9]{32}:[a-f0-9]{128}$/i.test(h)) return false;
    const [s, k] = h.split(":");
    const expected = crypto.scryptSync(String(pw), Buffer.from(s, "hex"), 64);
    const actual = Buffer.from(k, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
};

const mac = p => crypto.createHmac("sha256", JWT_SECRET).update(p).digest("base64url");

const sign = (uid, tv = 0) => {
  const p = Buffer.from(JSON.stringify({
    uid,
    tv,
    exp: Date.now() + 30 * 864e5
  })).toString("base64url");
  return p + "." + mac(p);
};

const verify = t => {
  try {
    const [p, s] = String(t || "").split(".");
    if (!p || !s) return null;
    const ok = mac(p);
    if (s.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(ok))) return null;
    const d = JSON.parse(Buffer.from(p, "base64url"));
    return d.exp > Date.now() ? d : null;
  } catch {
    return null;
  }
};

const J = (t, d) => {
  try { return JSON.parse(t); } catch { return d; }
};

const UN = /^[a-z0-9_.]{3,20}$/;

const cleanAv = (a, own = []) => {
  const o = {};
  for (const k of ["sk", "hc", "sh", "bg"]) {
    if (/^#[0-9a-f]{6}$/i.test(a?.[k])) o[k] = a[k];
  }
  for (const [k, mx] of [["hs", 4], ["ac", 3], ["mo", 2]]) {
    if (Number.isInteger(a?.[k]) && a[k] >= 0 && a[k] <= mx) o[k] = a[k];
  }
  for (const [k, mx] of [["ot", 5], ["hat", 3]]) {
    if (Number.isInteger(a?.[k]) && a[k] > 0 && a[k] <= mx && own.includes(k + a[k])) o[k] = a[k];
  }
  return o;
};

const pub = u => ({
  id: u.id,
  username: u.username,
  name: u.name,
  bio: u.bio,
  look: J(u.look, []),
  fav: u.fav,
  area: u.area,
  interests: J(u.interests, []),
  avatar: J(u.avatar, {}),
  online: u.seen > Date.now() - 90000,
  loc: u.loc
});

const logA = async (uid, kind, text) =>
  await run("INSERT INTO activity(user_id,kind,text,created) VALUES(?,?,?,?)",
    uid, kind, String(text).slice(0, 120), Date.now());

const lagosDay = (off = 0) =>
  new Date(Date.now() + 3600000 - off * 864e5).toISOString().slice(0, 10);

const award = async (uid, n, why, cap = 0) => {
  if (cap) {
    n = Math.min(
      n,
      cap - (await one(
        "SELECT COALESCE(SUM(amount),0) s FROM xp_events WHERE user_id=? AND day=? AND reason=?",
        uid, lagosDay(), why
      )).s
    );
  }
  if (n <= 0) return 0;
  await run("INSERT INTO xp_events(user_id,day,amount,reason,created) VALUES(?,?,?,?,?)",
    uid, lagosDay(), n, why, Date.now());
  await run("UPDATE users SET xp=xp+? WHERE id=?", n, uid);
  return n;
};

const notify = async (uid, kind, text, from = 0) =>
  await run("INSERT INTO notifs(user_id,kind,text,from_id,created) VALUES(?,?,?,?,?)",
    uid, kind, String(text).slice(0, 140), from, Date.now());

// The 100th message between two people unlocks their profile pictures. Tell both of them, exactly once
// (only the message that is number 100 counts, so a simultaneous send can't trigger it twice or skip it).
const checkPhotoUnlock = async (a, b, msgId) => {
  const nth = (await one(
    "SELECT COUNT(*) n FROM messages WHERE id<=? AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))",
    msgId, a, b, b, a
  )).n;
  if (nth !== 100) return false;
  await notify(a, "photos", "📸 You and " + await nameOf(b) + " can now see each other's profile pictures!", b);
  await notify(b, "photos", "📸 You and " + await nameOf(a) + " can now see each other's profile pictures!", a);
  return true;
};

const lvl = p =>
  p >= 95 ? "💖 Perfect match" :
  p >= 80 ? "🔥 Sparks flying" :
  p > 50 ? "✨ Real potential" : "🌱 Worth a trial";

const nameOf = async id => (await one("SELECT name FROM users WHERE id=?", id))?.name || "Someone";

const OUTFITS = [
  ["ot1", "Ankara shirt", 1000, "ot", 1],
  ["ot2", "Suit & tie", 1500, "ot", 2],
  ["ot3", "Agbada", 2500, "ot", 3],
  ["ot4", "Hoodie", 1200, "ot", 4],
  ["ot5", "Gold chain", 1800, "ot", 5],
  ["hat1", "Gele", 2000, "hat", 1],
  ["hat2", "Fila cap", 1000, "hat", 2],
  ["hat3", "Crown", 5000, "hat", 3]
];

const bumpStreak = async uid => {
  const r = await one("SELECT streak,last_day FROM users WHERE id=?", uid);
  const t = lagosDay();
  if (r.last_day === t) return;

  const n = r.last_day === lagosDay(1) ? r.streak + 1 : 1;
  await run("UPDATE users SET streak=?,best=GREATEST(best,?),last_day=? WHERE id=?", n, n, t, uid);
  await award(uid, Math.min(n, 7) * 5, "streak");

  if ([3, 7, 14, 30].includes(n)) {
    await notify(uid, "streak", "🔥 " + n + "-day streak! Keep it going.");
  }
};

const badgesOf = async (uid, best) => {
  const b = [];

  if (best >= 3) b.push("🔥 Warming up");
  if (best >= 7) b.push("🔥🔥 Week warrior");
  if (best >= 30) b.push("👑 Lagos Legend");

  for (const r of await all(
    "SELECT SUBSTR(text, POSITION(' at ' IN text)+4) AS s, COUNT(*) AS c FROM activity WHERE user_id=? AND kind='act' AND POSITION(' at ' IN text)>0 GROUP BY 1 HAVING COUNT(*)>=10",
    uid
  )) {
    b.push("📍 " + r.s + " regular");
  }

  if ((await one("SELECT COUNT(*) c FROM requests WHERE status='accepted' AND (from_id=? OR to_id=?)", uid, uid)).c >= 5) {
    b.push("💞 Social butterfly");
  }

  const cm = (await one("SELECT COUNT(*) c FROM cupid WHERE from_id=? AND status='matched'", uid)).c;
  if (cm >= 10) b.push("💒 Aunty Matchmaker");
  else if (cm >= 5) b.push("🏹 Head Cupid");
  else if (cm >= 1) b.push("💘 Cupid");

  return b;
};

const cupidSettle = async uid => {
  for (const c of await all("SELECT * FROM cupid WHERE from_id=? AND status='open' ORDER BY id", uid)) {
    if (await one(
      "SELECT 1 x FROM requests WHERE status='accepted' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))",
      c.a, c.b, c.b, c.a
    )) {
      await run("UPDATE cupid SET status='matched' WHERE id=?", c.id);
      await award(uid, 60, "cupid");
      await notify(uid, "cupid", "🎉 Your match worked! " + await nameOf(c.a) + " and " + await nameOf(c.b) + " matched. +60 XP", c.a);
    }
  }
};

const DAILY = [
  ["Freedom Park Sunday", "How many players are on a 5-a-side team?", ["7", "5", "11"], 1],
  ["Rainy Monday", "Which yellow bus is the icon of Lagos roads?", ["Danfo", "Gondola", "Tuk-tuk"], 0],
  ["Tech Tuesday", "Which Lagos area is nicknamed Yabacon Valley?", ["Ikoyi", "Surulere", "Yaba"], 2],
  ["Waka Wednesday", "Which snack pairs with roasted corn?", ["Pear (ube)", "Chocolate", "Popcorn"], 0],
  ["Throwback Thursday", "Which famous market is on Lagos Island?", ["Wuse", "Balogun", "Onitsha"], 1],
  ["Detty Friday", "Which dance craze is a Lagos favourite?", ["Polka", "Shoki", "Tango"], 1],
  ["Beach Saturday", "Which beach is a Lekki favourite?", ["Waikiki", "Bondi", "Elegushi"], 2]
];

const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

const texts = async (a, b) =>
  (await one("SELECT COUNT(*) n FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)",
    a, b, b, a)).n;

const streak3 = async (a, b) => {
  const days = (await all(
    "SELECT TO_CHAR(TO_TIMESTAMP((created/1000)+3600) AT TIME ZONE 'UTC','YYYY-MM-DD') AS d FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) GROUP BY 1 HAVING COUNT(*)>=10 ORDER BY 1",
    a, b, b, a
  )).map(x => Date.parse(x.d));

  let r = 1;
  for (let i = 1; i < days.length; i++) {
    r = days[i] - days[i - 1] === 864e5 ? r + 1 : 1;
    if (r >= 3) return true;
  }
  return false;
};

const STOP = new Set(
  "this that with have from your about just like love lagos and the for are but you not who what when where been into than then them they their there here very much more some also".split(" ")
);

const wordsOf = t =>
  new Set((String(t || "").toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOP.has(w)));

const compat = (a, b) => {
  const ia = J(a.interests, []);
  const ib = J(b.interests, []);
  const la = J(a.look, []);
  const lb = J(b.look, []);
  const wb = wordsOf(b.bio);

  const si = ia.filter(x => ib.includes(x));
  const sl = la.filter(x => lb.includes(x));
  const sw = [...wordsOf(a.bio)].filter(w => wb.has(w));

  const ra = (n, x, y) => n / Math.max(1, Math.min(x, y));
  const sa = !!a.area && a.area === b.area;
  const sf = !!a.fav && a.fav === b.fav;

  const jit = crypto.createHash("sha256")
    .update([a.id, b.id].sort((x, y) => x - y).join("|"))
    .digest()[0] % 41;

  const sim =
    32 * ra(si.length, ia.length, ib.length) +
    20 * Math.min(1, sw.length / 3) +
    (sa ? 5 : 0) +
    (sf ? 3 : 0);

  const pct = Math.round(Math.min(100, 12 + jit + sim));

  return {
    pct,
    why: [...si, ...sw.slice(0, 2), ...(sa ? ["both in " + a.area] : [])].slice(0, 5)
  };
};

const full = u => ({
  ...pub(u),
  xp: u.xp,
  bal: u.xp + u.gin - u.spent,
  outfits: J(u.outfits, []),
  boost: u.boost_until,
  email: u.email,
  photo: u.photo || "",
  fav: u.fav,
  look: J(u.look, []),
  game: J(u.game, {})
});

const blocked = async (a, b) =>
  !!await one("SELECT 1 x FROM blocks WHERE (by_id=? AND user_id=?) OR (by_id=? AND user_id=?)", a, b, b, a);

const friends = async (a, b) =>
  !!await one("SELECT 1 x FROM requests WHERE status='accepted' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))",
    a, b, b, a);

const validUserId = value =>
  Number.isSafeInteger(Number(value)) && Number(value) > 0;

// Simple in-memory rate limiter (per IP)
const hits = new Map();

const limit = (ip, k, max) => {
  const key = ip + k;
  const n = Date.now();
  const h = hits.get(key);

  if (!h || h[1] < n) {
    hits.set(key, [1, n + 6e4]);
    return true;
  }

  return ++h[0] <= max;
};

setInterval(() => hits.clear(), 5 * 6e4).unref();

// Optional real emails for password resets: set RESEND_API_KEY and MAIL_FROM.
async function sendMail(to, subject, text) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || "Love in Lagos <onboarding@resend.dev>",
        to: [to],
        subject,
        text
      })
    });
    return r.ok;
  } catch {
    return false;
  }
}


const AMEBO_MAX = 3;
const ameboPosted = async (uid, day) => (await one("SELECT COUNT(*) n FROM amebo_posted WHERE user_id=? AND day=?", uid, day)).n;
const AMEBO_CATEGORIES = new Set(["rel", "fri", "lag", "con", "rnd"]);
const AMEBO_REACTIONS = new Set(["😂", "👀", "❤️", "🍿", "😭"]);
const ameboResetAt = () => {
  const d = new Date(Date.now() + 3600000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 3600000;
};
const ameboBump = async uid => {
  const day = lagosDay();
  const old = await one("SELECT streak,last_day FROM amebo_streaks WHERE user_id=?", uid);
  if (old && old.last_day === day) return;
  const streak = old && old.last_day === lagosDay(1) ? old.streak + 1 : 1;
  await run(
    `INSERT INTO amebo_streaks(user_id,streak,best,last_day) VALUES(?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET streak=excluded.streak,
       best=GREATEST(amebo_streaks.best,excluded.streak),last_day=excluded.last_day`,
    uid, streak, streak, day
  );
};
const ameboReactionCounts = async gistId => {
  const counts = {};
  for (const r of await all(
    "SELECT emoji,COUNT(*) n FROM amebo_reactions WHERE gist_id=? GROUP BY emoji",
    gistId
  )) counts[r.emoji] = r.n;
  return counts;
};
const ameboView = async (g, viewerId) => {
  const author = g.anonymous ? null : await one(
    "SELECT id,username,name,avatar FROM users WHERE id=?",
    g.user_id
  );
  return {
    id: g.id,
    cat: g.category,
    text: g.body,
    at: g.created,
    anon: !!g.anonymous,
    author: author ? { ...author, avatar: J(author.avatar, {}) } : null,
    mine: g.user_id === viewerId,
    reactions: await ameboReactionCounts(g.id),
    my: (await one(
      "SELECT emoji FROM amebo_reactions WHERE gist_id=? AND user_id=?",
      g.id, viewerId
    ))?.emoji || null
  };
};
const ameboLiveGists = async (uid, day = lagosDay()) => await all(
  `SELECT g.* FROM amebo_gists g
   WHERE g.day=? AND
   (SELECT COUNT(*) FROM amebo_reports r WHERE r.gist_id=g.id) < 3
   ORDER BY g.created DESC`,
  day
);
const ameboPrune = async () => {
  const day = lagosDay();
  await run("DELETE FROM amebo_reactions WHERE gist_id IN (SELECT id FROM amebo_gists WHERE day<>?)", day);
  await run("DELETE FROM amebo_reports WHERE gist_id IN (SELECT id FROM amebo_gists WHERE day<>?)", day);
  await run("DELETE FROM amebo_reads WHERE day<>? OR gist_id IN (SELECT id FROM amebo_gists WHERE day<>?)", day, day);
  await run("DELETE FROM amebo_gists WHERE day<>?", day);
  await run("DELETE FROM amebo_posted WHERE day<>?", day);
};
const ameboState = async uid => {
  const day = lagosDay();
  const mineRows = await all(
    `SELECT g.* FROM amebo_gists g
     WHERE g.user_id=? AND g.day=? AND
       (SELECT COUNT(*) FROM amebo_reports r WHERE r.gist_id=g.id) < 3
     ORDER BY g.created DESC`,
    uid, day
  );
  const mine = mineRows[0];
  const posted = await ameboPosted(uid, day);
  const total = (await one(
    `SELECT COUNT(*) n FROM amebo_gists g
     WHERE g.day=? AND g.user_id!=? AND
       (SELECT COUNT(*) FROM amebo_reports r WHERE r.gist_id=g.id) < 3`,
    day, uid
  )).n;
  const streak = await one("SELECT streak,best,last_day FROM amebo_streaks WHERE user_id=?", uid);
  return {
    day,
    resetsAt: ameboResetAt(),
    total,
    mine: mine ? await ameboView(mine, uid) : null,
    mineAll: await Promise.all(mineRows.map(g => ameboView(g, uid))),
    canPost: posted < AMEBO_MAX,
    postsLeft: Math.max(0, AMEBO_MAX - posted),
    max: AMEBO_MAX,
    streak: streak && (streak.last_day === day || streak.last_day === lagosDay(1)) ? streak.streak : 0,
    best: streak?.best || 0
  };
};

async function route(m, p, url, b, send, ip, req) {
  if (p === "/health" || p === "/api/health") {
    return send(200, { ok: true });
  }

  if (p === "/api/username" && m === "GET") {
    const u = String(url.searchParams.get("u") || "").toLowerCase();
    return send(200, {
      available: UN.test(u) && !await one("SELECT 1 x FROM users WHERE LOWER(username)=LOWER(?)", u)
    });
  }

  if (p === "/api/signup" && m === "POST") {
    if (!limit(ip, "auth", 30)) {
      return send(429, { error: "Too many attempts. Try again in a minute." });
    }

    const username = String(b.username || "").trim().toLowerCase();
    const name = username;
    const email = String(b.email || "").trim().toLowerCase();
    const bio = String(b.bio || "").slice(0, 160);
    const pw = String(b.password || "");

    if (!UN.test(username)) return send(400, { error: "Username: 3-20 letters, numbers, _ or ." });
    if (!/^\S+@\S+\.\S+$/.test(email)) return send(400, { error: "Enter a valid email" });
    if (pw.length < 8) return send(400, { error: "Password must be at least 8 characters" });
    if (await one("SELECT 1 x FROM users WHERE email=?", email)) return send(409, { error: "That email already has an account" });
    if (await one("SELECT 1 x FROM users WHERE LOWER(username)=LOWER(?)", username)) return send(409, { error: "That username is already taken" });

    const photo = PHOTO.test(b.photo || "") && b.photo.length <= 150000 ? b.photo : "";

    let r;
    try {
      r = await run(
        "INSERT INTO users(email,username,name,age,gender,bio,avatar,photo,pw,created) VALUES(?,?,?,0,'',?,?,?,?,?) RETURNING id",
        email, username, name, bio, JSON.stringify(cleanAv(b.avatar)), photo, hash(pw), Date.now()
      );
    } catch {
      return send(409, { error: "That username or email is already taken" });
    }

    const nu = await one("SELECT * FROM users WHERE id=?", r.rows[0].id);
    return send(201, { token: sign(nu.id, nu.tv), user: full(nu) });
  }

  if (p === "/api/login" && m === "POST") {
    if (!limit(ip, "auth", 30)) {
      return send(429, { error: "Too many attempts. Try again in a minute." });
    }

    const idf = String(b.identifier || b.email || "").trim().toLowerCase();
    const nu = await one("SELECT * FROM users WHERE email=? OR LOWER(username)=LOWER(?)", idf, idf);

    // Demo residents are never allowed to log in as real account holders.
    if (!nu || (!DEMO_MODE && nu.bot) || !check(String(b.password || ""), nu.pw)) {
      return send(401, { error: "Incorrect email/username or password" });
    }

    return send(200, { token: sign(nu.id, nu.tv), user: full(nu) });
  }

  if (p === "/api/forgot" && m === "POST") {
    if (!limit(ip, "fg", 8)) {
      return send(429, { error: "Too many attempts. Try again in a minute." });
    }

    const id = String(b.identifier || "").trim().toLowerCase();
    const x = id && await one("SELECT * FROM users WHERE bot=0 AND (email=? OR LOWER(username)=LOWER(?))", id, id);
    const out = {
      ok: true,
      message: "If that account exists, a 6-digit code was sent to its email. It works for 15 minutes."
    };

    if (!x) return send(200, out);

    const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");

    await run("INSERT INTO resets(user_id,code,exp,tries) VALUES(?,?,?,0) ON CONFLICT (user_id) DO UPDATE SET code=EXCLUDED.code,exp=EXCLUDED.exp,tries=0",
      x.id, mac("rs" + x.id + ":" + code), Date.now() + 15 * 6e4);

    sendMail(
      x.email,
      "Your Love in Lagos reset code",
      `Your code is ${code}. It works for 15 minutes. If you did not ask for it, ignore this email.`
    ).then(sent => {
      // The reset code is returned only in demo mode when no email service is configured.
      // It is never written to server logs or exposed in production.
      send(200, !sent && DEMO_MODE ? { ...out, devCode: code } : out);
    }).catch(() => send(500, { error: "Server error" }));

    return;
  }

  if (p === "/api/reset" && m === "POST") {
    if (!limit(ip, "rs", 10)) {
      return send(429, { error: "Too many attempts. Try again in a minute." });
    }

    const id = String(b.identifier || "").trim().toLowerCase();
    const x = id && await one("SELECT * FROM users WHERE bot=0 AND (email=? OR LOWER(username)=LOWER(?))", id, id);
    const rr = x && await one("SELECT * FROM resets WHERE user_id=?", x.id);
    const pw = String(b.password || "");

    if (pw.length < 8) return send(400, { error: "Password must be at least 8 characters" });

    const bad = { error: "That code is wrong or expired. Ask for a new one." };
    if (!rr || rr.exp < Date.now() || rr.tries >= 5) return send(400, bad);

    const want = Buffer.from(rr.code);
    const got = Buffer.from(mac("rs" + x.id + ":" + String(b.code || "").trim()));

    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
      await run("UPDATE resets SET tries=tries+1 WHERE user_id=?", x.id);
      return send(400, bad);
    }

    await run("UPDATE users SET pw=?,tv=tv+1 WHERE id=?", hash(pw), x.id);
    await run("DELETE FROM resets WHERE user_id=?", x.id);

    const nu = await one("SELECT * FROM users WHERE id=?", x.id);
    return send(200, { ok: true, token: sign(nu.id, nu.tv), user: full(nu) });
  }

  // Everything below needs a logged-in user.
  const tk = verify((req.headers.authorization || "").replace("Bearer ", ""));
  const uid = tk && tk.uid;
  const u = uid && await one("SELECT * FROM users WHERE id=?", uid);

  if (!u || (!DEMO_MODE && u.bot) || (tk.tv || 0) !== u.tv) {
    return send(401, { error: "Please log in" });
  }


  if (p.startsWith("/api/amebo")) await ameboPrune();

  // Amebo of the Day — shared gists stored in SQLite and reset by Lagos calendar day.
  if (p === "/api/amebo" && m === "GET") {
    return send(200, await ameboState(uid));
  }

  if (p === "/api/amebo/next" && m === "GET") {
    const seen = new Set(String(url.searchParams.get("seen") || "")
      .split(",").filter(Boolean).slice(0, 200));
    const readIds = new Set((await all(
      "SELECT gist_id FROM amebo_reads WHERE user_id=? AND day=?",
      uid, lagosDay()
    )).map(x => x.gist_id));
    const pool = (await ameboLiveGists(uid)).filter(g =>
      g.user_id !== uid && !seen.has(g.id) && !readIds.has(g.id)
    );
    const chosen = pool.length ? pool[crypto.randomInt(pool.length)] : null;
    if (chosen) {
      await run(
        "INSERT INTO amebo_reads(user_id,day,gist_id,created) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
        uid, lagosDay(), chosen.id, Date.now()
      );
      await ameboBump(uid);
    }
    return send(200, {
      gist: chosen ? await ameboView(chosen, uid) : null,
      left: Math.max(0, pool.length - (chosen ? 1 : 0))
    });
  }

  if (p === "/api/amebo/read" && m === "GET") {
    const rows = await all(
      `SELECT g.* FROM amebo_reads rd
       JOIN amebo_gists g ON g.id=rd.gist_id
       WHERE rd.user_id=? AND rd.day=? AND g.day=?
         AND (SELECT COUNT(*) FROM amebo_reports r WHERE r.gist_id=g.id) < 3
         AND EXISTS(SELECT 1 FROM amebo_reactions rx
                    WHERE rx.gist_id=g.id AND rx.user_id=?)
       ORDER BY rd.created DESC`,
      uid, lagosDay(), lagosDay(), uid
    );
    return send(200, await Promise.all(rows.map(g => ameboView(g, uid))));
  }

  if (p === "/api/amebo" && m === "POST") {
    if (!limit(ip, "amebo-post", 5)) return send(429, { error: "Slow down and try again shortly." });
    const text = String(b.text || "").trim();
    const category = String(b.cat || "");
    const day = lagosDay();
    if (text.length < 10) return send(400, { error: "Say a little more (at least 10 characters)." });
    if (text.length > 500) return send(400, { error: "Your gist must be 500 characters or fewer." });
    if (!AMEBO_CATEGORIES.has(category)) return send(400, { error: "Pick a category." });
    if (await ameboPosted(uid, day) >= AMEBO_MAX) {
      return send(409, { error: "You've dropped your " + AMEBO_MAX + " gists for today. Come back tomorrow!" });
    }
    const id = crypto.randomBytes(9).toString("base64url");
    const created = Date.now();
    let full = false;
    await tx(async () => {
      // The advisory lock makes two simultaneous posts from one person wait for each other, so the limit can't be beaten.
      await one("SELECT pg_advisory_xact_lock(?)", uid);
      if (await ameboPosted(uid, day) >= AMEBO_MAX) { full = true; return; }
      await run(
        "INSERT INTO amebo_gists(id,day,user_id,category,body,anonymous,created) VALUES(?,?,?,?,?,?,?)",
        id, day, uid, category, text, b.anon !== false ? 1 : 0, created
      );
      await run(
        "INSERT INTO amebo_posted(user_id,day,gist_id) VALUES(?,?,?)",
        uid, day, id
      );
    });
    if (full) return send(409, { error: "You've dropped your " + AMEBO_MAX + " gists for today. Come back tomorrow!" });
    await ameboBump(uid);
    return send(201, await ameboView(await one("SELECT * FROM amebo_gists WHERE id=?", id), uid));
  }

  let am = p.match(/^\/api\/amebo\/([A-Za-z0-9_-]+)(?:\/(react|report))?$/);
  if (am) {
    const gist = await one(
      `SELECT g.* FROM amebo_gists g
       WHERE g.id=? AND g.day=?
         AND (SELECT COUNT(*) FROM amebo_reports r WHERE r.gist_id=g.id) < 3`,
      am[1], lagosDay()
    );
    if (!gist) return send(404, { error: "That gist has already gone." });

    if (!am[2] && m === "DELETE") {
      if (gist.user_id !== uid) return send(403, { error: "You can only delete your own gist." });
      await run("DELETE FROM amebo_gists WHERE id=?", gist.id);
      await run("DELETE FROM amebo_reactions WHERE gist_id=?", gist.id);
      await run("DELETE FROM amebo_reports WHERE gist_id=?", gist.id);
      await run("DELETE FROM amebo_reads WHERE gist_id=?", gist.id);
      // Keep amebo_posted: deleting a post does not give the slot back (3 posts a day, deleted or not).
      return send(200, { ok: true });
    }

    if (am[2] === "react" && m === "POST") {
      if (gist.user_id === uid) return send(400, { error: "You can't react to your own gist." });
      if (!AMEBO_REACTIONS.has(b.emoji)) return send(400, { error: "Pick a valid reaction." });
      const old = await one(
        "SELECT emoji FROM amebo_reactions WHERE gist_id=? AND user_id=?",
        gist.id, uid
      );
      if (old?.emoji === b.emoji) {
        await run("DELETE FROM amebo_reactions WHERE gist_id=? AND user_id=?", gist.id, uid);
      } else {
        await run(
          `INSERT INTO amebo_reactions(gist_id,user_id,emoji,created) VALUES(?,?,?,?)
           ON CONFLICT(gist_id,user_id) DO UPDATE SET emoji=excluded.emoji,created=excluded.created`,
          gist.id, uid, b.emoji, Date.now()
        );
      }
      const v = await ameboView(gist, uid);
      return send(200, { reactions: v.reactions, my: v.my });
    }

    if (am[2] === "report" && m === "POST") {
      if (gist.user_id === uid) return send(400, { error: "You can't report your own gist." });
      if (!limit(ip, "amebo-report", 20)) return send(429, { error: "Slow down and try again shortly." });
      await run(
        "INSERT INTO amebo_reports(gist_id,user_id,created) VALUES(?,?,?) ON CONFLICT DO NOTHING",
        gist.id, uid, Date.now()
      );
      const reports = (await one("SELECT COUNT(*) n FROM amebo_reports WHERE gist_id=?", gist.id)).n;
      return send(200, { ok: true, hidden: reports >= 3 });
    }
  }

  // Stack Game rewards: up to 30 XP per run and 60 XP per Lagos day.
  if (p === "/api/play" && m === "POST") {
    if (!limit(ip, "stack-game", 120)) return send(429, { error: "Too many game attempts. Take a short break." });
    const score = Number.isFinite(Number(b.score)) ? Math.max(0, Math.floor(Number(b.score))) : 0;
    if (score <= 0) return send(200, { xp: 0, message: "No XP earned this run." });
    const earned = await award(uid, Math.min(score, 30), "stack-game", 60);
    return send(200, {
      xp: earned,
      score: Math.min(score, 30),
      message: earned ? "XP added to your account." : "Daily game XP limit reached."
    });
  }

  if (p === "/api/me" && m === "GET") return send(200, full(u));

  if (p === "/api/me" && m === "PUT") {
    let un = u.username;

    if (b.username !== undefined) {
      un = String(b.username).trim().toLowerCase();
      if (!UN.test(un)) return send(400, { error: "Username: 3-20 letters, numbers, _ or ." });
      if (await one("SELECT 1 x FROM users WHERE LOWER(username)=LOWER(?) AND id!=?", un, uid)) {
        return send(409, { error: "That username is already taken" });
      }
    }

    if (b.photo && !(PHOTO.test(b.photo) && b.photo.length <= 150000)) {
      return send(400, { error: "Photo must be a small JPEG, PNG or WebP" });
    }

    const game = JSON.stringify(b.game ?? J(u.game, {}));
    if (game.length > 20000) return send(413, { error: "Game data too large" });

    const list = (v, old, n) =>
      (Array.isArray(v) ? v : J(old, []))
        .map(x => String(x).slice(0, 20))
        .slice(0, n);

    await run(
      "UPDATE users SET username=?,bio=?,area=?,fav=?,look=?,interests=?,avatar=?,game=? WHERE id=?",
      un,
      String(b.bio ?? u.bio).slice(0, 160),
      String(b.area ?? u.area).slice(0, 30),
      String(b.fav ?? u.fav).slice(0, 30),
      JSON.stringify(list(b.look, u.look, 4)),
      JSON.stringify(list(b.interests, u.interests, 5)),
      JSON.stringify(b.avatar ? cleanAv(b.avatar, J(u.outfits, [])) : J(u.avatar, {})),
      game,
      uid
    );

    await run("UPDATE users SET name=? WHERE id=?", un, uid);
    if (b.photo !== undefined) await run("UPDATE users SET photo=? WHERE id=?", b.photo || "", uid);

    return send(200, full(await one("SELECT * FROM users WHERE id=?", uid)));
  }

  if (p === "/api/me" && m === "DELETE") {
    // Remove the account and every record connected to it as one transaction.
    await tx(async () => {
      await run("DELETE FROM requests WHERE from_id=? OR to_id=?", uid, uid);
      await run("DELETE FROM messages WHERE from_id=? OR to_id=?", uid, uid);
      await run("DELETE FROM blocks WHERE by_id=? OR user_id=?", uid, uid);
      await run("DELETE FROM reports WHERE by_id=? OR user_id=?", uid, uid);

      await run("DELETE FROM game_answers WHERE game_id IN (SELECT id FROM games WHERE a_id=? OR b_id=?)", uid, uid);
      await run("DELETE FROM games WHERE a_id=? OR b_id=?", uid, uid);
      await run("DELETE FROM game_used WHERE user_id=?", uid);

      await run("DELETE FROM profile_views WHERE viewer_id=? OR viewed_id=?", uid, uid);
      await run("DELETE FROM activity WHERE user_id=?", uid);
      await run("DELETE FROM daily_answers WHERE user_id=?", uid);
      await run("DELETE FROM resets WHERE user_id=?", uid);
      await run("DELETE FROM xp_events WHERE user_id=?", uid);
      await run("DELETE FROM notifs WHERE user_id=? OR from_id=?", uid, uid);
      await run("DELETE FROM cupid WHERE from_id=? OR a=? OR b=?", uid, uid, uid);
      await run("DELETE FROM amebo_reactions WHERE user_id=? OR gist_id IN (SELECT id FROM amebo_gists WHERE user_id=?)", uid, uid);
      await run("DELETE FROM amebo_reports WHERE user_id=? OR gist_id IN (SELECT id FROM amebo_gists WHERE user_id=?)", uid, uid);
      await run("DELETE FROM amebo_reads WHERE user_id=? OR gist_id IN (SELECT id FROM amebo_gists WHERE user_id=?)", uid, uid);
      await run("DELETE FROM amebo_gists WHERE user_id=?", uid);
      await run("DELETE FROM amebo_posted WHERE user_id=?", uid);
      await run("DELETE FROM amebo_streaks WHERE user_id=?", uid);


      await run("DELETE FROM users WHERE id=?", uid);
    });

    return send(200, { ok: true });
  }

  const xpInfo = async () => ({
    total: (await one("SELECT xp FROM users WHERE id=?", uid)).xp,
    today: (await one(
      "SELECT COALESCE(SUM(amount),0) s FROM xp_events WHERE user_id=? AND day=? AND reason NOT IN ('boost','giftsent')",
      uid, lagosDay()
    )).s,
    goal: 1000,
    boostUntil: (await one("SELECT boost_until b FROM users WHERE id=?", uid)).b,
    claimed: !!await one("SELECT 1 x FROM xp_events WHERE user_id=? AND day=? AND reason='boost'", uid, lagosDay()),
    ...extraInfo()
  });

  const extraInfo = async () => {
    const r = await one("SELECT xp,gin,spent,streak,best FROM users WHERE id=?", uid);
    return {
      bal: r.xp + r.gin - r.spent,
      streak: r.streak,
      best: r.best,
      badges: await badgesOf(uid, r.best)
    };
  };

  if (p === "/api/xp" && m === "GET") {
    await bumpStreak(uid);
    await cupidSettle(uid);
    return send(200, await xpInfo());
  }

  if (p === "/api/xp/boost" && m === "POST") {
    const i = await xpInfo();
    if (i.today < 1000) return send(400, { error: "Earn 1000 XP today first" });
    if (i.claimed) return send(409, { error: "You already used today’s Lagos Charm" });

    await run("INSERT INTO xp_events(user_id,day,amount,reason,created) VALUES(?,?,0,'boost',?)",
      uid, lagosDay(), Date.now());
    await run("UPDATE users SET boost_until=? WHERE id=?", Date.now() + 36e5, uid);
    await logA(uid, "daily", "⚡ Lagos Charm on for 1 hour");

    return send(200, await xpInfo());
  }

  if (p === "/api/notifs" && m === "GET") {
    const botFilter = DEMO_MODE ? "" : " AND (from_id=0 OR from_id IN (SELECT id FROM users WHERE bot=0))";

    return send(200, {
      items: await all(
        `SELECT id,kind,text,from_id,created at,isread FROM notifs WHERE user_id=?${botFilter} ORDER BY id DESC LIMIT 30`,
        uid
      ),
      unread: (await one(
        `SELECT COUNT(*) c FROM notifs WHERE user_id=? AND isread=0${botFilter}`,
        uid
      )).c
    });
  }

  if (p === "/api/notifs/read" && m === "POST") {
    await run("UPDATE notifs SET isread=1 WHERE user_id=?", uid);
    return send(200, { ok: true });
  }

  if (p === "/api/shop" && m === "GET") {
    return send(200, {
      items: OUTFITS.map(([id, name, price, slot, val]) => ({ id, name, price, slot, val })),
      owned: J(u.outfits, []),
      bal: u.xp + u.gin - u.spent
    });
  }

  if (p === "/api/shop/buy" && m === "POST") {
    const it = OUTFITS.find(x => x[0] === b.id);
    const own = J(u.outfits, []);

    if (!it) return send(400, { error: "No such item" });
    if (own.includes(it[0])) return send(409, { error: "You already own this" });
    if (u.xp + u.gin - u.spent < it[2]) return send(400, { error: "Not enough XP" });

    own.push(it[0]);

    await run("UPDATE users SET spent=spent+?,outfits=?,avatar=? WHERE id=?",
      it[2], JSON.stringify(own),
      JSON.stringify({ ...J(u.avatar, {}), [it[3]]: it[4] }),
      uid);

    const nu = await one("SELECT * FROM users WHERE id=?", uid);
    return send(200, { user: full(nu), owned: own, bal: nu.xp + nu.gin - nu.spent });
  }

  if (p === "/api/shop/wear" && m === "POST") {
    const own = J(u.outfits, []);
    const av = J(u.avatar, {});

    if (b.slot === "ot" || b.slot === "hat") {
      delete av[b.slot];
    } else {
      const it = OUTFITS.find(x => x[0] === b.id);
      if (!it || !own.includes(it[0])) return send(400, { error: "You don't own this" });
      av[it[3]] = it[4];
    }

    await run("UPDATE users SET avatar=? WHERE id=?", JSON.stringify(av), uid);
    return send(200, { user: full(await one("SELECT * FROM users WHERE id=?", uid)) });
  }

  if (p === "/api/gift" && m === "POST") {
    const to = +b.to;
    const n = +b.amount;
    const o = await one("SELECT * FROM users WHERE id=?", to);

    if (!o || to === uid || (!DEMO_MODE && o.bot) || ![10, 25, 50, 100, 500, 1000].includes(n)) {
      return send(400, { error: "Cannot gift" });
    }

    if (await blocked(uid, to)) return send(400, { error: "Cannot gift this user" });
    if (u.xp + u.gin - u.spent < n) return send(400, { error: "Not enough XP" });

    if ((await one(
      "SELECT COALESCE(SUM(amount),0) s FROM xp_events WHERE user_id=? AND day=? AND reason='giftsent'",
      uid, lagosDay()
    )).s + n > 10000) {
      return send(400, { error: "You can gift up to 10,000 XP a day" });
    }

    await run("INSERT INTO xp_events(user_id,day,amount,reason,created) VALUES(?,?,?,'giftsent',?)",
      uid, lagosDay(), n, Date.now());
    await run("UPDATE users SET spent=spent+? WHERE id=?", n, uid);
    await run("UPDATE users SET gin=gin+? WHERE id=?", n, to);

    await notify(to, "gift", u.name + " gifted you " + n + " XP 🎁", uid);
    return send(200, { ok: true });
  }

  if (p === "/api/leaderboard" && m === "GET") {
    const wk = lagosDay((new Date(lagosDay() + "T00:00:00Z").getUTCDay() + 6) % 7);
    const sc = new Map();

    const scores = DEMO_MODE
      ? await all("SELECT e.user_id, SUM(e.amount) s FROM xp_events e JOIN users u ON u.id=e.user_id WHERE e.day>=? AND e.reason NOT IN ('boost','giftsent') GROUP BY e.user_id", wk)
      : await all("SELECT e.user_id, SUM(e.amount) s FROM xp_events e JOIN users u ON u.id=e.user_id WHERE e.day>=? AND e.reason NOT IN ('boost','giftsent') AND u.bot=0 GROUP BY e.user_id", wk);

    for (const r of scores) sc.set(r.user_id, r.s);

    if (DEMO_MODE) {
      for (const r of await all("SELECT id FROM users WHERE bot=1")) {
        sc.set(r.id, (sc.get(r.id) || 0) + 40 + hnum(r.id + "w" + wk) % 220);
      }
    }

    const rk = [...sc].sort((x, y) => y[1] - x[1]);
    const i = rk.findIndex(x => x[0] === uid);

    return send(200, {
      top: await Promise.all(rk.slice(0, 10).map(async ([id, xp]) => ({
        user: pub(await one("SELECT * FROM users WHERE id=?", id)),
        xp
      }))),
      me: i >= 0 ? { rank: i + 1, xp: rk[i][1] } : null
    });
  }

  if (p === "/api/cupid" && m === "GET") {
    await cupidSettle(uid);

    const day = Date.now() - 864e5;
    const usr = async id => {
      const person = await one("SELECT * FROM users WHERE id=?", id);
      return person && (DEMO_MODE || !person.bot) ? pub(person) : null;
    };

    const mine = (await Promise.all((await all(
      "SELECT * FROM cupid WHERE from_id=? ORDER BY id DESC LIMIT 8",
      uid
    )).map(async c => ({
      id: c.id,
      status: c.status,
      a: await usr(c.a),
      b: await usr(c.b)
    })))).filter(c => c.a && c.b);

    const topSql = DEMO_MODE
      ? "SELECT from_id, COUNT(*) c FROM cupid WHERE status='matched' GROUP BY from_id ORDER BY c DESC LIMIT 5"
      : "SELECT c.from_id, COUNT(*) c FROM cupid c JOIN users u ON u.id=c.from_id AND u.bot=0 JOIN users a ON a.id=c.a AND a.bot=0 JOIN users b ON b.id=c.b AND b.bot=0 WHERE c.status='matched' GROUP BY c.from_id ORDER BY COUNT(*) DESC LIMIT 5";

    const top = (await Promise.all((await all(topSql)).map(async r => ({ user: await usr(r.from_id), count: r.c })))).filter(r => r.user);

    return send(200, {
      mine,
      top,
      matched: (await one("SELECT COUNT(*) c FROM cupid WHERE from_id=? AND status='matched'", uid)).c,
      left: Math.max(0, 3 - (await one("SELECT COUNT(*) c FROM cupid WHERE from_id=? AND created>?", uid, day)).c)
    });
  }

  if (p === "/api/cupid" && m === "POST") {
    const A = +b.a;
    const B = +b.b;
    const ua = await one("SELECT * FROM users WHERE id=?", A);
    const ub = await one("SELECT * FROM users WHERE id=?", B);

    if (!ua || !ub || A === B || A === uid || B === uid || (!DEMO_MODE && (ua.bot || ub.bot))) {
      return send(400, { error: "Pick two other people" });
    }

    if (await blocked(A, B) || await blocked(uid, A) || await blocked(uid, B)) {
      return send(400, { error: "You can’t introduce these two" });
    }

    if (await one("SELECT 1 x FROM requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)", A, B, B, A)) {
      return send(409, { error: "These two already know each other" });
    }

    if (await one("SELECT 1 x FROM cupid WHERE status='open' AND ((a=? AND b=?) OR (a=? AND b=?))", A, B, B, A)) {
      return send(409, { error: "Someone already introduced them" });
    }

    if ((await one("SELECT COUNT(*) c FROM cupid WHERE from_id=? AND created>?", uid, Date.now() - 864e5)).c >= 3) {
      return send(429, { error: "You can introduce 3 couples a day" });
    }

    await run("INSERT INTO cupid(from_id,a,b,created) VALUES(?,?,?,?)", uid, A, B, Date.now());
    await award(uid, 5, "cupid-intro", 15);

    await notify(A, "cupid", "💘 " + u.name + " thinks you and " + ub.name + " would click!", B);
    await notify(B, "cupid", "💘 " + u.name + " thinks you and " + ua.name + " would click!", A);

    return send(200, { ok: true });
  }

  if (p === "/api/activity" && m === "POST") {
    if (!["act", "rest"].includes(b.kind)) return send(400, { error: "Bad kind" });
    if (!limit(ip, "act", 120)) return send(429, { error: "Slow down" });

    await logA(uid, b.kind, b.text || "");
    if (b.kind === "act") await award(uid, 10, "act", 100);

    return send(200, { ok: true });
  }

  if (p === "/api/activity" && m === "GET") {
    const dq = url.searchParams.get("day") || "";
    const day = /^\d{4}-\d{2}-\d{2}$/.test(dq) ? dq : lagosDay();
    const start = Date.parse(day + "T00:00:00Z") - 3600000;

    return send(200, await all(
      "SELECT kind,text,created FROM activity WHERE user_id=? AND created>=? AND created<? ORDER BY created",
      uid, start, start + 864e5
    ));
  }

  if (p === "/api/daily" && m === "GET") {
    const d = DAILY[new Date(Date.now() + 3600000).getUTCDay()];
    const a = await one("SELECT * FROM daily_answers WHERE user_id=? AND day=?", uid, lagosDay());
    const days = new Set((await all("SELECT day FROM daily_answers WHERE user_id=?", uid)).map(x => x.day));

    let streak = 0;
    for (let o = a ? 0 : 1; days.has(lagosDay(o)); o++) streak++;

    return send(200, {
      title: d[0],
      question: d[1],
      options: d[2],
      streak,
      answered: a ? { answer: a.answer, correct: a.correct, ok: !!a.ok } : null,
      history: (await all(
        "SELECT day,q,answer,correct,ok FROM daily_answers WHERE user_id=? ORDER BY day DESC LIMIT 7",
        uid
      )).map(x => ({ ...x, ok: !!x.ok }))
    });
  }

  if (p === "/api/daily/answer" && m === "POST") {
    const d = DAILY[new Date(Date.now() + 3600000).getUTCDay()];
    const opt = Math.trunc(+b.option);

    if (!(opt >= 0 && opt < d[2].length)) return send(400, { error: "Pick one of the options" });
    if (await one("SELECT 1 x FROM daily_answers WHERE user_id=? AND day=?", uid, lagosDay())) {
      return send(409, { error: "Already answered today" });
    }

    const ok = opt === d[3];
    await award(uid, ok ? 30 : 10, "daily");

    await run(
      "INSERT INTO daily_answers(user_id,day,q,answer,correct,ok,created) VALUES(?,?,?,?,?,?,?)",
      uid, lagosDay(), d[1], d[2][opt], d[2][d[3]], ok ? 1 : 0, Date.now()
    );

    await logA(uid, "daily", "🗓️ Answered the daily question: " + d[2][opt] + (ok ? " ✅" : " ❌"));
    return send(200, { ok, correct: d[2][d[3]] });
  }

  if (p === "/api/qa" && m === "GET") {
    const rows = DEMO_MODE
      ? await all(
          "SELECT ga.qi,ga.text,ga.user_id,ga.created,g.qs,g.a_id,g.b_id FROM game_answers ga JOIN games g ON g.id=ga.game_id WHERE g.a_id=? OR g.b_id=? ORDER BY ga.created DESC LIMIT 30",
          uid, uid
        )
      : await all(
          "SELECT ga.qi,ga.text,ga.user_id,ga.created,g.qs,g.a_id,g.b_id FROM game_answers ga JOIN games g ON g.id=ga.game_id JOIN users other ON other.id=CASE WHEN g.a_id=? THEN g.b_id ELSE g.a_id END WHERE (g.a_id=? OR g.b_id=?) AND other.bot=0 ORDER BY ga.created DESC LIMIT 30",
          uid, uid, uid
        );

    return send(200, await Promise.all(rows.map(async x => ({
      questionId: J(x.qs, [])[x.qi],
      answer: x.text,
      answeredBy: x.user_id === uid ? "you" : "them",
      with: (await one("SELECT username FROM users WHERE id=?", x.a_id === uid ? x.b_id : x.a_id))?.username,
      at: x.created
    }))));
  }

  if (p === "/api/presence" && m === "POST") {
    const l = Math.trunc(+b.loc);
    if (!(l >= -1 && l <= 8)) return send(400, { error: "Bad location" });

    await run("UPDATE users SET loc=?,seen=? WHERE id=?", l, Date.now(), uid);
    return send(200, { ok: true });
  }

  if (p === "/api/people" && m === "GET") {
    const loc = url.searchParams.get("loc");
    const botFilter = DEMO_MODE ? "" : " AND bot=0";

    if (loc !== null) {
      return send(200, (await all(
        `SELECT * FROM users WHERE id!=? AND loc=? AND seen>?${botFilter}
         AND id NOT IN (SELECT user_id FROM blocks WHERE by_id=?)
         AND id NOT IN (SELECT by_id FROM blocks WHERE user_id=?)
         ORDER BY seen DESC LIMIT 50`,
        uid, +loc, Date.now() - 90000, uid, uid
      )).map(pub));
    }

    const q = "%" + String(url.searchParams.get("q") || "").trim().toLowerCase().replace(/%/g, "") + "%";

    return send(200, (await all(
      `SELECT * FROM users WHERE id!=? AND username ILIKE ?${botFilter}
       AND id NOT IN (SELECT user_id FROM blocks WHERE by_id=?)
       AND id NOT IN (SELECT by_id FROM blocks WHERE user_id=?)
       ORDER BY id DESC LIMIT 50`,
      uid, q, uid, uid
    )).map(pub));
  }

  if (p === "/api/matches" && m === "POST") {
    const to = +b.to;
    const o = await one("SELECT * FROM users WHERE id=?", to);
    const boost0 = u.boost_until > Date.now();

    if (!o || to === uid || (!DEMO_MODE && o.bot) || await blocked(uid, to)) {
      return send(400, { error: "Cannot match" });
    }

    if (!limit(ip, "req", 30)) return send(429, { error: "Slow down" });

    const ex = await one(
      "SELECT * FROM requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)",
      uid, to, to, uid
    );

    if (ex && ex.status === "pending" && ex.to_id === uid) {
      await run("UPDATE requests SET status='accepted' WHERE id=?", ex.id);
      await award(uid, 25, "match");
      await award(to, 25, "match");
      await notify(to, "match", "🎉 " + u.name + " matched with you!", uid);
      return send(200, { pct: ex.pct, status: "matched" });
    }

    if (ex && ex.status !== "accepted" && boost0) {
      await run("UPDATE requests SET status='accepted',auto=1 WHERE id=?", ex.id);
      await award(uid, 25, "match");
      await award(to, 25, "match");
      await notify(to, "match", "🎉 " + u.name + " matched with you!", uid);
      return send(200, { pct: ex.pct, status: "matched", boost: true });
    }

    if (ex) {
      return send(200, {
        pct: ex.pct,
        status: ex.status === "accepted" ? "matched" :
          ex.status === "declined" ? "declined" : "sent"
      });
    }

    const { pct, why } = compat(u, o);
    const boost = u.boost_until > Date.now();

    if (pct < 15 && !boost) {
      await logA(uid, "match", "💔 Match with @" + o.username + " didn't work out (" + pct + "%)");
      return send(200, { pct, why, status: "low" });
    }

    const auto = pct >= 95 || boost;

    if (auto) {
      await award(uid, 25, "match");
      await award(to, 25, "match");
    } else {
      await award(uid, 5, "sent", 25);
    }

    await run(
      "INSERT INTO requests(from_id,to_id,status,pct,created,auto) VALUES(?,?,?,?,?,?)",
      uid, to, auto ? "accepted" : "pending", pct, Date.now(), auto ? 1 : 0
    );

    await logA(uid, "match",
      (auto ? "💘 Instantly matched with @" : "💘 Sent a match to @") + o.username + " (" + pct + "%)");

    await notify(
      to,
      "match",
      auto
        ? "🎉 " + u.name + " matched with you! You both got the " + lvl(pct) + " and 💬 Talking stage tags."
        : "💘 " + u.name + " sent you a match request",
      uid
    );

    return send(200, {
      pct,
      why,
      boost: boost && pct < 95,
      status: auto ? "matched" : "sent"
    });
  }

  if (p === "/api/matches" && m === "GET") {
    const botFilter = DEMO_MODE ? "" : " AND u.bot=0";

    return send(200, {
      incoming: (await all(
        `SELECT u.*,r.id rid,r.pct FROM requests r
         JOIN users u ON u.id=r.from_id
         WHERE r.to_id=? AND r.status='pending'${botFilter}
         ORDER BY r.created DESC`,
        uid
      )).map(x => ({ requestId: x.rid, pct: x.pct, user: pub(x) })),

      matches: await (async () => {
        const rows = await all(
          `SELECT u.*,r.pct,r.auto FROM requests r
         JOIN users u ON u.id=(CASE WHEN r.from_id=? THEN r.to_id ELSE r.from_id END)
         WHERE r.status='accepted' AND (r.from_id=? OR r.to_id=?)${botFilter}
         ORDER BY r.id`,
          uid, uid, uid
        );
        // One query for all message counts and one for all last messages, instead of several queries per match.
        const cnt = new Map((await all(
          "SELECT CASE WHEN from_id=? THEN to_id ELSE from_id END AS other, COUNT(*) AS n FROM messages WHERE from_id=? OR to_id=? GROUP BY 1",
          uid, uid, uid
        )).map(r => [r.other, r.n]));
        const lastM = new Map((await all(
          "SELECT from_id,to_id,text,created FROM messages WHERE id IN (SELECT MAX(id) FROM messages WHERE from_id=? OR to_id=? GROUP BY CASE WHEN from_id=? THEN to_id ELSE from_id END)",
          uid, uid, uid
        )).map(r => [r.from_id === uid ? r.to_id : r.from_id, { from_id: r.from_id, text: r.text, created: r.created }]));
        return Promise.all(rows.map(async x => {
          const n = cnt.get(x.id) || 0;
          return {
            pct: x.pct,
            user: pub(x),
            talking: x.pct >= 90 || x.auto === 1 || n >= 100 || await streak3(uid, x.id),
            photoUnlocked: n >= 100,
            count: n,
            last: lastM.get(x.id) || null
          };
        }));
      })(),

      sent: (await all(
        `SELECT u.*,r.pct FROM requests r
         JOIN users u ON u.id=r.to_id
         WHERE r.from_id=? AND r.status='pending'${botFilter}
         ORDER BY r.id`,
        uid
      )).map(x => ({ pct: x.pct, user: pub(x) }))
    });
  }
    let mm = p.match(/^\/api\/matches\/(\d+)\/respond$/);

  if (mm && m === "POST") {
    const r = await one(
      "SELECT * FROM requests WHERE id=? AND to_id=? AND status='pending'",
      +mm[1], uid
    );

    if (!r || (!DEMO_MODE && await isBot(r.from_id))) {
      return send(404, { error: "Match request not found" });
    }

    await run("UPDATE requests SET status=? WHERE id=?", b.accept ? "accepted" : "declined", r.id);

    if (b.accept) {
      await award(uid, 25, "match");
      await award(r.from_id, 25, "match");
      await notify(r.from_id, "match", "🎉 " + u.name + " accepted your match!", uid);
      await logA(uid, "match", "🎉 You accepted a match");
      await logA(r.from_id, "match", "🎉 Someone accepted your match");
    }

    return send(200, { ok: true });
  }

  mm = p.match(/^\/api\/messages\/(\d+)$/);

  if (mm) {
    const other = +mm[1];
    const otherUser = await one("SELECT * FROM users WHERE id=?", other);

    if (
      !otherUser ||
      (!DEMO_MODE && otherUser.bot) ||
      !await friends(uid, other) ||
      await blocked(uid, other)
    ) {
      return send(403, { error: "You can only chat with friends" });
    }

    if (m === "GET") {
      const rows = await all(
        "SELECT m.id,m.from_id,m.text,m.created,m.reply_to,r.from_id AS r_from,r.text AS r_text FROM messages m LEFT JOIN messages r ON r.id=m.reply_to WHERE m.id>? AND ((m.from_id=? AND m.to_id=?) OR (m.from_id=? AND m.to_id=?)) ORDER BY m.id LIMIT 100",
        +url.searchParams.get("after") || 0,
        uid, other, other, uid
      );
      // A reply carries a short copy of the message it answers, so both people see which text it was for.
      return send(200, rows.map(x => {
        const o = { id: x.id, from_id: x.from_id, text: x.text, created: x.created };
        if (x.reply_to) o.reply = x.r_from ? { id: x.reply_to, from_id: x.r_from, text: String(x.r_text || "").slice(0, 140) } : { id: x.reply_to, from_id: null, text: null };
        return o;
      }));
    }

    if (m === "POST") {
      const text = String(b.text || "").trim().slice(0, 500);

      if (!text) return send(400, { error: "Empty message" });
      if (!limit(ip, "msg", 120)) return send(429, { error: "Slow down" });

      // Optional reply: only accepted when the quoted message is part of this conversation, otherwise it is ignored.
      let replyTo = null;
      const rq = Math.trunc(Number(b.replyTo));
      if (Number.isSafeInteger(rq) && rq > 0) {
        const orig = await one("SELECT id FROM messages WHERE id=? AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))", rq, uid, other, other, uid);
        if (orig) replyTo = orig.id;
      }

      const msgId = (await one("INSERT INTO messages(from_id,to_id,text,created,reply_to) VALUES(?,?,?,?,?) RETURNING id",
        uid, other, text, Date.now(), replyTo)).id;

      await award(uid, 2, "msg", 40);

      if (!await one(
        "SELECT 1 x FROM notifs WHERE user_id=? AND kind='msg' AND from_id=? AND isread=0",
        other, uid
      )) {
        await notify(other, "msg", u.name + ": " + text.slice(0, 60), uid);
      }

      return send(201, { ok: true, photosUnlocked: await checkPhotoUnlock(uid, other, msgId) });
    }
  }

  // 20 Questions: invite -> friend accepts or declines -> players take turns asking.
  if (p === "/api/games/invite" && m === "POST") {
    const o = +b.userId;
    const otherUser = await one("SELECT * FROM users WHERE id=?", o);

    if (
      !otherUser ||
      (!DEMO_MODE && otherUser.bot) ||
      !await friends(uid, o) ||
      await blocked(uid, o)
    ) {
      return send(403, { error: "You can only play with your matches" });
    }

    if (await one(
      "SELECT 1 x FROM games WHERE status IN ('invited','playing') AND ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?))",
      uid, o, o, uid
    )) {
      return send(409, { error: "A game is already open" });
    }

    const r = await run(
      "INSERT INTO games(a_id,b_id,status,created) VALUES(?,?,'invited',?) RETURNING id",
      uid, o, Date.now()
    );

    return send(201, { id: Number(r.rows[0].id) });
  }

  mm = p.match(/^\/api\/games\/(\d+)\/(respond|ask|answer|swap)$/);

  if (mm && m === "POST") {
    const g = await one(
      "SELECT * FROM games WHERE id=? AND (a_id=? OR b_id=?)",
      +mm[1], uid, uid
    );

    if (!g) return send(404, { error: "Game not found" });

    const opponentId = g.a_id === uid ? g.b_id : g.a_id;

    if (!DEMO_MODE && await isBot(opponentId)) {
      return send(404, { error: "Game not found" });
    }

    if (await blocked(uid, opponentId)) {
      return send(403, { error: "You cannot play with this user" });
    }

    if (mm[2] === "respond") {
      if (g.b_id !== uid || g.status !== "invited") {
        return send(403, { error: "Only the invited player can answer" });
      }

      if (!b.accept) {
        await run("UPDATE games SET status='declined' WHERE id=?", g.id);
        return send(200, { ok: true });
      }

      await startGame(g);
      return send(200, { ok: true });
    }

    if (g.status !== "playing") {
      return send(400, { error: "Game is not running" });
    }

    const asker = g.i % 2 === 0 ? g.a_id : g.b_id;

    if (mm[2] === "swap") {
      // Only the player whose turn it is to ask, and only before the question has been asked.
      if (uid !== asker || g.asked) {
        return send(403, { error: "You can only change a question before you ask it" });
      }
      if (!limit(ip, "game-swap", 60)) return send(429, { error: "Slow down" });

      const qs = J(g.qs, []);
      const seen = new Set(
        (await all("SELECT q FROM game_used WHERE user_id IN (?,?)", g.a_id, g.b_id)).map(x => x.q)
      );
      let pool = [...Array(QCOUNT).keys()].filter(i => !qs.includes(i));
      const fresh = pool.filter(i => !seen.has(i));
      if (fresh.length) pool = fresh;
      if (!pool.length) return send(409, { error: "No other questions left" });

      const pick = pool[crypto.randomInt(pool.length)];
      qs[g.i] = pick;
      await run("UPDATE games SET qs=? WHERE id=? AND i=? AND asked=0", JSON.stringify(qs), g.id, g.i);
      for (const x of [g.a_id, g.b_id]) await run("INSERT INTO game_used VALUES(?,?) ON CONFLICT DO NOTHING", x, pick);
      return send(200, { ok: true });
    }

    if (mm[2] === "ask") {
      if (uid !== asker || g.asked) {
        return send(403, { error: "Not your turn to ask" });
      }

      await run("UPDATE games SET asked=1 WHERE id=?", g.id);
      return send(200, { ok: true });
    }

    if (uid === asker || !g.asked) {
      return send(403, { error: "Not your turn to answer" });
    }

    const text = String(b.text || "").trim().slice(0, 300);

    if (!text) return send(400, { error: "Write an answer" });

    await run(
      "INSERT INTO game_answers(game_id,qi,user_id,text,created) VALUES(?,?,?,?,?)",
      g.id, g.i, uid, text, Date.now()
    );

    if (g.i + 1 >= 20) {
      await run("UPDATE games SET status='done',i=20,asked=0 WHERE id=?", g.id);
      await logA(g.a_id, "game", "🎲 Finished 20 Questions");
      await award(g.a_id, 40, "game");
      await award(g.b_id, 40, "game");
      await logA(g.b_id, "game", "🎲 Finished 20 Questions");
    } else {
      await run("UPDATE games SET i=i+1,asked=0 WHERE id=?", g.id);
    }

    return send(200, { ok: true });
  }

  mm = p.match(/^\/api\/games\/with\/(\d+)$/);

  if (mm && m === "GET") {
    const o = +mm[1];
    const otherUser = await one("SELECT * FROM users WHERE id=?", o);

    if (
      !otherUser ||
      (!DEMO_MODE && otherUser.bot) ||
      await blocked(uid, o)
    ) {
      return send(200, null);
    }

    const g = await one(
      "SELECT * FROM games WHERE (a_id=? AND b_id=?) OR (a_id=? AND b_id=?) ORDER BY id DESC LIMIT 1",
      uid, o, o, uid
    );

    if (!g) return send(200, null);

    const qs = J(g.qs, []);
    const ans = await all(
      "SELECT qi,user_id,text FROM game_answers WHERE game_id=? ORDER BY qi",
      g.id
    );
    const asker = g.i % 2 === 0 ? g.a_id : g.b_id;

    return send(200, {
      id: g.id,
      status: g.status,
      inviter: g.a_id,
      i: g.i,
      history: qs.slice(0, g.i).map((q, k) => ({
        q,
        asker: k % 2 === 0 ? g.a_id : g.b_id,
        answer: (ans.find(x => x.qi === k) || {}).text
      })),
      cur: g.status === "playing" ? {
        q: uid === asker || g.asked ? qs[g.i] : null,
        asker,
        yourTurnToAsk: uid === asker && !g.asked,
        yourTurnToAnswer: uid !== asker && !!g.asked
      } : null
    });
  }

  if (p === "/api/profile-views" && m === "POST") {
    const to = +b.userId;
    const target = validUserId(to) && await one("SELECT * FROM users WHERE id=?", to);

    if (
      !target ||
      to === uid ||
      (!DEMO_MODE && target.bot) ||
      await blocked(uid, to)
    ) {
      return send(200, { ok: true });
    }

    await run("INSERT INTO profile_views VALUES(?,?,?) ON CONFLICT (viewer_id,viewed_id) DO UPDATE SET created=EXCLUDED.created", uid, to, Date.now());
    return send(200, { ok: true });
  }

  if (p === "/api/visitors" && m === "GET") {
    const botFilter = DEMO_MODE ? "" : " AND u.bot=0";

    return send(200, (await all(
      `SELECT u.*,v.created seen
       FROM profile_views v
       JOIN users u ON u.id=v.viewer_id
       WHERE v.viewed_id=?${botFilter}
       AND u.id NOT IN (SELECT user_id FROM blocks WHERE by_id=?)
       AND u.id NOT IN (SELECT by_id FROM blocks WHERE user_id=?)
       ORDER BY v.created DESC LIMIT 50`,
      uid, uid, uid
    )).map(x => ({ user: pub(x), at: x.seen })));
  }

  mm = p.match(/^\/api\/photo\/(\d+)$/);

  if (mm && m === "GET") {
    const o = +mm[1];
    const otherUser = await one("SELECT * FROM users WHERE id=?", o);

    if (
      !otherUser ||
      (!DEMO_MODE && otherUser.bot) ||
      !await friends(uid, o) ||
      await blocked(uid, o) ||
      await texts(uid, o) < 100
    ) {
      return send(403, { error: "Photos unlock after 100 messages" });
    }

    return send(200, {
      photo: otherUser.photo || ""
    });
  }

  if (p === "/api/block" && m === "POST") {
    const targetId = +b.userId;
    const target = validUserId(targetId) && await one("SELECT * FROM users WHERE id=?", targetId);

    if (!target || targetId === uid || (!DEMO_MODE && target.bot)) {
      return send(400, { error: "Invalid user" });
    }

    await run("INSERT INTO blocks VALUES(?,?) ON CONFLICT DO NOTHING", uid, targetId);
    return send(200, { ok: true });
  }

  if (p === "/api/report" && m === "POST") {
    const targetId = +b.userId;
    const target = validUserId(targetId) && await one("SELECT * FROM users WHERE id=?", targetId);
    const reason = String(b.reason || "").trim().slice(0, 300);

    if (!target || targetId === uid || (!DEMO_MODE && target.bot)) {
      return send(400, { error: "Invalid user" });
    }

    if (reason.length < 3) {
      return send(400, { error: "Please provide a reason for the report" });
    }

    await run(
      "INSERT INTO reports(by_id,user_id,reason,created) VALUES(?,?,?,?)",
      uid, targetId, reason, Date.now()
    );

    return send(200, { ok: true });
  }

  return send(404, { error: "Not found" });
}

// A person's own changes (POST, PUT, DELETE) run one after another, as they did on SQLite,
// so two quick taps or two devices can't spend the same XP twice.
const userLocks = new Map();
const lockKey = req => {
  if (req.method === "GET" || req.method === "OPTIONS" || req.method === "HEAD") return null;
  const h = String(req.headers.authorization || ""), t = h.startsWith("Bearer ") ? h.slice(7) : "";
  try { return "u" + JSON.parse(Buffer.from(t.split(".")[0], "base64url").toString()).uid; } catch { return null; }
};
const withLock = async (key, fn) => {
  if (!key) return fn();
  const prev = userLocks.get(key) || Promise.resolve();
  let release; const mine = new Promise(r => { release = r; });
  const chain = prev.then(() => mine); userLocks.set(key, chain);
  await prev;
  try { return await fn(); } finally { release(); if (userLocks.get(key) === chain) userLocks.delete(key); }
};

http.createServer(async (req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
  };

  const send = (c, o) => {
    res.writeHead(c, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify(o));
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket.remoteAddress;

  const url = new URL(req.url, "http://x");

  if (!url.pathname.startsWith("/api") && url.pathname !== "/health") {
    return serveStatic(req, res, url.pathname);
  }

  if (!limit(ip, "all", 600)) {
    return send(429, { error: "Too many requests" });
  }

  let body = {};

  if (["POST", "PUT"].includes(req.method)) {
    let raw = "";

    for await (const c of req) {
      raw += c;
      if (raw.length > 1e5) {
        return send(413, { error: "Too large" });
      }
    }

    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return send(400, { error: "Bad JSON" });
    }
  }

  try {
    await withLock(lockKey(req), () => route(req.method, url.pathname, url, body, send, ip, req));
  } catch (e) {
    console.error(e);
    send(500, { error: "Server error" });
  }
}).listen(PORT, () => {
  console.log(
    "Love in Lagos is running: http://localhost:" + PORT +
    (PUBLIC ? "  (website from " + PUBLIC + ")" : "  (API only: no frontend folder found)")
  );

  if (DEMO_MODE) startDemo().catch(e => console.error("demo setup failed:", e.message));
}).on("error", e => {
  console.error(
    e.code === "EADDRINUSE"
      ? `\nPort ${PORT} is already in use by another program.\nUse another port: PORT=3001 node server.mjs (Windows PowerShell: $env:PORT=3001; node server.mjs)\n`
      : e.message
  );
  process.exit(1);
});

// ---------- Helpers added for the full-stack repo ----------

async function startGame(g) {
  // Draw 20 questions neither player has seen before, then open the game.
  let used = new Set(
    (await all("SELECT q FROM game_used WHERE user_id IN (?,?)", g.a_id, g.b_id))
      .map(x => x.q)
  );

  if (QCOUNT - used.size < 20) {
    await run("DELETE FROM game_used WHERE user_id IN (?,?)", g.a_id, g.b_id);
    used = new Set();
  }

  const pool = [...Array(QCOUNT).keys()].filter(i => !used.has(i));

  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const qs = pool.slice(0, 20);

  for (const q of qs) {
    for (const x of [g.a_id, g.b_id]) {
      await run("INSERT INTO game_used VALUES(?,?) ON CONFLICT DO NOTHING", x, q);
    }
  }

  await run(
    "UPDATE games SET status='playing',qs=?,i=0,asked=0 WHERE id=?",
    JSON.stringify(qs), g.id
  );

  await logA(g.a_id, "game", "🎲 Started 20 Questions");
  await logA(g.b_id, "game", "🎲 Started 20 Questions");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json"
};

function serveStatic(req, res, pathname) {
  // Serves the website from the frontend folder at the same address as the API.
  if (!PUBLIC) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(
      "<h1>Love in Lagos backend is running ✅</h1>" +
      "<p>No frontend folder was found next to this backend, so only the API is available " +
      "(<a href='/health'>/health</a> and /api/...).</p>" +
      "<p>Open the frontend folder's index.html in your browser: it will find this backend by itself.</p>"
    );
  }

  try {
    const decoded = decodeURIComponent(pathname);
    const file = path.resolve(PUBLIC, "." + decoded);
    const relative = path.relative(PUBLIC, file);

    // Reject paths that escape the frontend folder.
    if (
      relative === ".." ||
      relative.startsWith(".." + path.sep) ||
      path.isAbsolute(relative)
    ) {
      res.writeHead(403);
      return res.end();
    }

    let target = file;

    if (!existsSync(target) || !statSync(target).isFile()) {
      target = path.join(PUBLIC, "index.html");
    }

    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });

    res.end(readFileSync(target));
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ---------- Demo residents: 16 pretend people so a solo test run feels alive. ----------
// DEMO=false hides them from real users. Their database records are NOT deleted.

const BOTS = [
  ["amara", 25, "Woman", "Yaba", "Colour nerd. I sketch danfo conductors and chase the best puff-puff in town.", ["art", "food", "music"], "#c9507c", "#f2cadb"],
  ["tunde", 28, "Man", "Yaba", "Dev in Yaba who debugs better with jollof. Looking for good gist and better company.", ["tech", "food", "football"], "#4b7a5d", "#d6e3d3"],
  ["zainab", 26, "Woman", "Surulere", "I run a small kitchen in Surulere. Ask me about my pepper soup secret.", ["food", "business", "travel"], "#8f74b8", "#e4d6f0"],
  ["damilola", 29, "Man", "Lagos Island", "I design homes by day and walk the Marina by night. Slow walks, big ideas.", ["art", "fitness", "music"], "#d79a46", "#f3dfb8"],
  ["chioma", 27, "Woman", "Lekki", "Kind heart, loud laugh. Beach days are my reset button.", ["beach", "dance", "fitness"], "#2f9aa8", "#cdeaee"],
  ["seun", 30, "Man", "Lekki", "I'll race you to the water. Coach by day, storyteller at sunset.", ["fitness", "beach", "football"], "#e07a3f", "#f8dcc4"],
  ["fatima", 26, "Woman", "Ikoyi", "Lawyer, secret poet. I argue well but listen better.", ["poetry", "books", "coffee"], "#6a8f3c", "#e1ecc8"],
  ["emeka", 31, "Man", "Victoria Island", "I catch golden hour for a living. Suya connoisseur on the side.", ["photography", "suya", "travel"], "#3d6fb0", "#d3e1f5"],
  ["ngozi", 24, "Woman", "Yaba", "Latte art and late-night verses. I remember how you take your coffee.", ["coffee", "poetry", "books"], "#b45a5a", "#f1d3d3"],
  ["dayo", 28, "Man", "Ikeja", "Gentle giant and great listener. Yes, I read the menu twice.", ["business", "books", "coffee"], "#5a7d9a", "#d6e4ee"],
  ["amaka", 27, "Woman", "Surulere", "Sketchbook always open. Salsa on Sundays, if you can keep up.", ["art", "dance", "fashion"], "#cf7a4a", "#f5dcc8"],
  ["kelechi", 29, "Man", "Maryland", "I sing in the shower, on the bus and sometimes on stage.", ["music", "movies", "games"], "#7a5aa8", "#e2d8f1"],
  ["bisi", 26, "Woman", "Victoria Island", "Afrobeats on repeat. I'll play your song if you ask nicely.", ["music", "dance", "nightlife"], "#d6407a", "#f6cade"],
  ["bayo", 30, "Man", "Lekki", "I mix drinks and good conversations. Zero wahala energy.", ["nightlife", "music", "suya"], "#2f8f83", "#cdeae5"],
  ["tolu", 25, "Woman", "Ajah", "I plan the party, then dance at it. Ask me about my playlists.", ["dance", "food", "fashion"], "#c8892f", "#f4e1bd"],
  ["kunle", 28, "Man", "Gbagada", "Studio rat who finally came outside. Let's find a good rooftop.", ["music", "coffee", "games"], "#4a5fb0", "#d7dcf3"]
];

const BOT_REPLIES = [
  "Haha you made me smile 😄",
  "Omo, tell me more!",
  "Lagos traffic nearly stopped me from replying 🚌",
  "Abeg, what's your favourite food?",
  "I like how you talk 💚",
  "Let's meet for coffee this weekend ☕",
  "Wahala! You're funny o"
];

const BOT_ANSWERS = [
  "Hmm, honestly it depends on the day 😄",
  "Easy! Yes, and I'm not sorry 😂",
  "That's a tricky one. Ask me again after jollof 🍛",
  "I'd say yes, but only if you buy the suya 🍢",
  "Ha! You're bold. I like it 😏",
  "Mine is probably the same as yours, honestly 💛",
  "Can I answer that over coffee? ☕"
];

const pick = a => a[Math.floor(Math.random() * a.length)];

const hnum = s =>
  crypto.createHash("sha256").update(String(s)).digest()[0];

const isBot = async id =>
  !!await one("SELECT 1 x FROM users WHERE id=? AND bot=1", id);

async function botAnswer(g, uid) {
  await run(
    "INSERT INTO game_answers(game_id,qi,user_id,text,created) VALUES(?,?,?,?,?)",
    g.id, g.i, uid, pick(BOT_ANSWERS), Date.now()
  );

  if (g.i + 1 >= 20) {
    await run("UPDATE games SET status='done',i=20,asked=0 WHERE id=?", g.id);
    await logA(g.a_id, "game", "🎲 Finished 20 Questions");
    await award(g.a_id, 40, "game");
    await award(g.b_id, 40, "game");
    await logA(g.b_id, "game", "🎲 Finished 20 Questions");
  } else {
    await run("UPDATE games SET i=i+1,asked=0 WHERE id=?", g.id);
  }
}

async function startDemo() {
  // Keep existing residents. Only seed them if the database has none.
  if (!await one("SELECT 1 x FROM users WHERE bot=1")) {
    for (const [i, b] of BOTS.entries()) {
      await run(
        "INSERT INTO users(email,username,name,age,gender,bio,area,interests,avatar,pw,bot,loc,seen,created) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?)",
        b[0] + "@demo.local",
        b[0],
        b[0],
        b[1],
        b[2],
        b[4],
        b[3],
        JSON.stringify(b[5]),
        JSON.stringify({
          sk: ["#a8714f", "#8d5a3b", "#c08a62", "#7a4a30"][i % 4],
          sh: b[6],
          bg: b[7],
          hs: b[2] === "Woman" ? (i % 2 ? 1 : 3) : [0, 2, 4][i % 3]
        }),
        hash(crypto.randomBytes(16).toString("hex")),
        i % 9,
        Date.now(),
        Date.now()
      );
    }
  }

  let botBusy = false;
  setInterval(async () => { if (botBusy) return; botBusy = true; try { await botTick(); } catch (e) { console.error("botTick:", e.message); } finally { botBusy = false; } }, 1500).unref();
}

async function botTick() {
  try {
    const now = Date.now();
    const bots = await all("SELECT * FROM users WHERE bot=1");

    // Do nothing if there are no demo residents to act.
    if (!bots.length) return;

    for (const c of await all(
      "SELECT * FROM cupid WHERE status='open' AND created<?",
      now - 40000
    )) {
      const A = await one("SELECT * FROM users WHERE id=?", c.a);
      const B = await one("SELECT * FROM users WHERE id=?", c.b);

      if (
        !A ||
        !B ||
        await one(
          "SELECT 1 x FROM requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)",
          A.id, B.id, B.id, A.id
        )
      ) {
        continue;
      }

      if (A.bot && B.bot) {
        if (hnum(c.id) % 100 < 75) {
          await run(
            "INSERT INTO requests(from_id,to_id,status,pct,created) VALUES(?,?,'accepted',?,?)",
            A.id, B.id, compat(A, B).pct, now
          );
        }
      } else if (A.bot !== B.bot) {
        const bt = A.bot ? A : B;
        const hh = A.bot ? B : A;

        await run(
          "INSERT INTO requests(from_id,to_id,status,pct,created) VALUES(?,?,'pending',?,?)",
          bt.id, hh.id, compat(bt, hh).pct, now
        );

        await notify(hh.id, "match", "💘 " + bt.name + " sent you a match request", bt.id);
      }
    }

    await run("UPDATE users SET seen=? WHERE bot=1", now);

    if (Math.random() < 0.08) {
      await run(
        "UPDATE users SET loc=? WHERE id=?",
        Math.floor(Math.random() * 9),
        pick(bots).id
      );
    }

    for (const r of await all(
      "SELECT r.* FROM requests r JOIN users u ON u.id=r.to_id WHERE r.status='pending' AND u.bot=1 AND r.created<?",
      now - 3500
    )) {
      const ok = hnum(r.id) % 100 < (r.pct >= 50 ? 85 : 55);

      await run("UPDATE requests SET status=? WHERE id=?", ok ? "accepted" : "declined", r.id);

      if (ok) {
        await award(r.from_id, 25, "match");
        await award(r.to_id, 25, "match");
        await notify(r.from_id, "match", "🎉 " + await nameOf(r.to_id) + " accepted your match!", r.to_id);
      }
    }

    for (const m of await all(
      "SELECT m.from_id,m.to_id,MAX(m.id) mid,MAX(m.created) c FROM messages m JOIN users u ON u.id=m.to_id WHERE u.bot=1 GROUP BY m.from_id,m.to_id"
    )) {
      if (
        m.c < now - 1500 &&
        !await one(
          "SELECT 1 x FROM messages WHERE from_id=? AND to_id=? AND id>?",
          m.to_id, m.from_id, m.mid
        )
      ) {
        const t = pick(BOT_REPLIES);

        const botMsgId = (await one(
          "INSERT INTO messages(from_id,to_id,text,created) VALUES(?,?,?,?) RETURNING id",
          m.to_id, m.from_id, t, now
        )).id;
        await checkPhotoUnlock(m.to_id, m.from_id, botMsgId);

        if (!await one(
          "SELECT 1 x FROM notifs WHERE user_id=? AND kind='msg' AND from_id=? AND isread=0",
          m.from_id, m.to_id
        )) {
          await notify(m.from_id, "msg", await nameOf(m.to_id) + ": " + t.slice(0, 60), m.to_id);
        }
      }
    }

    for (const g of await all(
      "SELECT g.* FROM games g JOIN users u ON u.id=g.b_id WHERE g.status='invited' AND u.bot=1 AND g.created<?",
      now - 2500
    )) {
      if (hnum(g.id) % 100 < 75) {
        await startGame(g);
      } else {
        await run("UPDATE games SET status='declined' WHERE id=?", g.id);
      }
    }

    for (const g of await all("SELECT * FROM games WHERE status='playing'")) {
      const asker = g.i % 2 === 0 ? g.a_id : g.b_id;
      const answerer = asker === g.a_id ? g.b_id : g.a_id;

      if (Math.random() < 0.5) {
        if (await isBot(asker) && !g.asked) {
          await run("UPDATE games SET asked=1 WHERE id=?", g.id);
        } else if (await isBot(answerer) && g.asked) {
          await botAnswer(g, answerer);
        }
      }
    }

    const humans = await all(
      "SELECT * FROM users WHERE bot=0 AND seen>?",
      now - 90000
    );

    if (humans.length && Math.random() < 0.02) {
      const h = pick(humans);
      const bt = pick(bots);
      const pct = compat(bt, h).pct;

      if (
        pct >= 15 &&
        !await one(
          "SELECT 1 x FROM requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)",
          bt.id, h.id, h.id, bt.id
        ) &&
        !await blocked(bt.id, h.id)
      ) {
        await run(
          "INSERT INTO requests(from_id,to_id,status,pct,created) VALUES(?,?,'pending',?,?)",
          bt.id, h.id, pct, now
        );
      }
    }

    if (humans.length && Math.random() < 0.03) {
      await run(
        "INSERT INTO profile_views VALUES(?,?,?) ON CONFLICT (viewer_id,viewed_id) DO UPDATE SET created=EXCLUDED.created",
        pick(bots).id,
        pick(humans).id,
        now
      );
    }
  } catch (e) {
    console.error("demo residents:", e.message);
  }
} // end of botTick
