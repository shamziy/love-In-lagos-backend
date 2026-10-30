// =====================================================================================
// LOVE IN LAGOS: BACKEND. No installs needed.
//   Run (inside this backend folder):  node server.mjs     (needs Node.js 22.13 or newer)
//   Then open http://localhost:3000    The website files are in the ../frontend folder.
//   Settings (environment variables, all optional): PORT, JWT_SECRET, DB_PATH, DEMO=false
// =====================================================================================
// Love in Lagos backend. Zero dependencies. Needs Node 22.13 or newer.
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) { console.error(`\nLove in Lagos needs Node.js 22.13 or newer. You have ${process.versions.node}.\nInstall the current version from https://nodejs.org , close and reopen your terminal, then try again.\n`); process.exit(1); }
const { DatabaseSync } = await import("node:sqlite");
if (existsSync(".env")) for (const l of readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
let { PORT = 3000, JWT_SECRET, ALLOWED_ORIGIN = "*", DB_PATH = "lagos.db", DEMO = "true" } = process.env;
// The backend runs fine ON ITS OWN (API only). If a frontend folder sits next to it, it serves the website too.
const FRONT = [process.env.FRONTEND_DIR, path.join(import.meta.dirname, "..", "frontend"), path.join(import.meta.dirname, "..", "love-in-lagos-frontend"), path.join(import.meta.dirname, "frontend")].filter(Boolean);
const PUBLIC = FRONT.find(d => existsSync(path.join(d, "index.html"))) || null;
process.on("unhandledRejection", e => console.error("error:", e && e.message)); // never crash
if (!JWT_SECRET || JWT_SECRET.length < 24) { JWT_SECRET = crypto.randomBytes(32).toString("hex"); console.warn("No JWT_SECRET set: using a temporary one (everyone is logged out when the server restarts). Set JWT_SECRET for a real launch."); }

const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,username TEXT UNIQUE NOT NULL COLLATE NOCASE,name TEXT NOT NULL,age INTEGER NOT NULL DEFAULT 0,gender TEXT NOT NULL DEFAULT '',bio TEXT DEFAULT '',area TEXT DEFAULT '',fav TEXT DEFAULT '',look TEXT DEFAULT '[]',interests TEXT DEFAULT '[]',avatar TEXT DEFAULT '{}',photo TEXT DEFAULT '',loc INTEGER NOT NULL DEFAULT -1,seen INTEGER NOT NULL DEFAULT 0,bot INTEGER NOT NULL DEFAULT 0,pw TEXT NOT NULL,game TEXT DEFAULT '{}',created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY,from_id INTEGER NOT NULL,to_id INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',pct INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,UNIQUE(from_id,to_id));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,from_id INTEGER NOT NULL,to_id INTEGER NOT NULL,text TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blocks(by_id INTEGER NOT NULL,user_id INTEGER NOT NULL,PRIMARY KEY(by_id,user_id));
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY,by_id INTEGER NOT NULL,user_id INTEGER NOT NULL,reason TEXT NOT NULL,created INTEGER NOT NULL);`);
db.exec(`CREATE TABLE IF NOT EXISTS games(id INTEGER PRIMARY KEY,a_id INTEGER NOT NULL,b_id INTEGER NOT NULL,status TEXT NOT NULL,qs TEXT NOT NULL DEFAULT '[]',i INTEGER NOT NULL DEFAULT 0,asked INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS game_answers(game_id INTEGER NOT NULL,qi INTEGER NOT NULL,user_id INTEGER NOT NULL,text TEXT NOT NULL,created INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(game_id,qi));
CREATE TABLE IF NOT EXISTS game_used(user_id INTEGER NOT NULL,q INTEGER NOT NULL,PRIMARY KEY(user_id,q));
CREATE TABLE IF NOT EXISTS profile_views(viewer_id INTEGER NOT NULL,viewed_id INTEGER NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(viewer_id,viewed_id));
CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS daily_answers(user_id INTEGER NOT NULL,day TEXT NOT NULL,q TEXT NOT NULL,answer TEXT NOT NULL,correct TEXT NOT NULL,ok INTEGER NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(user_id,day));`);
db.exec("CREATE TABLE IF NOT EXISTS resets(user_id INTEGER PRIMARY KEY,code TEXT NOT NULL,exp INTEGER NOT NULL,tries INTEGER NOT NULL DEFAULT 0)");
try { db.exec("ALTER TABLE users ADD COLUMN tv INTEGER NOT NULL DEFAULT 0"); } catch {} // session version: a password reset bumps it, which signs out every other device
for (const c of ["xp INTEGER NOT NULL DEFAULT 0", "boost_until INTEGER NOT NULL DEFAULT 0"]) try { db.exec("ALTER TABLE users ADD COLUMN " + c); } catch {}
db.exec("CREATE TABLE IF NOT EXISTS xp_events(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,day TEXT NOT NULL,amount INTEGER NOT NULL,reason TEXT NOT NULL,created INTEGER NOT NULL)");
const QCOUNT = 500; // must equal the number of questions in js/questions.js
const one = (s, ...a) => db.prepare(s).get(...a), all = (s, ...a) => db.prepare(s).all(...a), run = (s, ...a) => db.prepare(s).run(...a);

// Passwords: scrypt hash. Sessions: signed token valid for 30 days.
const hash = pw => { const s = crypto.randomBytes(16); return s.toString("hex") + ":" + crypto.scryptSync(pw, s, 64).toString("hex"); };
const check = (pw, h) => { const [s, k] = h.split(":"); return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(s, "hex"), 64), Buffer.from(k, "hex")); };
const mac = p => crypto.createHmac("sha256", JWT_SECRET).update(p).digest("base64url");
const sign = (uid, tv = 0) => { const p = Buffer.from(JSON.stringify({ uid, tv, exp: Date.now() + 30 * 864e5 })).toString("base64url"); return p + "." + mac(p); };
const verify = t => { try { const [p, s] = t.split("."), ok = mac(p); if (s.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(ok))) return null; const d = JSON.parse(Buffer.from(p, "base64url")); return d.exp > Date.now() ? d : null; } catch { return null; } };

const J = (t, d) => { try { return JSON.parse(t); } catch { return d; } };
const UN = /^[a-z0-9_.]{3,20}$/;
const cleanAv = a => { const o = {}; for (const k of ["sk", "hc", "sh", "bg"]) if (/^#[0-9a-f]{6}$/i.test(a?.[k])) o[k] = a[k]; for (const [k, mx] of [["hs", 4], ["ac", 3], ["mo", 2]]) if (Number.isInteger(a?.[k]) && a[k] >= 0 && a[k] <= mx) o[k] = a[k]; return o; };
const pub = u => ({ id: u.id, username: u.username, name: u.name, bio: u.bio, look: J(u.look, []), fav: u.fav, area: u.area, interests: J(u.interests, []), avatar: J(u.avatar, {}), online: u.seen > Date.now() - 90000, loc: u.loc });
// "Your day on the app" log + the Daily question (days are Lagos days, UTC+1)
const logA = (uid, kind, text) => run("INSERT INTO activity(user_id,kind,text,created) VALUES(?,?,?,?)", uid, kind, String(text).slice(0, 120), Date.now());
const lagosDay = (off = 0) => new Date(Date.now() + 3600000 - off * 864e5).toISOString().slice(0, 10);
// XP: every reward goes through award(). cap = most XP of that kind per Lagos day (0 = no cap)
const award = (uid, n, why, cap = 0) => { if (cap) n = Math.min(n, cap - one("SELECT COALESCE(SUM(amount),0) s FROM xp_events WHERE user_id=? AND day=? AND reason=?", uid, lagosDay(), why).s); if (n <= 0) return 0; run("INSERT INTO xp_events(user_id,day,amount,reason,created) VALUES(?,?,?,?,?)", uid, lagosDay(), n, why, Date.now()); run("UPDATE users SET xp=xp+? WHERE id=?", n, uid); return n; };
const DAILY = [ // by Lagos weekday, 0 = Sunday: [title, question, options, index of the correct option] (same as the app's data.js)
  ["Freedom Park Sunday", "How many players are on a 5-a-side team?", ["7", "5", "11"], 1],
  ["Rainy Monday", "Which yellow bus is the icon of Lagos roads?", ["Danfo", "Gondola", "Tuk-tuk"], 0],
  ["Tech Tuesday", "Which Lagos area is nicknamed Yabacon Valley?", ["Ikoyi", "Surulere", "Yaba"], 2],
  ["Waka Wednesday", "Which snack pairs with roasted corn?", ["Pear (ube)", "Chocolate", "Popcorn"], 0],
  ["Throwback Thursday", "Which famous market is on Lagos Island?", ["Wuse", "Balogun", "Onitsha"], 1],
  ["Detty Friday", "Which dance craze is a Lagos favourite?", ["Polka", "Shoki", "Tango"], 1],
  ["Beach Saturday", "Which beach is a Lekki favourite?", ["Waikiki", "Bondi", "Elegushi"], 2]];
const PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const texts = (a, b) => one("SELECT COUNT(*) n FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)", a, b, b, a).n;
// "Talking stage" = 90%+ match, OR 10+ messages a day on 3 days in a row (days counted in Lagos time, UTC+1)
const streak3 = (a, b) => {
  const days = all("SELECT date((created/1000)+3600,'unixepoch') d FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) GROUP BY d HAVING COUNT(*)>=10 ORDER BY d", a, b, b, a).map(x => Date.parse(x.d));
  let r = 1;
  for (let i = 1; i < days.length; i++) { r = days[i] - days[i - 1] === 864e5 ? r + 1 : 1; if (r >= 3) return true; }
  return false;
};
// Match % = 12 + steady luck per pair (0-40) + similarity bonus (up to 60: interests 32, shared words in "about" 20, same area 5, same favourite spot 3). Similar people match more often, but people with empty profiles still get a fair chance.
const STOP = new Set("this that with have from your about just like love lagos and the for are but you not who what when where been into than then them they their there here very much more some also".split(" "));
const wordsOf = t => new Set((String(t || "").toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOP.has(w)));
const compat = (a, b) => {
  const ia = J(a.interests, []), ib = J(b.interests, []), la = J(a.look, []), lb = J(b.look, []), wb = wordsOf(b.bio);
  const si = ia.filter(x => ib.includes(x)), sl = la.filter(x => lb.includes(x)), sw = [...wordsOf(a.bio)].filter(w => wb.has(w));
  const ra = (n, x, y) => n / Math.max(1, Math.min(x, y)), sa = !!a.area && a.area === b.area, sf = !!a.fav && a.fav === b.fav;
  const jit = crypto.createHash("sha256").update([a.id, b.id].sort((x, y) => x - y).join("|")).digest()[0] % 41; // steady luck for each pair, same for both people
  const sim = 32 * ra(si.length, ia.length, ib.length) + 20 * Math.min(1, sw.length / 3) + (sa ? 5 : 0) + (sf ? 3 : 0);
  const pct = Math.round(Math.min(100, 12 + jit + sim));
  return { pct, why: [...si, ...sw.slice(0, 2), ...(sa ? ["both in " + a.area] : [])].slice(0, 5) };
};
const full = u => ({ ...pub(u), xp: u.xp, boost: u.boost_until, email: u.email, photo: u.photo || "", fav: u.fav, look: J(u.look, []), game: J(u.game, {}) });
const blocked = (a, b) => !!one("SELECT 1 x FROM blocks WHERE (by_id=? AND user_id=?) OR (by_id=? AND user_id=?)", a, b, b, a);
const friends = (a, b) => !!one("SELECT 1 x FROM requests WHERE status='accepted' AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?))", a, b, b, a);

// Simple in-memory rate limiter (per IP)
const hits = new Map();
const limit = (ip, k, max) => { const key = ip + k, n = Date.now(), h = hits.get(key); if (!h || h[1] < n) { hits.set(key, [1, n + 6e4]); return true; } return ++h[0] <= max; };
setInterval(() => hits.clear(), 5 * 6e4).unref();

// Optional real emails for password resets: set RESEND_API_KEY (resend.com) and MAIL_FROM. No package needed.
async function sendMail(to, subject, text) {
  const key = process.env.RESEND_API_KEY; if (!key) return false;
  try { const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ from: process.env.MAIL_FROM || "Love in Lagos <onboarding@resend.dev>", to: [to], subject, text }) }); return r.ok; } catch { return false; }
}
function route(m, p, url, b, send, ip, req) {
  if (p === "/health" || p === "/api/health") return send(200, { ok: true });

  if (p === "/api/username" && m === "GET") { // live check while typing: /api/username?u=tola
    const u = String(url.searchParams.get("u") || "").toLowerCase();
    return send(200, { available: UN.test(u) && !one("SELECT 1 x FROM users WHERE username=?", u) });
  }
  if (p === "/api/signup" && m === "POST") {
    if (!limit(ip, "auth", 30)) return send(429, { error: "Too many attempts. Try again in a minute." });
    const username = String(b.username || "").trim().toLowerCase(), name = username, email = String(b.email || "").trim().toLowerCase(), bio = String(b.bio || "").slice(0, 160), pw = String(b.password || "");
    if (!UN.test(username)) return send(400, { error: "Username: 3-20 letters, numbers, _ or ." });
    if (!/^\S+@\S+\.\S+$/.test(email)) return send(400, { error: "Enter a valid email" });
    if (pw.length < 8) return send(400, { error: "Password must be at least 8 characters" });
    if (one("SELECT 1 x FROM users WHERE email=?", email)) return send(409, { error: "That email already has an account" });
    if (one("SELECT 1 x FROM users WHERE username=?", username)) return send(409, { error: "That username is already taken" });
    const photo = PHOTO.test(b.photo || "") && b.photo.length <= 150000 ? b.photo : ""; // optional, stays private until 100 messages
    let r; try { r = run("INSERT INTO users(email,username,name,age,gender,bio,avatar,photo,pw,created) VALUES(?,?,?,0,'',?,?,?,?,?)", email, username, name, bio, JSON.stringify(cleanAv(b.avatar)), photo, hash(pw), Date.now()); } catch { return send(409, { error: "That username or email is already taken" }); }
    const u = one("SELECT * FROM users WHERE id=?", r.lastInsertRowid);
    return send(201, { token: sign(u.id, u.tv), user: full(u) });
  }
  if (p === "/api/login" && m === "POST") {
    if (!limit(ip, "auth", 30)) return send(429, { error: "Too many attempts. Try again in a minute." });
    const idf = String(b.identifier || b.email || "").trim().toLowerCase(), u = one("SELECT * FROM users WHERE email=? OR username=?", idf, idf); // log in with email OR username
    if (!u || !check(String(b.password || ""), u.pw)) return send(401, { error: "Incorrect email/username or password" });
    return send(200, { token: sign(u.id, u.tv), user: full(u) });
  }

  if (p === "/api/forgot" && m === "POST") { // forgot password, step 1: a 6-digit code (valid 15 min). The answer is always the same, so nobody can test which accounts exist
    if (!limit(ip, "fg", 8)) return send(429, { error: "Too many attempts. Try again in a minute." });
    const id = String(b.identifier || "").trim().toLowerCase(), x = id && one("SELECT * FROM users WHERE bot=0 AND (email=? OR username=?)", id, id), out = { ok: true, message: "If that account exists, a 6-digit code was sent to its email. It works for 15 minutes." };
    if (!x) return send(200, out);
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
    run("INSERT OR REPLACE INTO resets(user_id,code,exp,tries) VALUES(?,?,?,0)", x.id, mac("rs" + x.id + ":" + code), Date.now() + 15 * 6e4);
    sendMail(x.email, "Your Love in Lagos reset code", `Your code is ${code}. It works for 15 minutes. If you did not ask for it, ignore this email.`).then(sent => {
      if (!sent) console.log(`[password reset] no email service set. Code for @${x.username}: ${code}`);
      send(200, !sent && DEMO !== "false" ? { ...out, devCode: code } : out); // devCode is only shown while DEMO is on and no email service is set
    }).catch(() => send(500, { error: "Server error" }));
    return;
  }
  if (p === "/api/reset" && m === "POST") { // step 2: code + new password
    if (!limit(ip, "rs", 10)) return send(429, { error: "Too many attempts. Try again in a minute." });
    const id = String(b.identifier || "").trim().toLowerCase(), x = id && one("SELECT * FROM users WHERE bot=0 AND (email=? OR username=?)", id, id), rr = x && one("SELECT * FROM resets WHERE user_id=?", x.id), pw = String(b.password || "");
    if (pw.length < 8) return send(400, { error: "Password must be at least 8 characters" });
    const bad = { error: "That code is wrong or expired. Ask for a new one." };
    if (!rr || rr.exp < Date.now() || rr.tries >= 5) return send(400, bad);
    const want = Buffer.from(rr.code), got = Buffer.from(mac("rs" + x.id + ":" + String(b.code || "").trim()));
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) { run("UPDATE resets SET tries=tries+1 WHERE user_id=?", x.id); return send(400, bad); }
    run("UPDATE users SET pw=?,tv=tv+1 WHERE id=?", hash(pw), x.id); run("DELETE FROM resets WHERE user_id=?", x.id); // tv+1 signs out all other devices
    const nu = one("SELECT * FROM users WHERE id=?", x.id);
    return send(200, { ok: true, token: sign(nu.id, nu.tv), user: full(nu) }); // the device that reset stays signed in
  }

  // Everything below needs a logged-in user
  const tk = verify((req.headers.authorization || "").replace("Bearer ", "")), uid = tk && tk.uid;
  const u = uid && one("SELECT * FROM users WHERE id=?", uid);
  if (!u || (tk.tv || 0) !== u.tv) return send(401, { error: "Please log in" });

  if (p === "/api/me" && m === "GET") return send(200, full(u));
  if (p === "/api/me" && m === "PUT") { // profile, bitmoji and game progress
    let un = u.username;
    if (b.username !== undefined) {
      un = String(b.username).trim().toLowerCase();
      if (!UN.test(un)) return send(400, { error: "Username: 3-20 letters, numbers, _ or ." });
      if (one("SELECT 1 x FROM users WHERE username=? AND id!=?", un, uid)) return send(409, { error: "That username is already taken" });
    }
    if (b.photo && !(PHOTO.test(b.photo) && b.photo.length <= 150000)) return send(400, { error: "Photo must be a small JPEG, PNG or WebP" });
    const game = JSON.stringify(b.game ?? J(u.game, {}));
    if (game.length > 20000) return send(413, { error: "Game data too large" });
    const list = (v, old, n) => (Array.isArray(v) ? v : J(old, [])).map(x => String(x).slice(0, 20)).slice(0, n);
    run("UPDATE users SET username=?,bio=?,area=?,fav=?,look=?,interests=?,avatar=?,game=? WHERE id=?", un, String(b.bio ?? u.bio).slice(0, 160), String(b.area ?? u.area).slice(0, 30), String(b.fav ?? u.fav).slice(0, 30),
      JSON.stringify(list(b.look, u.look, 4)), JSON.stringify(list(b.interests, u.interests, 5)), JSON.stringify(b.avatar ? cleanAv(b.avatar) : J(u.avatar, {})), game, uid);
    run("UPDATE users SET name=? WHERE id=?", un, uid);
    if (b.photo !== undefined) run("UPDATE users SET photo=? WHERE id=?", b.photo || "", uid);
    return send(200, full(one("SELECT * FROM users WHERE id=?", uid)));
  }
  if (p === "/api/me" && m === "DELETE") { // delete account + all data (privacy)
    for (const t of ["requests", "messages"]) run(`DELETE FROM ${t} WHERE from_id=? OR to_id=?`, uid, uid);
    run("DELETE FROM blocks WHERE by_id=? OR user_id=?", uid, uid); run("DELETE FROM games WHERE a_id=? OR b_id=?", uid, uid); run("DELETE FROM game_used WHERE user_id=?", uid); run("DELETE FROM profile_views WHERE viewer_id=? OR viewed_id=?", uid, uid); run("DELETE FROM users WHERE id=?", uid);
    return send(200, { ok: true });
  }
  const xpInfo = () => ({ total: one("SELECT xp FROM users WHERE id=?", uid).xp, today: one("SELECT COALESCE(SUM(amount),0) s FROM xp_events WHERE user_id=? AND day=? AND reason!='boost'", uid, lagosDay()).s, goal: 200, boostUntil: one("SELECT boost_until b FROM users WHERE id=?", uid).b, claimed: !!one("SELECT 1 x FROM xp_events WHERE user_id=? AND day=? AND reason='boost'", uid, lagosDay()) });
  if (p === "/api/xp" && m === "GET") return send(200, xpInfo());
  if (p === "/api/xp/boost" && m === "POST") { // Lagos Charm: earn 200 XP today, then every match you send is accepted automatically for 1 hour (once a day)
    const i = xpInfo(); if (i.today < 200) return send(400, { error: "Earn 200 XP today first" }); if (i.claimed) return send(409, { error: "You already used today’s Lagos Charm" });
    run("INSERT INTO xp_events(user_id,day,amount,reason,created) VALUES(?,?,0,'boost',?)", uid, lagosDay(), Date.now()); run("UPDATE users SET boost_until=? WHERE id=?", Date.now() + 36e5, uid); logA(uid, "daily", "⚡ Lagos Charm on for 1 hour");
    return send(200, xpInfo());
  }
  if (p === "/api/activity" && m === "POST") { // things only the app knows about (activities at locations, resting). Matches, games and the daily answer log themselves
    if (!["act", "rest"].includes(b.kind)) return send(400, { error: "Bad kind" });
    if (!limit(ip, "act", 120)) return send(429, { error: "Slow down" });
    logA(uid, b.kind, b.text || ""); if (b.kind === "act") award(uid, 10, "act", 100);
    return send(200, { ok: true });
  }
  if (p === "/api/activity" && m === "GET") { // "Your day on the app": /api/activity?day=2026-10-10 (default today, Lagos time)
    const dq = url.searchParams.get("day") || "", day = /^\d{4}-\d{2}-\d{2}$/.test(dq) ? dq : lagosDay(), start = Date.parse(day + "T00:00:00Z") - 3600000;
    return send(200, all("SELECT kind,text,created FROM activity WHERE user_id=? AND created>=? AND created<? ORDER BY created", uid, start, start + 864e5));
  }
  if (p === "/api/daily" && m === "GET") { // today's question, your answer (if any), streak and last 7 answers
    const d = DAILY[new Date(Date.now() + 3600000).getUTCDay()], a = one("SELECT * FROM daily_answers WHERE user_id=? AND day=?", uid, lagosDay());
    const days = new Set(all("SELECT day FROM daily_answers WHERE user_id=?", uid).map(x => x.day));
    let streak = 0;
    for (let o = a ? 0 : 1; days.has(lagosDay(o)); o++) streak++;
    return send(200, { title: d[0], question: d[1], options: d[2], streak, answered: a ? { answer: a.answer, correct: a.correct, ok: !!a.ok } : null,
      history: all("SELECT day,q,answer,correct,ok FROM daily_answers WHERE user_id=? ORDER BY day DESC LIMIT 7", uid).map(x => ({ ...x, ok: !!x.ok })) });
  }
  if (p === "/api/daily/answer" && m === "POST") { // one answer per Lagos day: {option: 0|1|2}
    const d = DAILY[new Date(Date.now() + 3600000).getUTCDay()], opt = Math.trunc(+b.option);
    if (!(opt >= 0 && opt < d[2].length)) return send(400, { error: "Pick one of the options" });
    if (one("SELECT 1 x FROM daily_answers WHERE user_id=? AND day=?", uid, lagosDay())) return send(409, { error: "Already answered today" });
    const ok = opt === d[3]; award(uid, ok ? 30 : 10, "daily");
    run("INSERT INTO daily_answers(user_id,day,q,answer,correct,ok,created) VALUES(?,?,?,?,?,?,?)", uid, lagosDay(), d[1], d[2][opt], d[2][d[3]], ok ? 1 : 0, Date.now());
    logA(uid, "daily", "🗓️ Answered the daily question: " + d[2][opt] + (ok ? " ✅" : " ❌"));
    return send(200, { ok, correct: d[2][d[3]] });
  }
  if (p === "/api/qa" && m === "GET") { // 20 Questions answers from your games (question numbers map to js/questions.js)
    const rows = all("SELECT ga.qi,ga.text,ga.user_id,ga.created,g.qs,g.a_id,g.b_id FROM game_answers ga JOIN games g ON g.id=ga.game_id WHERE g.a_id=? OR g.b_id=? ORDER BY ga.created DESC LIMIT 30", uid, uid);
    return send(200, rows.map(x => ({ questionId: J(x.qs, [])[x.qi], answer: x.text, answeredBy: x.user_id === uid ? "you" : "them", with: one("SELECT username FROM users WHERE id=?", x.a_id === uid ? x.b_id : x.a_id)?.username, at: x.created })));
  }
  if (p === "/api/presence" && m === "POST") { // heartbeat: call every 30s and whenever the player changes location (0-8, same order as the app's tabs). loc -1 = offline
    const l = Math.trunc(+b.loc);
    if (!(l >= -1 && l <= 8)) return send(400, { error: "Bad location" });
    run("UPDATE users SET loc=?,seen=? WHERE id=?", l, Date.now(), uid);
    return send(200, { ok: true });
  }
  if (p === "/api/people" && m === "GET") { // browse or search by name/username: /api/people?q=tola
    const loc = url.searchParams.get("loc");
    if (loc !== null) // "People around you": ONLY people online (heartbeat in the last 90s) at this same location
      return send(200, all("SELECT * FROM users WHERE id!=? AND loc=? AND seen>? AND id NOT IN (SELECT user_id FROM blocks WHERE by_id=?) AND id NOT IN (SELECT by_id FROM blocks WHERE user_id=?) ORDER BY seen DESC LIMIT 50", uid, +loc, Date.now() - 90000, uid, uid).map(pub));
    const q = "%" + String(url.searchParams.get("q") || "").trim().toLowerCase().replace(/%/g, "") + "%";
    return send(200, all("SELECT * FROM users WHERE id!=? AND username LIKE ? AND id NOT IN (SELECT user_id FROM blocks WHERE by_id=?) AND id NOT IN (SELECT by_id FROM blocks WHERE user_id=?) ORDER BY id DESC LIMIT 50", uid, q, uid, uid).map(pub));
  }
  if (p === "/api/matches" && m === "POST") { // the Match button: <=20% is never sent, >=95% matches instantly
    const to = +b.to, o = one("SELECT * FROM users WHERE id=?", to), boost0 = u.boost_until > Date.now();
    if (!o || to === uid || blocked(uid, to)) return send(400, { error: "Cannot match" });
    if (!limit(ip, "req", 30)) return send(429, { error: "Slow down" });
    const ex = one("SELECT * FROM requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)", uid, to, to, uid);
    if (ex && ex.status === "pending" && ex.to_id === uid) { run("UPDATE requests SET status='accepted' WHERE id=?", ex.id); award(uid, 25, "match"); award(to, 25, "match"); return send(200, { pct: ex.pct, status: "matched" }); }
    if (ex && ex.status !== "accepted" && boost0) { run("UPDATE requests SET status='accepted' WHERE id=?", ex.id); award(uid, 25, "match"); award(to, 25, "match"); return send(200, { pct: ex.pct, status: "matched", boost: true }); }
    if (ex) return send(200, { pct: ex.pct, status: ex.status === "accepted" ? "matched" : ex.status === "declined" ? "declined" : "sent" });
    const { pct, why } = compat(u, o), boost = u.boost_until > Date.now();
    if (pct <= 20 && !boost) { logA(uid, "match", "💔 Match with @" + o.username + " didn't work out (" + pct + "%)"); return send(200, { pct, why, status: "low" }); } // nothing is stored or sent to them
    const auto = pct >= 95 || boost; if (auto) { award(uid, 25, "match"); award(to, 25, "match"); } else award(uid, 5, "sent", 25);
    run("INSERT INTO requests(from_id,to_id,status,pct,created) VALUES(?,?,?,?,?)", uid, to, auto ? "accepted" : "pending", pct, Date.now());
    logA(uid, "match", (auto ? "💘 Instantly matched with @" : "💘 Sent a match to @") + o.username + " (" + pct + "%)");
    return send(200, { pct, why, status: auto ? "matched" : "sent" });
  }
  if (p === "/api/matches" && m === "GET") // "Match requests" (incoming) and "Recent chats" (matches). talking=true after 4+ messages
    return send(200, {
      incoming: all("SELECT u.*,r.id rid,r.pct FROM requests r JOIN users u ON u.id=r.from_id WHERE r.to_id=? AND r.status='pending' ORDER BY r.created DESC", uid).map(x => ({ requestId: x.rid, pct: x.pct, user: pub(x) })),
      matches: all("SELECT u.*,r.pct FROM requests r JOIN users u ON u.id=(CASE WHEN r.from_id=? THEN r.to_id ELSE r.from_id END) WHERE r.status='accepted' AND (r.from_id=? OR r.to_id=?)", uid, uid, uid)
        .map(x => ({ pct: x.pct, user: pub(x), talking: x.pct >= 90 || streak3(uid, x.id), photoUnlocked: texts(uid, x.id) >= 100, count: texts(uid, x.id), last: one("SELECT from_id,text,created FROM messages WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?) ORDER BY id DESC LIMIT 1", uid, x.id, x.id, uid) || null })),
      sent: all("SELECT u.*,r.pct FROM requests r JOIN users u ON u.id=r.to_id WHERE r.from_id=? AND r.status='pending'", uid).map(x => ({ pct: x.pct, user: pub(x) })),
    });
  let mm = p.match(/^\/api\/matches\/(\d+)\/respond$/);
  if (mm && m === "POST") {
    const r = one("SELECT * FROM requests WHERE id=? AND to_id=? AND status='pending'", +mm[1], uid);
    if (!r) return send(404, { error: "Match request not found" });
    run("UPDATE requests SET status=? WHERE id=?", b.accept ? "accepted" : "declined", r.id);
    if (b.accept) { award(uid, 25, "match"); award(r.from_id, 25, "match"); logA(uid, "match", "🎉 You accepted a match"); logA(r.from_id, "match", "🎉 Someone accepted your match"); }
    return send(200, { ok: true });
  }
  mm = p.match(/^\/api\/messages\/(\d+)$/); // chat: poll this every few seconds with ?after=<last id>
  if (mm) {
    const other = +mm[1];
    if (!friends(uid, other) || blocked(uid, other)) return send(403, { error: "You can only chat with friends" });
    if (m === "GET") return send(200, all("SELECT id,from_id,text,created FROM messages WHERE id>? AND ((from_id=? AND to_id=?) OR (from_id=? AND to_id=?)) ORDER BY id LIMIT 100", +url.searchParams.get("after") || 0, uid, other, other, uid));
    if (m === "POST") {
      const text = String(b.text || "").trim().slice(0, 500);
      if (!text) return send(400, { error: "Empty message" });
      if (!limit(ip, "msg", 120)) return send(429, { error: "Slow down" });
      run("INSERT INTO messages(from_id,to_id,text,created) VALUES(?,?,?,?)", uid, other, text, Date.now()); award(uid, 2, "msg", 40);
      return send(201, { ok: true });
    }
  }
  // 20 Questions: invite -> friend says yes/no -> players TAKE TURNS asking. Inviter asks #1, other asks #2, and so on.
  if (p === "/api/games/invite" && m === "POST") {
    const o = +b.userId;
    if (!friends(uid, o) || blocked(uid, o)) return send(403, { error: "You can only play with your matches" });
    if (one("SELECT 1 x FROM games WHERE status IN ('invited','playing') AND ((a_id=? AND b_id=?) OR (a_id=? AND b_id=?))", uid, o, o, uid)) return send(409, { error: "A game is already open" });
    const r = run("INSERT INTO games(a_id,b_id,status,created) VALUES(?,?,'invited',?)", uid, o, Date.now());
    return send(201, { id: Number(r.lastInsertRowid) });
  }
  mm = p.match(/^\/api\/games\/(\d+)\/(respond|ask|answer)$/);
  if (mm && m === "POST") {
    const g = one("SELECT * FROM games WHERE id=? AND (a_id=? OR b_id=?)", +mm[1], uid, uid);
    if (!g) return send(404, { error: "Game not found" });
    if (mm[2] === "respond") { // only the invited player decides
      if (g.b_id !== uid || g.status !== "invited") return send(403, { error: "Only the invited player can answer" });
      if (!b.accept) { run("UPDATE games SET status='declined' WHERE id=?", g.id); return send(200, { ok: true }); }
      startGame(g);
      return send(200, { ok: true });
    }
    if (g.status !== "playing") return send(400, { error: "Game is not running" });
    const asker = g.i % 2 === 0 ? g.a_id : g.b_id;
    if (mm[2] === "ask") {
      if (uid !== asker || g.asked) return send(403, { error: "Not your turn to ask" });
      run("UPDATE games SET asked=1 WHERE id=?", g.id);
      return send(200, { ok: true });
    }
    if (uid === asker || !g.asked) return send(403, { error: "Not your turn to answer" });
    const text = String(b.text || "").trim().slice(0, 300);
    if (!text) return send(400, { error: "Write an answer" });
    run("INSERT INTO game_answers(game_id,qi,user_id,text,created) VALUES(?,?,?,?,?)", g.id, g.i, uid, text, Date.now());
    if (g.i + 1 >= 20) { run("UPDATE games SET status='done',i=20,asked=0 WHERE id=?", g.id); logA(g.a_id, "game", "🎲 Finished 20 Questions"); award(g.a_id, 40, "game"); award(g.b_id, 40, "game"); logA(g.b_id, "game", "🎲 Finished 20 Questions"); }
    else run("UPDATE games SET i=i+1,asked=0 WHERE id=?", g.id);
    return send(200, { ok: true });
  }
  mm = p.match(/^\/api\/games\/with\/(\d+)$/);
  if (mm && m === "GET") { // poll every 3s while a game is open. Frontend maps question ids to js/questions.js
    const o = +mm[1], g = one("SELECT * FROM games WHERE (a_id=? AND b_id=?) OR (a_id=? AND b_id=?) ORDER BY id DESC LIMIT 1", uid, o, o, uid);
    if (!g) return send(200, null);
    const qs = J(g.qs, []), ans = all("SELECT qi,user_id,text FROM game_answers WHERE game_id=?", g.id), asker = g.i % 2 === 0 ? g.a_id : g.b_id;
    return send(200, {
      id: g.id, status: g.status, inviter: g.a_id, i: g.i,
      history: qs.slice(0, g.i).map((q, k) => ({ q, asker: k % 2 === 0 ? g.a_id : g.b_id, answer: (ans.find(x => x.qi === k) || {}).text })),
      cur: g.status === "playing" ? { q: uid === asker || g.asked ? qs[g.i] : null, asker, yourTurnToAsk: uid === asker && !g.asked, yourTurnToAnswer: uid !== asker && !!g.asked } : null,
    });
  }
  if (p === "/api/profile-views" && m === "POST") { // frontend calls this whenever someone taps another user's profile
    const to = +b.userId;
    if (!to || to === uid || !one("SELECT 1 x FROM users WHERE id=?", to) || blocked(uid, to)) return send(200, { ok: true });
    run("INSERT OR REPLACE INTO profile_views VALUES(?,?,?)", uid, to, Date.now());
    return send(200, { ok: true });
  }
  if (p === "/api/visitors" && m === "GET") // My Corner: ONLY people who tapped your profile
    return send(200, all("SELECT u.*,v.created seen FROM profile_views v JOIN users u ON u.id=v.viewer_id WHERE v.viewed_id=? AND u.id NOT IN (SELECT user_id FROM blocks WHERE by_id=?) ORDER BY v.created DESC LIMIT 50", uid, uid).map(x => ({ user: pub(x), at: x.seen })));
  mm = p.match(/^\/api\/photo\/(\d+)$/);
  if (mm && m === "GET") { // someone else's photo: only after 100 messages between you two
    const o = +mm[1];
    if (!friends(uid, o) || blocked(uid, o) || texts(uid, o) < 100) return send(403, { error: "Photos unlock after 100 messages" });
    return send(200, { photo: one("SELECT photo FROM users WHERE id=?", o)?.photo || "" });
  }
  if (p === "/api/block" && m === "POST") { run("INSERT OR IGNORE INTO blocks VALUES(?,?)", uid, +b.userId); return send(200, { ok: true }); }
  if (p === "/api/report" && m === "POST") { run("INSERT INTO reports(by_id,user_id,reason,created) VALUES(?,?,?,?)", uid, +b.userId, String(b.reason || "").slice(0, 300), Date.now()); return send(200, { ok: true }); }
  return send(404, { error: "Not found" });
}

http.createServer(async (req, res) => {
  const cors = { "Access-Control-Allow-Origin": ALLOWED_ORIGIN, "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS" };
  const send = (c, o) => { res.writeHead(c, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress, url = new URL(req.url, "http://x");
  if (!url.pathname.startsWith("/api") && url.pathname !== "/health") return serveStatic(req, res, url.pathname);
  if (!limit(ip, "all", 600)) return send(429, { error: "Too many requests" });
  let body = {};
  if (["POST", "PUT"].includes(req.method)) {
    let raw = "";
    for await (const c of req) { raw += c; if (raw.length > 1e5) return send(413, { error: "Too large" }); }
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: "Bad JSON" }); }
  }
  try { route(req.method, url.pathname, url, body, send, ip, req); } catch (e) { console.error(e); send(500, { error: "Server error" }); }
}).listen(PORT, () => { console.log("Love in Lagos is running: http://localhost:" + PORT + (PUBLIC ? "  (website from " + PUBLIC + ")" : "  (API only: no frontend folder found)")); if (DEMO !== "false") startDemo(); }).on("error", e => {
  console.error(e.code === "EADDRINUSE" ? `\nPort ${PORT} is already in use by another program.\nUse another port:  PORT=3001 node server.mjs   (Windows PowerShell: $env:PORT=3001; node server.mjs)\n` : e.message); process.exit(1);
});

// ---------- Helpers added for the full-stack repo ----------
function startGame(g) { // draw 20 questions neither player has seen before, then open the game
  let used = new Set(all("SELECT q FROM game_used WHERE user_id IN (?,?)", g.a_id, g.b_id).map(x => x.q));
  if (QCOUNT - used.size < 20) { run("DELETE FROM game_used WHERE user_id IN (?,?)", g.a_id, g.b_id); used = new Set(); }
  const pool = [...Array(QCOUNT).keys()].filter(i => !used.has(i));
  for (let i = pool.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const qs = pool.slice(0, 20);
  for (const q of qs) for (const x of [g.a_id, g.b_id]) run("INSERT OR IGNORE INTO game_used VALUES(?,?)", x, q);
  run("UPDATE games SET status='playing',qs=?,i=0,asked=0 WHERE id=?", JSON.stringify(qs), g.id);
  logA(g.a_id, "game", "🎲 Started 20 Questions"); logA(g.b_id, "game", "🎲 Started 20 Questions");
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json" };
function serveStatic(req, res, pathname) { // serves the website (frontend folder) at the same address as the API
  if (!PUBLIC) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end("<h1>Love in Lagos backend is running ✅</h1><p>No frontend folder was found next to this backend, so only the API is available (<a href='/health'>/health</a> and /api/...).</p><p>Open the frontend folder's index.html in your browser: it will find this backend by itself.</p>"); }
  try {
    let file = path.join(PUBLIC, decodeURIComponent(pathname));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    if (!existsSync(file) || !statSync(file).isFile()) file = path.join(PUBLIC, "index.html");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end("Not found"); }
}

// ---------- Demo residents: 16 pretend people so a solo test run feels alive. DEMO=false turns this off ----------
const BOTS = [ // username, age, gender, area, bio, interests, shirt colour, background colour
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
  ["kunle", 28, "Man", "Gbagada", "Studio rat who finally came outside. Let's find a good rooftop.", ["music", "coffee", "games"], "#4a5fb0", "#d7dcf3"]];
const BOT_REPLIES = ["Haha you made me smile 😄", "Omo, tell me more!", "Lagos traffic nearly stopped me from replying 🚌", "Abeg, what's your favourite food?", "I like how you talk 💚", "Let's meet for coffee this weekend ☕", "Wahala! You're funny o"];
const BOT_ANSWERS = ["Hmm, honestly it depends on the day 😄", "Easy! Yes, and I'm not sorry 😂", "That's a tricky one. Ask me again after jollof 🍛", "I'd say yes, but only if you buy the suya 🍢", "Ha! You're bold. I like it 😏", "Mine is probably the same as yours, honestly 💛", "Can I answer that over coffee? ☕"];
const pick = a => a[Math.floor(Math.random() * a.length)];
const hnum = s => crypto.createHash("sha256").update(String(s)).digest()[0];
const isBot = id => !!one("SELECT 1 x FROM users WHERE id=? AND bot=1", id);
function botAnswer(g, uid) { // a resident answers the question they were asked
  run("INSERT INTO game_answers(game_id,qi,user_id,text,created) VALUES(?,?,?,?,?)", g.id, g.i, uid, pick(BOT_ANSWERS), Date.now());
  if (g.i + 1 >= 20) { run("UPDATE games SET status='done',i=20,asked=0 WHERE id=?", g.id); logA(g.a_id, "game", "🎲 Finished 20 Questions"); award(g.a_id, 40, "game"); award(g.b_id, 40, "game"); logA(g.b_id, "game", "🎲 Finished 20 Questions"); }
  else run("UPDATE games SET i=i+1,asked=0 WHERE id=?", g.id);
}
function startDemo() {
  if (!one("SELECT 1 x FROM users WHERE bot=1"))
    BOTS.forEach((b, i) => run("INSERT INTO users(email,username,name,age,gender,bio,area,interests,avatar,pw,bot,loc,seen,created) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?,?)",
      b[0] + "@demo.local", b[0], b[0], b[1], b[2], b[4], b[3], JSON.stringify(b[5]),
      JSON.stringify({ sk: ["#a8714f", "#8d5a3b", "#c08a62", "#7a4a30"][i % 4], sh: b[6], bg: b[7], hs: b[2] === "Woman" ? (i % 2 ? 1 : 3) : [0, 2, 4][i % 3] }), hash(crypto.randomBytes(16).toString("hex")), i % 9, Date.now(), Date.now()));
  setInterval(botTick, 1500).unref();
}
function botTick() {
  try {
    const now = Date.now(), bots = all("SELECT * FROM users WHERE bot=1");
    run("UPDATE users SET seen=? WHERE bot=1", now);                                                        // residents stay online
    if (Math.random() < 0.08) run("UPDATE users SET loc=? WHERE id=?", Math.floor(Math.random() * 9), pick(bots).id); // and wander between places
    for (const r of all("SELECT r.* FROM requests r JOIN users u ON u.id=r.to_id WHERE r.status='pending' AND u.bot=1 AND r.created<?", now - 3500)) // decide on match requests
      { const ok = hnum(r.id) % 100 < (r.pct >= 50 ? 85 : 55); run("UPDATE requests SET status=? WHERE id=?", ok ? "accepted" : "declined", r.id); if (ok) { award(r.from_id, 25, "match"); award(r.to_id, 25, "match"); } }
    for (const m of all("SELECT m.from_id,m.to_id,MAX(m.id) mid,MAX(m.created) c FROM messages m JOIN users u ON u.id=m.to_id WHERE u.bot=1 GROUP BY m.from_id,m.to_id")) // reply to chat
      if (m.c < now - 1500 && !one("SELECT 1 x FROM messages WHERE from_id=? AND to_id=? AND id>?", m.to_id, m.from_id, m.mid))
        run("INSERT INTO messages(from_id,to_id,text,created) VALUES(?,?,?,?)", m.to_id, m.from_id, pick(BOT_REPLIES), now);
    for (const g of all("SELECT g.* FROM games g JOIN users u ON u.id=g.b_id WHERE g.status='invited' AND u.bot=1 AND g.created<?", now - 2500)) // 20 Questions invites
      if (hnum(g.id) % 100 < 75) startGame(g); else run("UPDATE games SET status='declined' WHERE id=?", g.id);
    for (const g of all("SELECT * FROM games WHERE status='playing'")) {                                    // take turns with humans
      const asker = g.i % 2 === 0 ? g.a_id : g.b_id, answerer = asker === g.a_id ? g.b_id : g.a_id;
      if (Math.random() < 0.5) { if (isBot(asker) && !g.asked) run("UPDATE games SET asked=1 WHERE id=?", g.id); else if (isBot(answerer) && g.asked) botAnswer(g, answerer); }
    }
    const humans = all("SELECT * FROM users WHERE bot=0 AND seen>?", now - 90000);                          // residents reach out and peek at profiles
    if (humans.length && Math.random() < 0.02) {
      const h = pick(humans), b = pick(bots), pct = compat(b, h).pct;
      if (pct > 20 && !one("SELECT 1 x FROM requests WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)", b.id, h.id, h.id, b.id) && !blocked(b.id, h.id))
        run("INSERT INTO requests(from_id,to_id,status,pct,created) VALUES(?,?,'pending',?,?)", b.id, h.id, pct, now);
    }
    if (humans.length && Math.random() < 0.03) run("INSERT OR REPLACE INTO profile_views VALUES(?,?,?)", pick(bots).id, pick(humans).id, now);
  } catch (e) { console.error("demo residents:", e.message); }
}
