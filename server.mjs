// =====================================================================================
// LOVE IN LAGOS: BACKEND. No installs needed.
// Run inside this backend folder: node server.mjs (needs Node.js 22.13 or newer)
// Then open http://localhost:3000. Website files are in the ../frontend folder.
// Settings (environment variables, all optional): PORT, JWT_SECRET, DB_PATH, DEMO=false
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
const { DatabaseSync } = await import("node:sqlite");

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
  DB_PATH = "lagos.db",
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

const db = new DatabaseSync(DB_PATH);

db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
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
  seen INTEGER NOT NULL DEFAULT 0,
  bot INTEGER NOT NULL DEFAULT 0,
  pw TEXT NOT NULL,
  game TEXT DEFAULT '{}',
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS requests(
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  pct INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  UNIQUE(from_id,to_id)
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks(
  by_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY(by_id,user_id)
);
CREATE TABLE IF NOT EXISTS reports(
  id INTEGER PRIMARY KEY,
  by_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created INTEGER NOT NULL
);`);

db.exec(`CREATE TABLE IF NOT EXISTS games(
  id INTEGER PRIMARY KEY,
  a_id INTEGER NOT NULL,
  b_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  qs TEXT NOT NULL DEFAULT '[]',
  i INTEGER NOT NULL DEFAULT 0,
  asked INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS game_answers(
  game_id INTEGER NOT NULL,
  qi INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(game_id,qi)
);
CREATE TABLE IF NOT EXISTS game_used(
  user_id INTEGER NOT NULL,
  q INTEGER NOT NULL,
  PRIMARY KEY(user_id,q)
);
CREATE TABLE IF NOT EXISTS profile_views(
  viewer_id INTEGER NOT NULL,
  viewed_id INTEGER NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(viewer_id,viewed_id)
);
CREATE TABLE IF NOT EXISTS activity(
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_answers(
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  q TEXT NOT NULL,
  answer TEXT NOT NULL,
  correct TEXT NOT NULL,
  ok INTEGER NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(user_id,day)
);`);

db.exec("CREATE TABLE IF NOT EXISTS resets(user_id INTEGER PRIMARY KEY,code TEXT NOT NULL,exp INTEGER NOT NULL,tries INTEGER NOT NULL DEFAULT 0)");

try {
  db.exec("ALTER TABLE users ADD COLUMN tv INTEGER NOT NULL DEFAULT 0");
} catch {}

for (const c of [
  "xp INTEGER NOT NULL DEFAULT 0",
  "boost_until INTEGER NOT NULL DEFAULT 0",
  "spent INTEGER NOT NULL DEFAULT 0",
  "gin INTEGER NOT NULL DEFAULT 0",
  "outfits TEXT NOT NULL DEFAULT '[]'",
  "streak INTEGER NOT NULL DEFAULT 0",
  "best INTEGER NOT NULL DEFAULT 0",
  "last_day TEXT NOT NULL DEFAULT ''"
]) {
  try { db.exec("ALTER TABLE users ADD COLUMN " + c); } catch {}
}

db.exec("CREATE TABLE IF NOT EXISTS xp_events(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,day TEXT NOT NULL,amount INTEGER NOT NULL,reason TEXT NOT NULL,created INTEGER NOT NULL)");
db.exec("CREATE TABLE IF NOT EXISTS notifs(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,from_id INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,isread INTEGER NOT NULL DEFAULT 0)");
db.exec("CREATE TABLE IF NOT EXISTS cupid(id INTEGER PRIMARY KEY,from_id INTEGER NOT NULL,a INTEGER NOT NULL,b INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',created INTEGER NOT NULL)");

try {
  db.exec("ALTER TABLE requests ADD COLUMN auto INTEGER NOT NULL DEFAULT 0");
} catch {}

const QCOUNT = 500;
const one = (s, ...a) => db.prepare(s).get(...a);
const all = (s, ...a) => db.prepare(s).all(...a);
const run = (s, ...a) => db.prepare(s).run(...a);

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

const logA = (uid, kind, text) =>
  run("INSERT INTO activity(user_id,kind,text,created) VALUES(?,?,?,?)",
    uid, kind, String(text).slice(0, 120), Date.now());

const lagosDay = (off = 0) =>
  new Date(Date.now() + 3600000 - off * 864e5).toISOString().slice(0, 10);

const award = (uid, n, why, cap = 0) => {
  if (cap) {
    n = Math.min(
      n,
      cap - one(
        "SELECT COALESCE(SUM(amount),0) s FROM xp_events WHERE user_id=? AND day=? AND reason=?",
        uid, lagosDay(), why
      ).s
    );
  }
  if (n <= 0) return 0;
  run("INSERT INTO xp_events(user_id,day,amount,reason,created) VALUES(?,?,?,?,?)",
    uid, lagosDay(), n, why, Date.now());
  run("UPDATE users SET xp=xp+? WHERE id=?", n, uid);
  return n;
};

const notify = (uid, kind, text, from = 0) =>
  run("INSERT INTO notifs(user_id,kind,text,from_id,created) VALUES(?,?,?,?,?)",
    uid, kind, String(text).slice(0, 140), from, Date.now());

const lvl = p =>
  p >= 95 ? "💖 Perfect match" :
  p >= 80 ? "🔥 Sparks flying" :
  p > 50 ? "✨ Real potential" : "🌱 Worth a trial";

const nameOf = id => one("SELECT name FROM users WHERE id=?", id)?.name || "Someone";

const OUTFITS = [
  ["ot1", "Ankara shirt", 80, "ot", 1],
  ["ot2", "Suit & tie", 120, "ot", 2],
  ["ot3", "Agbada", 200, "ot", 3],
  ["ot4", "Hoodie", 100, "ot", 4],
  ["ot5", "Gold chain", 130, "ot", 5],
  ["hat1", "Gele", 150, "hat", 1],
  ["hat2", "Fila cap", 90, "hat", 2],
  ["hat3", "Crown", 300, "hat", 3]
];

const bumpStreak = uid => {
  const r = one("SELECT streak,last_day FROM users WHERE id=?", uid);
  const t = lagosDay();
  if (r.last_day === t) return;

  const n = r.last_day === lagosDay(1) ? r.streak + 1 : 1;
  run("UPDATE users SET streak=?,best=MAX(best,?),last_day=? WHERE id=?", n, n, t, uid);
  award(uid, Math.min(n, 7) * 5, "streak");

  if ([3, 7, 14, 30].includes(n)) {
    notify(uid, "streak", "🔥 " + n + "-day streak! Keep it going.");
  }
};

const badgesOf = (uid, best) => {
  const b = [];

  if (best >= 3) b.push("🔥 Warming up");
  if (best >= 7) b.push("🔥🔥 Week warrior");
  if (best >= 30) b.push("👑 Lagos Legend");

  for (const r of all(
    "SELECT SUBSTR(text, INSTR(text,' at ')+4) s, COUNT(*) c FROM activity WHERE user_id=? AND kind='act' AND INSTR(text,' at ')>0 GROUP BY s HAVING c>=10",
    uid
  )) {
    b.push("📍 " + r.s + " regular");
  }

  if (one("SELECT COUNT(*) c FROM requests WHERE status='accepted' AND (from_id=? OR to_id=?)", uid, uid).c >= 5) {
    b.push("💞 Social butterfly");
  }

  const cm = one("SELECT COUNT(*) c FROM cupid WHERE from_id=? AND status='matched'", uid).c;
  if (cm >= 10) b.push("💒 Aunty Matchmaker");
  else if (cm >= 5) b.push("🏹 Head Cupid");
  else if (cm >= 1) b.push("💘 Cupid");

  return b;
};

const cupidSettle = uid => {
  for (const c of all("SELECT * FROM cupid WHERE from_id=? AND status='open'", uid)) {
    if (one(
      "SELECT 1 x FROM requests WHERE status='accepted' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))",
      c.a, c.b, c.b, c.a
    )) {
      run("UPDATE cupid SET status='matched' WHERE id=?", c.id);
      award(uid, 60, "cupid");
      notify(uid, "cupid", "🎉 Your match worked! " + nameOf(c.a) + " and " + nameOf(c.b) + " matched. +60 XP", c.a);
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

const texts = (a, b) =>
  one("SELECT COUNT(*) n FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)",
    a, b, b, a).n;

const streak3 = (a, b) => {
  const days = all(
    "SELECT date((created/1000)+3600,'unixepoch') d FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) GROUP BY d HAVING COUNT(*)>=10 ORDER BY d",
    a, b, b, a
  ).map(x => Date.parse(x.d));

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

const blocked = (a, b) =>
  !!one("SELECT 1 x FROM blocks WHERE (by_id=? AND user_id=?) OR (by_id=? AND user_id=?)", a, b, b, a);

const friends = (a, b) =>
  !!one("SELECT 1 x FROM requests WHERE status='accepted' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))",
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

function route(m, p, url, b, send, ip, req) {
  if (p === "/health" || p === "/api/health") {
    return send(200, { ok: true });
  }

  if (p === "/api/username" && m === "GET") {
    const u = String(url.searchParams.get("u") || "").toLowerCase();
    return send(200, {
      available: UN.test(u) && !one("SELECT 1 x FROM users WHERE username=?", u)
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
    if (one("SELECT 1 x FROM users WHERE email=?", email)) return send(409, { error: "That email already has an account" });
    if (one("SELECT 1 x FROM users WHERE username=?", username)) return send(409, { error: "That username is already taken" });

    const photo = PHOTO.test(b.photo || "") && b.photo.length <= 150000 ? b.photo : "";

    let r;
    try {
      r = run(
        "INSERT INTO users(email,username,name,age,gender,bio,avatar,photo,pw,created) VALUES(?,?,?,0,'',?,?,?,?,?)",
        email, username, name, bio, JSON.stringify(cleanAv(b.avatar)), photo, hash(pw), Date.now()
      );
    } catch {
      return send(409, { error: "That username or email is already taken" });
    }

    const nu = one("SELECT * FROM users WHERE id=?", r.lastInsertRowid);
    return send(201, { token: sign(nu.id, nu.tv), user: full(nu) });
  }

  if (p === "/api/login" && m === "POST") {
    if (!limit(ip, "auth", 30)) {
      return send(429, { error: "Too many attempts. Try again in a minute." });
    }

    const idf = String(b.identifier || b.email || "").trim().toLowerCase();
    const nu = one("SELECT * FROM users WHERE email=? OR username=?", idf, idf);

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
    const x = id && one("SELECT * FROM users WHERE bot=0 AND (email=? OR username=?)", id, id);
    const out = {
      ok: true,
      message: "If that account exists, a 6-digit code was sent to its email. It works for 15 minutes."
    };

    if (!x) return send(200, out);

    const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");

    run("INSERT OR REPLACE INTO resets(user_id,code,exp,tries) VALUES(?,?,?,0)",
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
    const x = id && one("SELECT * FROM users WHERE bot=0 AND (email=? OR username=?)", id, id);
    const rr = x && one("SELECT * FROM resets WHERE user_id=?", x.id);
    const pw = String(b.password || "");

    if (pw.length < 8) return send(400, { error: "Password must be at least 8 characters" });

    const bad = { error: "That code is wrong or expired. Ask for a new one." };
    if (!rr || rr.exp < Date.now() || rr.tries >= 5) return send(400, bad);

    const want = Buffer.from(rr.code);
    const got = Buffer.from(mac("rs" + x.id + ":" + String(b.code || "").trim()));

    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
      run("UPDATE resets SET tries=tries+1 WHERE user_id=?", x.id);
      return send(400, bad);
    }

    run("UPDATE users SET pw=?,tv=tv+1 WHERE id=?", hash(pw), x.id);
    run("DELETE FROM resets WHERE user_id=?", x.id);

    const nu = one("SELECT * FROM users WHERE id=?", x.id);
    return send(200, { ok: true, token: sign(nu.id, nu.tv), user: full(nu) });
  }

  // Everything below needs a logged-in user.
  const tk = verify((req.headers.authorization || "").replace("Bearer ", ""));
  const uid = tk && tk.uid;
  const u = uid && one("SELECT * FROM users WHERE id=?", uid);

  if (!u || (!DEMO_MODE && u.bot) || (tk.tv || 0) !== u.tv) {
    return send(401, { error: "Please log in" });
  }

  if (p === "/api/me" && m === "GET") return send(200, full(u));

  if (p === "/api/me" && m === "PUT") {
    let un = u.username;

    if (b.username !== undefined) {
      un = String(b.username).trim().toLowerCase();
      if (!UN.test(un)) return send(400, { error: "Username: 3-20 letters, numbers, _ or ." });
      if (one("SELECT 1 x FROM users WHERE username=? AND id!=?", un, uid)) {
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

    run(
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

    run("UPDATE users SET name=? WHERE id=?", un, uid);
    if (b.photo !== undefined) run("UPDATE users SET photo=? WHERE id=?", b.photo || "", uid);

    return send(200, full(one("SELECT * FROM users WHERE id=?", uid)));
  }

  if (p === "/api/me" && m === "DELETE") {
    // Remove the account and every record connected to it as one transaction.
    db.exec("BEGIN");

    try {
      run("DELETE FROM requests WHERE from_id=? OR to_id=?", uid, uid);
      run("DELETE FROM messages WHERE from_id=? OR to_id=?", uid, uid);
      run("DELETE FROM blocks WHERE by_id=? OR user_id=?", uid, uid);
      run("DELETE FROM reports WHERE by_id=? OR user_id=?", uid, uid);

      run("DELETE FROM game_answers WHERE game_id IN (SELECT id FROM games WHERE a_id=? OR b_id=?)", uid, uid);
      run("DELETE FROM games WHERE a_id=? OR b_id=?", uid, uid);
      run("DELETE FROM game_used WHERE user_id=?", uid);

      run("DELETE FROM profile_views WHERE viewer_id=? OR viewed_id=?", uid, uid);
      run("DELETE FROM activity WHERE user_id=?", uid);
      run("DELETE FROM daily_answers WHERE user_id=?", uid);
      run("DELETE FROM resets WHERE user_id=?", uid);
      run("DELETE FROM xp_events WHERE user_id=?", uid);
      run("DELETE FROM notifs WHERE user_id=? OR from_id=?", uid, uid);
      run("DELETE FROM cupid WHERE from_id=? OR a=? OR b=?", uid, uid, uid);

      run("DELETE FROM users WHERE id=?", uid);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    return send(200, { ok: true });
  }

  const xpInfo = () => ({
    total: one("SELECT xp FROM users WHERE id=?", uid).xp,
    today: one(
      "SELECT COALESCE(SUM(amount),0) s FROM xp_events WHERE user_id=? AND day=? AND reason NOT IN ('boost','giftsent')",
      uid, lagosDay()
    ).s,
    goal: 1000,
    boostUntil: one("SELECT boost_until b FROM users WHERE id=?", uid).b,
    claimed: !!one("SELECT 1 x FROM xp_events WHERE user_id=? AND day=? AND reason='boost'", uid, lagosDay()),
    ...extraInfo()
  });

  const extraInfo = () => {
    const r = one("SELECT xp,gin,spent,streak,best FROM users WHERE id=?", uid);
    return {
      bal: r.xp + r.gin - r.spent,
      streak: r.streak,
      best: r.best,
      badges: badgesOf(uid, r.best)
    };
  };

  if (p === "/api/xp" && m === "GET") {
    bumpStreak(uid);
    cupidSettle(uid);
    return send(200, xpInfo());
  }

  if (p === "/api/xp/boost" && m === "POST") {
    const i = xpInfo();
    if (i.today < 1000) return send(400, { error: "Earn 1000 XP today first" });
    if (i.claimed) return send(409, { error: "You already used today’s Lagos Charm" });

    run("INSERT INTO xp_events(user_id,day,amount,reason,created) VALUES(?,?,0,'boost',?)",
      uid, lagosDay(), Date.now());
    run("UPDATE users SET boost_until=? WHERE id=?", Date.now() + 36e5, uid);
    logA(uid, "daily", "⚡ Lagos Charm on for 1 hour");

    return send(200, xpInfo());
  }

  if (p === "/api/notifs" && m === "GET") {
    const botFilter = DEMO_MODE ? "" : " AND (from_id=0 OR from_id IN (SELECT id FROM users WHERE bot=0))";

    return send(200, {
      items: all(
        `SELECT id,kind,text,from_id,created at,isread FROM notifs WHERE user_id=?${botFilter} ORDER BY id DESC LIMIT 30`,
        uid
      ),
      unread: one(
        `SELECT COUNT(*) c FROM notifs WHERE user_id=? AND isread=0${botFilter}`,
        uid
      ).c
    });
  }

  if (p === "/api/notifs/read" && m === "POST") {
    run("UPDATE notifs SET isread=1 WHERE user_id=?", uid);
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

    run("UPDATE users SET spent=spent+?,outfits=?,avatar=? WHERE id=?",
      it[2], JSON.stringify(own),
      JSON.stringify({ ...J(u.avatar, {}), [it[3]]: it[4] }),
      uid);

    const nu = one("SELECT * FROM users WHERE id=?", uid);
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

    run("UPDATE users SET avatar=? WHERE id=?", JSON.stringify(av), uid);
    return send(200, { user: full(one("SELECT * FROM users WHERE id=?", uid)) });
  }

  if (p === "/api/gift" && m === "POST") {
    const to = +b.to;
    const n = +b.amount;
    const o = one("SELECT * FROM users WHERE id=?", to);

    if (!o || to === uid || (!DEMO_MODE && o.bot) || ![10, 25, 50].includes(n)) {
      return send(400, { error: "Cannot gift" });
    }

    if (blocked(uid, to)) return send(400, { error: "Cannot gift this user" });
    if (u.xp + u.gin - u.spent < n) return send(400, { error: "Not enough XP" });

    if (one(
      "SELECT COALESCE(SUM(amount),0) s FROM xp_events WHERE user_id=? AND day=? AND reason='giftsent'",
      uid, lagosDay()
    ).s + n > 100) {
      return send(400, { error: "You can gift up to 100 XP a day" });
    }

    run("INSERT INTO xp_events(user_id,day,amount,reason,created) VALUES(?,?,?,'giftsent',?)",
      uid, lagosDay(), n, Date.now());
    run("UPDATE users SET spent=spent+? WHERE id=?", n, uid);
    run("UPDATE users SET gin=gin+? WHERE id=?", n, to);

    notify(to, "gift", u.name + " gifted you " + n + " XP 🎁", uid);
    return send(200, { ok: true });
  }

  if (p === "/api/leaderboard" && m === "GET") {
    const wk = lagosDay((new Date(lagosDay() + "T00:00:00Z").getUTCDay() + 6) % 7);
    const sc = new Map();

    const scores = DEMO_MODE
      ? all("SELECT e.user_id, SUM(e.amount) s FROM xp_events e JOIN users u ON u.id=e.user_id WHERE e.day>=? AND e.reason NOT IN ('boost','giftsent') GROUP BY e.user_id", wk)
      : all("SELECT e.user_id, SUM(e.amount) s FROM xp_events e JOIN users u ON u.id=e.user_id WHERE e.day>=? AND e.reason NOT IN ('boost','giftsent') AND u.bot=0 GROUP BY e.user_id", wk);

    for (const r of scores) sc.set(r.user_id, r.s);

    if (DEMO_MODE) {
      for (const r of all("SELECT id FROM users WHERE bot=1")) {
        sc.set(r.id, (sc.get(r.id) || 0) + 40 + hnum(r.id + "w" + wk) % 220);
      }
    }

    const rk = [...sc].sort((x, y) => y[1] - x[1]);
    const i = rk.findIndex(x => x[0] === uid);

    return send(200, {
      top: rk.slice(0, 10).map(([id, xp]) => ({
        user: pub(one("SELECT * FROM users WHERE id=?", id)),
        xp
      })),
      me: i >= 0 ? { rank: i + 1, xp: rk[i][1] } : null
    });
  }

  if (p === "/api/cupid" && m === "GET") {
    cupidSettle(uid);

    const day = Date.now() - 864e5;
    const usr = id => {
      const person = one("SELECT * FROM users WHERE id=?", id);
      return person && (DEMO_MODE || !person.bot) ? pub(person) : null;
    };

    const mine = all(
      "SELECT * FROM cupid WHERE from_id=? ORDER BY id DESC LIMIT 8",
      uid
    ).map(c => ({
      id: c.id,
      status: c.status,
      a: usr(c.a),
      b: usr(c.b)
    })).filter(c => c.a && c.b);

    const topSql = DEMO_MODE
      ? "SELECT from_id, COUNT(*) c FROM cupid WHERE status='matched' GROUP BY from_id ORDER BY c DESC LIMIT 5"
      : "SELECT c.from_id, COUNT(*) c FROM cupid c JOIN users u ON u.id=c.from_id AND u.bot=0 JOIN users a ON a.id=c.a AND a.bot=0 JOIN users b ON b.id=c.b AND b.bot=0 WHERE c.status='matched' GROUP BY c.from_id ORDER BY c DESC LIMIT 5";

    const top = all(topSql).map(r => ({ user: usr(r.from_id), count: r.c })).filter(r => r.user);

    return send(200, {
      mine,
      top,
      matched: one("SELECT COUNT(*) c FROM cupid WHERE from_id=? AND status='matched'", uid).c,
      left: Math.max(0, 3 - one("SELECT COUNT(*) c FROM cupid WHERE from_id=? AND created>?", uid, day).c)
    });
  }

  if (p === "/api/cupid" && m === "POST") {
    const A = +b.a;
    const B = +b.b;
    const ua = one("SELECT * FROM users WHERE id=?", A);
    const ub = one("SELECT * FROM users WHERE id=?", B);

    if (!ua || !ub || A === B || A === uid || B === uid || (!DEMO_MODE && (ua.bot || ub.bot))) {
      return send(400, { error: "Pick two other people" });
    }

    if (blocked(A, B) || blocked(uid, A) || blocked(uid, B)) {
      return send(400, { error: "You can’t introduce these two" });
    }

    if (one("SELECT 1 x FROM requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)", A, B, B, A)) {
      return send(409, { error: "These two already know each other" });
    }

    if (one("SELECT 1 x FROM cupid WHERE status='open' AND ((a=? AND b=?) OR (a=? AND b=?))", A, B, B, A)) {
      return send(409, { error: "Someone already introduced them" });
    }

    if (one("SELECT COUNT(*) c FROM cupid WHERE from_id=? AND created>?", uid, Date.now() - 864e5).c >= 3) {
      return send(429, { error: "You can introduce 3 couples a day" });
    }

    run("INSERT INTO cupid(from_id,a,b,created) VALUES(?,?,?,?)", uid, A, B, Date.now());
    award(uid, 5, "cupid-intro", 15);

    notify(A, "cupid", "💘 " + u.name + " thinks you and " + ub.name + " would click!", B);
    notify(B, "cupid", "💘 " + u.name + " thinks you and " + ua.name + " would click!", A);

    return send(200, { ok: true });
  }

  if (p === "/api/activity" && m === "POST") {
    if (!["act", "rest"].includes(b.kind)) return send(400, { error: "Bad kind" });
    if (!limit(ip, "act", 120)) return send(429, { error: "Slow down" });

    logA(uid, b.kind, b.text || "");
    if (b.kind === "act") award(uid, 10, "act", 100);

    return send(200, { ok: true });
  }

  if (p === "/api/activity" && m === "GET") {
    const dq = url.searchParams.get("day") || "";
    const day = /^\d{4}-\d{2}-\d{2}$/.test(dq) ? dq : lagosDay();
    const start = Date.parse(day + "T00:00:00Z") - 3600000;

    return send(200, all(
      "SELECT kind,text,created FROM activity WHERE user_id=? AND created>=? AND created<? ORDER BY created",
      uid, start, start + 864e5
    ));
  }

  if (p === "/api/daily" && m === "GET") {
    const d = DAILY[new Date(Date.now() + 3600000).getUTCDay()];
    const a = one("SELECT * FROM daily_answers WHERE user_id=? AND day=?", uid, lagosDay());
    const days = new Set(all("SELECT day FROM daily_answers WHERE user_id=?", uid).map(x => x.day));

    let streak = 0;
    for (let o = a ? 0 : 1; days.has(lagosDay(o)); o++) streak++;

    return send(200, {
      title: d[0],
      question: d[1],
      options: d[2],
      streak,
      answered: a ? { answer: a.answer, correct: a.correct, ok: !!a.ok } : null,
      history: all(
        "SELECT day,q,answer,correct,ok FROM daily_answers WHERE user_id=? ORDER BY day DESC LIMIT 7",
        uid
      ).map(x => ({ ...x, ok: !!x.ok }))
    });
  }

  if (p === "/api/daily/answer" && m === "POST") {
    const d = DAILY[new Date(Date.now() + 3600000).getUTCDay()];
    const opt = Math.trunc(+b.option);

    if (!(opt >= 0 && opt < d[2].length)) return send(400, { error: "Pick one of the options" });
    if (one("SELECT 1 x FROM daily_answers WHERE user_id=? AND day=?", uid, lagosDay())) {
      return send(409, { error: "Already answered today" });
    }

    const ok = opt === d[3];
    award(uid, ok ? 30 : 10, "daily");

    run(
      "INSERT INTO daily_answers(user_id,day,q,answer,correct,ok,created) VALUES(?,?,?,?,?,?,?)",
      uid, lagosDay(), d[1], d[2][opt], d[2][d[3]], ok ? 1 : 0, Date.now()
    );

    logA(uid, "daily", "🗓️ Answered the daily question: " + d[2][opt] + (ok ? " ✅" : " ❌"));
    return send(200, { ok, correct: d[2][d[3]] });
  }

  if (p === "/api/qa" && m === "GET") {
    const rows = DEMO_MODE
      ? all(
          "SELECT ga.qi,ga.text,ga.user_id,ga.created,g.qs,g.a_id,g.b_id FROM game_answers ga JOIN games g ON g.id=ga.game_id WHERE g.a_id=? OR g.b_id=? ORDER BY ga.created DESC LIMIT 30",
          uid, uid
        )
      : all(
          "SELECT ga.qi,ga.text,ga.user_id,ga.created,g.qs,g.a_id,g.b_id FROM game_answers ga JOIN games g ON g.id=ga.game_id JOIN users other ON other.id=CASE WHEN g.a_id=? THEN g.b_id ELSE g.a_id END WHERE (g.a_id=? OR g.b_id=?) AND other.bot=0 ORDER BY ga.created DESC LIMIT 30",
          uid, uid, uid
        );

    return send(200, rows.map(x => ({
      questionId: J(x.qs, [])[x.qi],
      answer: x.text,
      answeredBy: x.user_id === uid ? "you" : "them",
      with: one("SELECT username FROM users WHERE id=?", x.a_id === uid ? x.b_id : x.a_id)?.username,
      at: x.created
    })));
  }

  if (p === "/api/presence" && m === "POST") {
    const l = Math.trunc(+b.loc);
    if (!(l >= -1 && l <= 8)) return send(400, { error: "Bad location" });

    run("UPDATE users SET loc=?,seen=? WHERE id=?", l, Date.now(), uid);
    return send(200, { ok: true });
  }

  if (p === "/api/people" && m === "GET") {
    const loc = url.searchParams.get("loc");
    const botFilter = DEMO_MODE ? "" : " AND bot=0";

    if (loc !== null) {
      return send(200, all(
        `SELECT * FROM users WHERE id!=? AND loc=? AND seen>?${botFilter}
         AND id NOT IN (SELECT user_id FROM blocks WHERE by_id=?)
         AND id NOT IN (SELECT by_id FROM blocks WHERE user_id=?)
         ORDER BY seen DESC LIMIT 50`,
        uid, +loc, Date.now() - 90000, uid, uid
      ).map(pub));
    }

    const q = "%" + String(url.searchParams.get("q") || "").trim().toLowerCase().replace(/%/g, "") + "%";

    return send(200, all(
      `SELECT * FROM users WHERE id!=? AND username LIKE ?${botFilter}
       AND id NOT IN (SELECT user_id FROM blocks WHERE by_id=?)
       AND id NOT IN (SELECT by_id FROM blocks WHERE user_id=?)
       ORDER BY id DESC LIMIT 50`,
      uid, q, uid, uid
    ).map(pub));
  }

  if (p === "/api/matches" && m === "POST") {
    const to = +b.to;
    const o = one("SELECT * FROM users WHERE id=?", to);
    const boost0 = u.boost_until > Date.now();

    if (!o || to === uid || (!DEMO_MODE && o.bot) || blocked(uid, to)) {
      return send(400, { error: "Cannot match" });
    }

    if (!limit(ip, "req", 30)) return send(429, { error: "Slow down" });

    const ex = one(
      "SELECT * FROM requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)",
      uid, to, to, uid
    );

    if (ex && ex.status === "pending" && ex.to_id === uid) {
      run("UPDATE requests SET status='accepted' WHERE id=?", ex.id);
      award(uid, 25, "match");
      award(to, 25, "match");
      notify(to, "match", "🎉 " + u.name + " matched with you!", uid);
      return send(200, { pct: ex.pct, status: "matched" });
    }

    if (ex && ex.status !== "accepted" && boost0) {
      run("UPDATE requests SET status='accepted',auto=1 WHERE id=?", ex.id);
      award(uid, 25, "match");
      award(to, 25, "match");
      notify(to, "match", "🎉 " + u.name + " matched with you!", uid);
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
      logA(uid, "match", "💔 Match with @" + o.username + " didn't work out (" + pct + "%)");
      return send(200, { pct, why, status: "low" });
    }

    const auto = pct >= 95 || boost;

    if (auto) {
      award(uid, 25, "match");
      award(to, 25, "match");
    } else {
      award(uid, 5, "sent", 25);
    }

    run(
      "INSERT INTO requests(from_id,to_id,status,pct,created,auto) VALUES(?,?,?,?,?,?)",
      uid, to, auto ? "accepted" : "pending", pct, Date.now(), auto ? 1 : 0
    );

    logA(uid, "match",
      (auto ? "💘 Instantly matched with @" : "💘 Sent a match to @") + o.username + " (" + pct + "%)");

    notify(
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
      incoming: all(
        `SELECT u.*,r.id rid,r.pct FROM requests r
         JOIN users u ON u.id=r.from_id
         WHERE r.to_id=? AND r.status='pending'${botFilter}
         ORDER BY r.created DESC`,
        uid
      ).map(x => ({ requestId: x.rid, pct: x.pct, user: pub(x) })),

      matches: all(
        `SELECT u.*,r.pct,r.auto FROM requests r
         JOIN users u ON u.id=(CASE WHEN r.from_id=? THEN r.to_id ELSE r.from_id END)
         WHERE r.status='accepted' AND (r.from_id=? OR r.to_id=?)${botFilter}`,
        uid, uid, uid
      ).map(x => ({
        pct: x.pct,
        user: pub(x),
        talking: x.pct >= 90 || x.auto === 1 ||
          texts(uid, x.id) >= 100 || streak3(uid, x.id),
        photoUnlocked: texts(uid, x.id) >= 100,
        count: texts(uid, x.id),
        last: one(
          "SELECT from_id,text,created FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY id DESC LIMIT 1",
          uid, x.id, x.id, uid
        ) || null
      })),

      sent: all(
        `SELECT u.*,r.pct FROM requests r
         JOIN users u ON u.id=r.to_id
         WHERE r.from_id=? AND r.status='pending'${botFilter}`,
        uid
      ).map(x => ({ pct: x.pct, user: pub(x) }))
    });
  }
    let mm = p.match(/^\/api\/matches\/(\d+)\/respond$/);

  if (mm && m === "POST") {
    const r = one(
      "SELECT * FROM requests WHERE id=? AND to_id=? AND status='pending'",
      +mm[1], uid
    );

    if (!r || (!DEMO_MODE && isBot(r.from_id))) {
      return send(404, { error: "Match request not found" });
    }

    run("UPDATE requests SET status=? WHERE id=?", b.accept ? "accepted" : "declined", r.id);

    if (b.accept) {
      award(uid, 25, "match");
      award(r.from_id, 25, "match");
      notify(r.from_id, "match", "🎉 " + u.name + " accepted your match!", uid);
      logA(uid, "match", "🎉 You accepted a match");
      logA(r.from_id, "match", "🎉 Someone accepted your match");
    }

    return send(200, { ok: true });
  }

  mm = p.match(/^\/api\/messages\/(\d+)$/);

  if (mm) {
    const other = +mm[1];
    const otherUser = one("SELECT * FROM users WHERE id=?", other);

    if (
      !otherUser ||
      (!DEMO_MODE && otherUser.bot) ||
      !friends(uid, other) ||
      blocked(uid, other)
    ) {
      return send(403, { error: "You can only chat with friends" });
    }

    if (m === "GET") {
      return send(200, all(
        "SELECT id,from_id,text,created FROM messages WHERE id>? AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) ORDER BY id LIMIT 100",
        +url.searchParams.get("after") || 0,
        uid, other, other, uid
      ));
    }

    if (m === "POST") {
      const text = String(b.text || "").trim().slice(0, 500);

      if (!text) return send(400, { error: "Empty message" });
      if (!limit(ip, "msg", 120)) return send(429, { error: "Slow down" });

      run("INSERT INTO messages(from_id,to_id,text,created) VALUES(?,?,?,?)",
        uid, other, text, Date.now());

      award(uid, 2, "msg", 40);

      if (!one(
        "SELECT 1 x FROM notifs WHERE user_id=? AND kind='msg' AND from_id=? AND isread=0",
        other, uid
      )) {
        notify(other, "msg", u.name + ": " + text.slice(0, 60), uid);
      }

      return send(201, { ok: true });
    }
  }

  // 20 Questions: invite -> friend accepts or declines -> players take turns asking.
  if (p === "/api/games/invite" && m === "POST") {
    const o = +b.userId;
    const otherUser = one("SELECT * FROM users WHERE id=?", o);

    if (
      !otherUser ||
      (!DEMO_MODE && otherUser.bot) ||
      !friends(uid, o) ||
      blocked(uid, o)
    ) {
      return send(403, { error: "You can only play with your matches" });
    }

    if (one(
      "SELECT 1 x FROM games WHERE status IN ('invited','playing') AND ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?))",
      uid, o, o, uid
    )) {
      return send(409, { error: "A game is already open" });
    }

    const r = run(
      "INSERT INTO games(a_id,b_id,status,created) VALUES(?,?,'invited',?)",
      uid, o, Date.now()
    );

    return send(201, { id: Number(r.lastInsertRowid) });
  }

  mm = p.match(/^\/api\/games\/(\d+)\/(respond|ask|answer)$/);

  if (mm && m === "POST") {
    const g = one(
      "SELECT * FROM games WHERE id=? AND (a_id=? OR b_id=?)",
      +mm[1], uid, uid
    );

    if (!g) return send(404, { error: "Game not found" });

    const opponentId = g.a_id === uid ? g.b_id : g.a_id;

    if (!DEMO_MODE && isBot(opponentId)) {
      return send(404, { error: "Game not found" });
    }

    if (blocked(uid, opponentId)) {
      return send(403, { error: "You cannot play with this user" });
    }

    if (mm[2] === "respond") {
      if (g.b_id !== uid || g.status !== "invited") {
        return send(403, { error: "Only the invited player can answer" });
      }

      if (!b.accept) {
        run("UPDATE games SET status='declined' WHERE id=?", g.id);
        return send(200, { ok: true });
      }

      startGame(g);
      return send(200, { ok: true });
    }

    if (g.status !== "playing") {
      return send(400, { error: "Game is not running" });
    }

    const asker = g.i % 2 === 0 ? g.a_id : g.b_id;

    if (mm[2] === "ask") {
      if (uid !== asker || g.asked) {
        return send(403, { error: "Not your turn to ask" });
      }

      run("UPDATE games SET asked=1 WHERE id=?", g.id);
      return send(200, { ok: true });
    }

    if (uid === asker || !g.asked) {
      return send(403, { error: "Not your turn to answer" });
    }

    const text = String(b.text || "").trim().slice(0, 300);

    if (!text) return send(400, { error: "Write an answer" });

    run(
      "INSERT INTO game_answers(game_id,qi,user_id,text,created) VALUES(?,?,?,?,?)",
      g.id, g.i, uid, text, Date.now()
    );

    if (g.i + 1 >= 20) {
      run("UPDATE games SET status='done',i=20,asked=0 WHERE id=?", g.id);
      logA(g.a_id, "game", "🎲 Finished 20 Questions");
      award(g.a_id, 40, "game");
      award(g.b_id, 40, "game");
      logA(g.b_id, "game", "🎲 Finished 20 Questions");
    } else {
      run("UPDATE games SET i=i+1,asked=0 WHERE id=?", g.id);
    }

    return send(200, { ok: true });
  }

  mm = p.match(/^\/api\/games\/with\/(\d+)$/);

  if (mm && m === "GET") {
    const o = +mm[1];
    const otherUser = one("SELECT * FROM users WHERE id=?", o);

    if (
      !otherUser ||
      (!DEMO_MODE && otherUser.bot) ||
      blocked(uid, o)
    ) {
      return send(200, null);
    }

    const g = one(
      "SELECT * FROM games WHERE (a_id=? AND b_id=?) OR (a_id=? AND b_id=?) ORDER BY id DESC LIMIT 1",
      uid, o, o, uid
    );

    if (!g) return send(200, null);

    const qs = J(g.qs, []);
    const ans = all(
      "SELECT qi,user_id,text FROM game_answers WHERE game_id=?",
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
    const target = validUserId(to) && one("SELECT * FROM users WHERE id=?", to);

    if (
      !target ||
      to === uid ||
      (!DEMO_MODE && target.bot) ||
      blocked(uid, to)
    ) {
      return send(200, { ok: true });
    }

    run("INSERT OR REPLACE INTO profile_views VALUES(?,?,?)", uid, to, Date.now());
    return send(200, { ok: true });
  }

  if (p === "/api/visitors" && m === "GET") {
    const botFilter = DEMO_MODE ? "" : " AND u.bot=0";

    return send(200, all(
      `SELECT u.*,v.created seen
       FROM profile_views v
       JOIN users u ON u.id=v.viewer_id
       WHERE v.viewed_id=?${botFilter}
       AND u.id NOT IN (SELECT user_id FROM blocks WHERE by_id=?)
       AND u.id NOT IN (SELECT by_id FROM blocks WHERE user_id=?)
       ORDER BY v.created DESC LIMIT 50`,
      uid, uid, uid
    ).map(x => ({ user: pub(x), at: x.seen })));
  }

  mm = p.match(/^\/api\/photo\/(\d+)$/);

  if (mm && m === "GET") {
    const o = +mm[1];
    const otherUser = one("SELECT * FROM users WHERE id=?", o);

    if (
      !otherUser ||
      (!DEMO_MODE && otherUser.bot) ||
      !friends(uid, o) ||
      blocked(uid, o) ||
      texts(uid, o) < 100
    ) {
      return send(403, { error: "Photos unlock after 100 messages" });
    }

    return send(200, {
      photo: otherUser.photo || ""
    });
  }

  if (p === "/api/block" && m === "POST") {
    const targetId = +b.userId;
    const target = validUserId(targetId) && one("SELECT * FROM users WHERE id=?", targetId);

    if (!target || targetId === uid || (!DEMO_MODE && target.bot)) {
      return send(400, { error: "Invalid user" });
    }

    run("INSERT OR IGNORE INTO blocks VALUES(?,?)", uid, targetId);
    return send(200, { ok: true });
  }

  if (p === "/api/report" && m === "POST") {
    const targetId = +b.userId;
    const target = validUserId(targetId) && one("SELECT * FROM users WHERE id=?", targetId);
    const reason = String(b.reason || "").trim().slice(0, 300);

    if (!target || targetId === uid || (!DEMO_MODE && target.bot)) {
      return send(400, { error: "Invalid user" });
    }

    if (reason.length < 3) {
      return send(400, { error: "Please provide a reason for the report" });
    }

    run(
      "INSERT INTO reports(by_id,user_id,reason,created) VALUES(?,?,?,?)",
      uid, targetId, reason, Date.now()
    );

    return send(200, { ok: true });
  }

  return send(404, { error: "Not found" });
}

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
    route(req.method, url.pathname, url, body, send, ip, req);
  } catch (e) {
    console.error(e);
    send(500, { error: "Server error" });
  }
}).listen(PORT, () => {
  console.log(
    "Love in Lagos is running: http://localhost:" + PORT +
    (PUBLIC ? "  (website from " + PUBLIC + ")" : "  (API only: no frontend folder found)")
  );

  if (DEMO_MODE) startDemo();
}).on("error", e => {
  console.error(
    e.code === "EADDRINUSE"
      ? `\nPort ${PORT} is already in use by another program.\nUse another port: PORT=3001 node server.mjs (Windows PowerShell: $env:PORT=3001; node server.mjs)\n`
      : e.message
  );
  process.exit(1);
});

// ---------- Helpers added for the full-stack repo ----------

function startGame(g) {
  // Draw 20 questions neither player has seen before, then open the game.
  let used = new Set(
    all("SELECT q FROM game_used WHERE user_id IN (?,?)", g.a_id, g.b_id)
      .map(x => x.q)
  );

  if (QCOUNT - used.size < 20) {
    run("DELETE FROM game_used WHERE user_id IN (?,?)", g.a_id, g.b_id);
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
      run("INSERT OR IGNORE INTO game_used VALUES(?,?)", x, q);
    }
  }

  run(
    "UPDATE games SET status='playing',qs=?,i=0,asked=0 WHERE id=?",
    JSON.stringify(qs), g.id
  );

  logA(g.a_id, "game", "🎲 Started 20 Questions");
  logA(g.b_id, "game", "🎲 Started 20 Questions");
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

const isBot = id =>
  !!one("SELECT 1 x FROM users WHERE id=? AND bot=1", id);

function botAnswer(g, uid) {
  run(
    "INSERT INTO game_answers(game_id,qi,user_id,text,created) VALUES(?,?,?,?,?)",
    g.id, g.i, uid, pick(BOT_ANSWERS), Date.now()
  );

  if (g.i + 1 >= 20) {
    run("UPDATE games SET status='done',i=20,asked=0 WHERE id=?", g.id);
    logA(g.a_id, "game", "🎲 Finished 20 Questions");
    award(g.a_id, 40, "game");
    award(g.b_id, 40, "game");
    logA(g.b_id, "game", "🎲 Finished 20 Questions");
  } else {
    run("UPDATE games SET i=i+1,asked=0 WHERE id=?", g.id);
  }
}

function startDemo() {
  // Keep existing residents. Only seed them if the database has none.
  if (!one("SELECT 1 x FROM users WHERE bot=1")) {
    BOTS.forEach((b, i) => {
      run(
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
    });
  }

  setInterval(botTick, 1500).unref();
}

function botTick() {
  try {
    const now = Date.now();
    const bots = all("SELECT * FROM users WHERE bot=1");

    // Do nothing if there are no demo residents to act.
    if (!bots.length) return;

    for (const c of all(
      "SELECT * FROM cupid WHERE status='open' AND created<?",
      now - 40000
    )) {
      const A = one("SELECT * FROM users WHERE id=?", c.a);
      const B = one("SELECT * FROM users WHERE id=?", c.b);

      if (
        !A ||
        !B ||
        one(
          "SELECT 1 x FROM requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)",
          A.id, B.id, B.id, A.id
        )
      ) {
        continue;
      }

      if (A.bot && B.bot) {
        if (hnum(c.id) % 100 < 75) {
          run(
            "INSERT INTO requests(from_id,to_id,status,pct,created) VALUES(?,?,'accepted',?,?)",
            A.id, B.id, compat(A, B).pct, now
          );
        }
      } else if (A.bot !== B.bot) {
        const bt = A.bot ? A : B;
        const hh = A.bot ? B : A;

        run(
          "INSERT INTO requests(from_id,to_id,status,pct,created) VALUES(?,?,'pending',?,?)",
          bt.id, hh.id, compat(bt, hh).pct, now
        );

        notify(hh.id, "match", "💘 " + bt.name + " sent you a match request", bt.id);
      }
    }

    run("UPDATE users SET seen=? WHERE bot=1", now);

    if (Math.random() < 0.08) {
      run(
        "UPDATE users SET loc=? WHERE id=?",
        Math.floor(Math.random() * 9),
        pick(bots).id
      );
    }

    for (const r of all(
      "SELECT r.* FROM requests r JOIN users u ON u.id=r.to_id WHERE r.status='pending' AND u.bot=1 AND r.created<?",
      now - 3500
    )) {
      const ok = hnum(r.id) % 100 < (r.pct >= 50 ? 85 : 55);

      run("UPDATE requests SET status=? WHERE id=?", ok ? "accepted" : "declined", r.id);

      if (ok) {
        award(r.from_id, 25, "match");
        award(r.to_id, 25, "match");
        notify(r.from_id, "match", "🎉 " + nameOf(r.to_id) + " accepted your match!", r.to_id);
      }
    }

    for (const m of all(
      "SELECT m.from_id,m.to_id,MAX(m.id) mid,MAX(m.created) c FROM messages m JOIN users u ON u.id=m.to_id WHERE u.bot=1 GROUP BY m.from_id,m.to_id"
    )) {
      if (
        m.c < now - 1500 &&
        !one(
          "SELECT 1 x FROM messages WHERE from_id=? AND to_id=? AND id>?",
          m.to_id, m.from_id, m.mid
        )
      ) {
        const t = pick(BOT_REPLIES);

        run(
          "INSERT INTO messages(from_id,to_id,text,created) VALUES(?,?,?,?)",
          m.to_id, m.from_id, t, now
        );

        if (!one(
          "SELECT 1 x FROM notifs WHERE user_id=? AND kind='msg' AND from_id=? AND isread=0",
          m.from_id, m.to_id
        )) {
          notify(m.from_id, "msg", nameOf(m.to_id) + ": " + t.slice(0, 60), m.to_id);
        }
      }
    }

    for (const g of all(
      "SELECT g.* FROM games g JOIN users u ON u.id=g.b_id WHERE g.status='invited' AND u.bot=1 AND g.created<?",
      now - 2500
    )) {
      if (hnum(g.id) % 100 < 75) {
        startGame(g);
      } else {
        run("UPDATE games SET status='declined' WHERE id=?", g.id);
      }
    }

    for (const g of all("SELECT * FROM games WHERE status='playing'")) {
      const asker = g.i % 2 === 0 ? g.a_id : g.b_id;
      const answerer = asker === g.a_id ? g.b_id : g.a_id;

      if (Math.random() < 0.5) {
        if (isBot(asker) && !g.asked) {
          run("UPDATE games SET asked=1 WHERE id=?", g.id);
        } else if (isBot(answerer) && g.asked) {
          botAnswer(g, answerer);
        }
      }
    }

    const humans = all(
      "SELECT * FROM users WHERE bot=0 AND seen>?",
      now - 90000
    );

    if (humans.length && Math.random() < 0.02) {
      const h = pick(humans);
      const bt = pick(bots);
      const pct = compat(bt, h).pct;

      if (
        pct >= 15 &&
        !one(
          "SELECT 1 x FROM requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)",
          bt.id, h.id, h.id, bt.id
        ) &&
        !blocked(bt.id, h.id)
      ) {
        run(
          "INSERT INTO requests(from_id,to_id,status,pct,created) VALUES(?,?,'pending',?,?)",
          bt.id, h.id, pct, now
        );
      }
    }

    if (humans.length && Math.random() < 0.03) {
      run(
        "INSERT OR REPLACE INTO profile_views VALUES(?,?,?)",
        pick(bots).id,
        pick(humans).id,
        now
      );
    }
  } catch (e) {
    console.error("demo residents:", e.message);
  }
} // end of botTick
