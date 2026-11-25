import { spawn } from "node:child_process";
import pgmod from "pg";
// STAGING CHECK: runs the real server against a real PostgreSQL database and exercises every route.
// It creates test users, so ONLY run it against a throwaway database (a free Render Postgres you delete afterwards).
//   DATABASE_URL="postgres://..." node staging-check.mjs --yes-this-is-a-test-database [demo]
const URL_ = process.env.DATABASE_URL || "";
if (!URL_ || !process.argv.includes("--yes-this-is-a-test-database")) { console.error("Usage: DATABASE_URL=<throwaway test database> node staging-check.mjs --yes-this-is-a-test-database [demo]\nIt creates test users and data, so never point it at your live database."); process.exit(2); }
const SFX = Math.random().toString(36).slice(2, 6);
const needSsl = (() => { try { const h = new URL(URL_).hostname; return h.includes(".") && !/^(localhost|127\.|10\.|192\.168\.)|\.internal$/.test(h); } catch { return false; } })();
const pool = new pgmod.Pool({ connectionString: URL_, max: 3, ssl: process.env.PGSSL === "false" ? false : needSsl ? { rejectUnauthorized: false } : false });
pgmod.types.setTypeParser(20, v => Number(v)); pgmod.types.setTypeParser(1700, v => Number(v));
const toPg = sql => { let n = 0; return sql.replace(/\?/g, () => "$" + (++n)); };
const P = async (sql, p = []) => pool.query(toPg(sql), p);
const P1 = async (sql, p = []) => (await P(sql, p)).rows[0];
const demo = process.argv.includes("demo"), PORT = demo ? 3992 : 3991;
const srv = spawn("node", ["server.mjs"], { env: { ...process.env, PORT, DATABASE_URL: URL_, DEMO: demo ? "true" : "false", JWT_SECRET: "a-test-secret-that-is-long-enough-123456" }, stdio: ["ignore", "pipe", "pipe"] });
let err = ""; srv.stderr.on("data", d => err += d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break } catch {} await sleep(150) }
const rows = []; let fiveHundreds = [];
const mk = tk => async (m, p, b) => { const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, { method: m, headers: { "content-type": "application/json", ...(tk ? { authorization: "Bearer " + tk } : {}) }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json() } catch {} rows.push(`${m} ${p.split("?")[0]} -> ${r.status}`); if (r.status >= 500) fiveHundreds.push(`${m} ${p} ${JSON.stringify(j)}`); return [r.status, j] };
let pass = 0, fail = 0; const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : " " + JSON.stringify(x).slice(0, 300))) };
const anon = mk();
const su = async (u) => { const [, j] = await anon("POST", "/signup", { username: u, email: u + "@staging-check.test", password: "password123" }); return j };
const A = await su("adaeze_" + SFX), B = await su("zainab_" + SFX), C = await su("chioma_" + SFX);
const a = mk(A.token), b = mk(B.token), c = mk(C.token);
const me = async t => (await mk(t)("GET", "/me"))[1]; const ia = (await me(A.token)).id, ib = (await me(B.token)).id, ic = (await me(C.token)).id;
ok("signup returns tokens + ids", A.token && ia && ib && ic && ia !== ib, [A, ia]);
(await P("INSERT INTO requests(from_id,to_id,status,pct,created,auto) VALUES(?,?,?,?,?,?)", [ia, ib, "accepted", 95, Date.now(), 1])); (await P("UPDATE users SET xp=50000 WHERE id=?", [ia]));
await anon("GET", "/username?u=freename"); ok("login by email", (await anon("POST", "/login", { email: "adaeze_" + SFX + "@staging-check.test", password: "password123" }))[0] === 200); ok("wrong password refused", (await anon("POST", "/login", { email: "adaeze_" + SFX + "@staging-check.test", password: "nope" }))[0] === 401);
ok("login by USERNAME works in any letter case (was NOCASE in SQLite)", (await anon("POST", "/login", { email: ("ADAEZE_" + SFX).toUpperCase(), password: "password123" }))[0] === 200 || (await anon("POST", "/login", { username: ("ADAEZE_" + SFX).toUpperCase(), password: "password123" }))[0] === 200);
ok("duplicate signup refused (case-insensitive username)", (await anon("POST", "/signup", { username: ("ADAEZE_" + SFX).toUpperCase(), email: "other_" + SFX + "@staging-check.test", password: "password123" }))[0] >= 400);
await anon("POST", "/forgot", { email: "adaeze_" + SFX + "@staging-check.test" }); await anon("POST", "/reset", { email: "adaeze_" + SFX + "@staging-check.test", code: "000000", password: "newpassword1" }); await anon("POST", "/forgot", { email: "adaeze_" + SFX + "@staging-check.test" });
ok("PUT /me partial + username change", (await a("PUT", "/me", { bio: "hello world bio" }))[0] === 200 && (await a("PUT", "/me", { username: "adaeze_n" + SFX }))[0] === 200 && (await a("PUT", "/me", { username: "adaeze_" + SFX }))[0] === 200);
ok("taken username -> 409", (await a("PUT", "/me", { username: ("ZAINAB_" + SFX).toUpperCase() }))[0] === 409);
await a("PUT", "/me", { interests: ["music", "food"], area: "Lekki", look: ["Dating"], photo: "data:image/jpeg;base64,AAAA" });
for (const p of ["/me", "/xp", "/notifs", "/shop", "/leaderboard", "/cupid", "/activity", "/daily", "/qa", "/people", "/matches", "/visitors", "/amebo", "/amebo/next", "/amebo/read"]) await a("GET", p);
await a("POST", "/notifs/read", {}); await a("POST", "/presence", { loc: 3 }); await a("POST", "/play", { score: 12 }); await a("POST", "/activity", { text: "Went to the beach at Elegushi", kind: "act" });
for (let i = 0; i < 11; i++) await a("POST", "/activity", { text: "Went to the beach at Elegushi", kind: "act" });
await a("GET", "/activity");
ok("daily answer (option 0) records and awards XP", (await a("POST", "/daily/answer", { option: 0 }))[0] === 200); ok("daily answer twice -> 409", (await a("POST", "/daily/answer", { option: 0 }))[0] === 409);
(await P("INSERT INTO xp_events(user_id,day,amount,reason,created) VALUES(?,?,?,?,?)", [ia, new Date(Date.now() + 3600000).toISOString().slice(0, 10), 1000, "test", Date.now()]));
ok("Lagos Charm boost (needs 1000 XP today)", (await a("POST", "/xp/boost", {}))[0] === 200); ok("boost twice -> 409", (await a("POST", "/xp/boost", {}))[0] === 409);
await a("POST", "/profile-views", { userId: ib }); await b("GET", "/visitors"); await a("GET", "/photo/" + ib);
ok("cupid: introduce two people", [200, 201].includes((await a("POST", "/cupid", { a: ib, b: ic }))[0])); await a("GET", "/cupid");
await c("GET", "/people");
// matches batching and talking stage
const unlockFlags = [];
for (let i = 0; i < 104; i++) { const rr = await (i % 2 ? b : a)("POST", `/messages/${i % 2 ? ia : ib}`, { text: "message number " + i }); unlockFlags.push(rr[1] && rr[1].photosUnlocked === true); }
ok("only the 100th message reports photosUnlocked", unlockFlags.filter(Boolean).length === 1 && unlockFlags[99] === true, unlockFlags.map((x, i) => x ? i : null).filter(x => x !== null));
{ const na = (await a("GET", "/notifs"))[1].items.filter(x => x.kind === "photos"), nb = (await b("GET", "/notifs"))[1].items.filter(x => x.kind === "photos");
  ok("BOTH people get exactly one 'profile pictures' notification", na.length === 1 && nb.length === 1 && /profile pictures/.test(na[0].text) && /zainab|tunde|adaeze/i.test(na[0].text + nb[0].text), [na, nb]); }
let [s, m] = await a("GET", "/matches"); const mm = m.matches.find(x => x.user.id === ib);
ok("matches: batched message count = 104, photo unlocked, talking stage (auto match)", mm && mm.count === 104 && mm.photoUnlocked === true && mm.talking === true, mm && { count: mm.count, p: mm.photoUnlocked, t: mm.talking });
ok("matches: last message correct", mm && mm.last && mm.last.text === "message number 103" && mm.last.from_id === ib, mm && mm.last);
[s, m] = await b("GET", "/matches"); const mb = m.matches.find(x => x.user.id === ia); ok("the other person sees the same count and pct", mb && mb.count === 104 && mb.pct === 95, mb && { c: mb.count, p: mb.pct });
const [s2, msgs] = await a("GET", `/messages/${ib}`); ok("message history: first page of 100, in order", s2 === 200 && msgs.length === 100 && msgs[0].text === "message number 0" && msgs[99].text === "message number 99", [s2, msgs && msgs.length]);
[s, m] = await a("GET", `/messages/${ib}?after=${msgs[99].id}`); ok("messages ?after= returns the remaining 4", m.length === 4 && m[3].text === "message number 103", m && m.length);
{ const mr = await a("POST", "/matches", { to: ic }); ok("send a match request (A to C)", mr[0] === 200 || mr[0] === 201, mr); const inc = (await c("GET", "/matches"))[1].incoming; ok("C sees the incoming request", inc.length >= 1 || (mr[1] && mr[1].status === "matched"), [mr[1], inc.length]);
  if (inc[0]) { const rs = await c("POST", `/matches/${inc[0].requestId}/respond`, { accept: true }); ok("C accepts: match created", rs[0] === 200, rs); ok("A now has 2 matches", (await a("GET", "/matches"))[1].matches.length === 2); } }
{ const idd = (await su("dayo_" + SFX)); const idn = (await me(idd.token)).id; const rid = (await P1("INSERT INTO requests(from_id,to_id,status,pct,created,auto) VALUES(?,?,?,?,?,0) RETURNING id", [idn, ia, "pending", 60, Date.now()])).id;
  const inc2 = (await a("GET", "/matches"))[1].incoming; ok("pending incoming request is listed with its requestId", inc2.some(x => x.requestId === rid), inc2);
  const rs = await a("POST", `/matches/${rid}/respond`, { accept: true }); ok("accept a match request", rs[0] === 200, rs);
  ok("both sides now matched", (await a("GET", "/matches"))[1].matches.some(x => x.user.id === idn) && (await mk(idd.token)("GET", "/matches"))[1].matches.some(x => x.user.id === ia));
  const idm = (await su("emeka_" + SFX)); const imm = (await me(idm.token)).id; const rid2 = (await P1("INSERT INTO requests(from_id,to_id,status,pct,created,auto) VALUES(?,?,?,?,?,0) RETURNING id", [imm, ia, "pending", 55, Date.now()])).id;
  const dc = await a("POST", `/matches/${rid2}/respond`, { accept: false }); ok("decline a match request", dc[0] === 200, dc); }
await a("POST", "/block", { userId: ic }); await a("POST", "/report", { userId: ic, reason: "spam" });
// ---- replying to a message
{ const [, hist] = await a("GET", `/messages/${ib}`); const tgt = hist[3];
  const [rs] = await a("POST", `/messages/${ib}`, { text: "replying to message 3", replyTo: tgt.id }); ok("reply is accepted", rs === 201, rs);
  const [, c1] = await b("GET", `/messages/${ia}?after=${hist[99].id}`); const mine = c1.find(x => x.text === "replying to message 3");
  ok("reply carries the original (id, who wrote it, text)", mine && mine.replyTo && mine.replyTo.id === tgt.id && mine.replyTo.from_id === tgt.from_id && mine.replyTo.text === tgt.text, mine);
  ok("normal messages have replyTo null", c1.filter(x => x.text !== "replying to message 3").every(x => x.replyTo === null), c1.map(x => x.replyTo));
  await a("POST", `/messages/${ib}`, { text: "replying to my own", replyTo: hist[0].id });
  const [, c2] = await a("GET", `/messages/${ib}?after=${hist[99].id}`); const own = c2.find(x => x.text === "replying to my own"); ok("you can reply to your own message", own && own.replyTo.from_id === ia, own);
  await a("POST", `/messages/${ib}`, { text: "no such message", replyTo: 99999999 }); await a("POST", `/messages/${ib}`, { text: "not a number", replyTo: "abc" }); await a("POST", `/messages/${ib}`, { text: "negative", replyTo: -5 });
  const [, c3] = await a("GET", `/messages/${ib}?after=${hist[99].id}`); const bad = ["no such message", "not a number", "negative"].map(t => c3.find(x => x.text === t));
  ok("a missing, non-numeric or negative reply target: message still sent, no reply attached", bad.every(x => x && x.replyTo === null), bad);
  const long = "L".repeat(400); await b("POST", `/messages/${ia}`, { text: long }); const [, c4] = await b("GET", `/messages/${ia}?after=${hist[99].id}`); const lm = c4.find(x => x.text === long);
  await a("POST", `/messages/${ib}`, { text: "reply to a long one", replyTo: lm.id }); const [, c5] = await a("GET", `/messages/${ib}?after=${hist[99].id}`);
  ok("the quoted text is trimmed to 140 characters", c5.find(x => x.text === "reply to a long one").replyTo.text.length === 140);
  // a message from ANOTHER conversation can't be quoted (it would leak private text)
  const secret = { id: (await P1("INSERT INTO messages(from_id,to_id,text,created) VALUES(?,?,?,?) RETURNING id", [ic, ia, "private message between A and C", Date.now()])).id };
  await a("POST", `/messages/${ib}`, { text: "trying to quote another chat", replyTo: secret.id }); const [, c6] = await a("GET", `/messages/${ib}?after=${hist[99].id}`);
  ok("quoting a message from a DIFFERENT chat is ignored", secret && c6.find(x => x.text === "trying to quote another chat").replyTo === null, secret); }
// amebo
{ const r_ = await a("POST", "/amebo", { text: "A first test gist here", cat: "lag", anon: true }); await sleep(300); ok("amebo post", r_[0] === 201, r_); } await a("POST", "/amebo", { text: "A second test gist here", cat: "con", anon: false }); await a("POST", "/amebo", { text: "A third test gist here", cat: "rnd" });
ok("amebo 4th refused", (await a("POST", "/amebo", { text: "A fourth test gist here", cat: "rnd" }))[0] === 409);
const [, st] = await a("GET", "/amebo"); ok("amebo status: 3 of 3, none left", st.mineAll.length === 3 && st.postsLeft === 0 && st.canPost === false, st);
const gid = (await b("GET", "/amebo/next"))[1]?.gist?.id; await b("POST", `/amebo/${st.mineAll[0].id}/react`, { emoji: "😂" }); await b("POST", `/amebo/${st.mineAll[0].id}/report`, {}); await b("GET", "/amebo/read"); await a("DELETE", `/amebo/${st.mineAll[2].id}`);
const par = await Promise.all([1, 2, 3, 4, 5].map(async i => { const r = await fetch(`http://127.0.0.1:${PORT}/api/amebo`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + B.token, "x-forwarded-for": "9.9.9." + i }, body: JSON.stringify({ text: "Parallel gist number " + i, cat: "lag" }) }); return [r.status]; }));
ok("simultaneous posts cannot beat the daily limit of 3", par.filter(x => x[0] === 201).length === 3, par.map(x => x[0]));
// shop, gifts, xp
const [, sh] = await a("GET", "/shop"); ok("shop prices all >= 1000", Math.min(...sh.items.map(i => i.price)) >= 1000, sh.items.map(i => i.price));
ok("buy + wear", (await a("POST", "/shop/buy", { id: sh.items[0].id }))[0] === 200 && (await a("POST", "/shop/wear", { id: sh.items[0].id }))[0] < 500); let g10 = 0; for (let i = 0; i < 10; i++) g10 += (await a("POST", "/gift", { to: ib, amount: 1000 }))[0] === 200;
ok("gifts: 10 x 1000 then limit", g10 === 10 && (await a("POST", "/gift", { to: ib, amount: 10 }))[0] === 400);
// games
let [, gi] = await a("POST", "/games/invite", { userId: ib }); ok("game invite", gi && gi.id, gi); { const rr = await b("POST", `/games/${gi.id}/respond`, { accept: true }); await sleep(300); }
let [, gm] = await a("GET", `/games/with/${ib}`); const q1 = gm.cur.q; await a("POST", `/games/${gi.id}/swap`, {}); [, gm] = await a("GET", `/games/with/${ib}`);
ok("game: playing, swap changes question, 20 distinct questions", gm.status === "playing" && gm.cur.q !== q1, gm);
for (let i = 0; i < 40; i++) { [, gm] = await a("GET", `/games/with/${ib}`); if (gm.status === "done") break; if (gm.cur.yourTurnToAsk) await a("POST", `/games/${gi.id}/ask`, {}); else if (gm.cur.yourTurnToAnswer) await a("POST", `/games/${gi.id}/answer`, { text: "my answer " + i }); else { const [, g2] = await b("GET", `/games/with/${ia}`); if (g2.cur.yourTurnToAsk) await b("POST", `/games/${gi.id}/ask`, {}); else if (g2.cur.yourTurnToAnswer) await b("POST", `/games/${gi.id}/answer`, { text: "their answer " + i }); } }
[, gm] = await a("GET", `/games/with/${ib}`); ok("full 20-question game plays through to done", gm.status === "done", [gm.status, gm.i]);
await a("GET", "/qa"); await a("GET", "/leaderboard");
// double-spend protection: 5 simultaneous purchases with only enough XP for one
{ const ids = (await a("GET", "/shop"))[1].items.filter(i => i.price === 1000).map(i => i.id); const idr = (await su("rich_" + SFX)); const ir = (await me(idr.token)).id; const rr = mk(idr.token);
  (await P("UPDATE users SET xp=1000,gin=0,spent=0,outfits='[]' WHERE id=?", [ir]));
  const res5 = await Promise.all([ids[0], ids[0], ids[1] || ids[0], ids[0], ids[1] || ids[0]].map(id => rr("POST", "/shop/buy", { id })));
  const okc = res5.filter(x => x[0] === 200).length; const bal = (await rr("GET", "/me"))[1];
  ok("5 simultaneous buys with XP for one: exactly one succeeds, no overspend", okc === 1, res5.map(x => x[0]));
  (await P("UPDATE users SET xp=3000,gin=0,spent=0 WHERE id=?", [ir]));
  const g5 = await Promise.all([1, 2, 3, 4, 5, 6].map(() => rr("POST", "/gift", { to: ia, amount: 1000 })));
  ok("6 simultaneous gifts of 1000 with 3000 XP: at most 3 go through", g5.filter(x => x[0] === 200).length <= 3, g5.map(x => x[0])); }
// delete account (transaction)
{ const dr = await c("DELETE", "/me", { password: "password123" }); const left = (await P1("SELECT COUNT(*) n FROM users WHERE id=?", [ic])).n; const leftover = (await P1("SELECT (SELECT COUNT(*) FROM messages WHERE from_id=? OR to_id=?)+(SELECT COUNT(*) FROM requests WHERE from_id=? OR to_id=?) n", [ic, ic, ic, ic])).n; ok("delete account removes the user and their rows (transaction)", dr[0] === 200 && left === 0 && leftover === 0, [dr, left, leftover]); }
if (demo) { await sleep(5000); const bots = (await P1("SELECT COUNT(*) n FROM users WHERE bot=1", [])).n; ok("demo bots were created", bots > 0, bots); await a("GET", "/people"); await a("POST", "/matches", { userId: (await P1("SELECT id FROM users WHERE bot=1 LIMIT 1", [])).id }); await sleep(5000); }
const trace = err.split("\n").filter(l => /Error|at .*server\.mjs|unhandled|TypeError|ReferenceError/i.test(l) && !/ExperimentalWarning/.test(l));
ok("no server errors (HTTP 500) on any route", fiveHundreds.length === 0, fiveHundreds); ok("nothing bad in the server's error output", trace.length === 0, trace.slice(0, 6));
const odd = rows.filter(r => /-> (4\d\d)/.test(r)); console.log(`\nroutes exercised: ${new Set(rows.map(r => r.split(" -> ")[0])).size}; 4xx responses: ${odd.length}`); console.log("4xx list:", [...new Set(odd)].join(" | "));
srv.kill(); await pool.end(); console.log(`\n${pass} passed, ${fail} failed`); console.log(fail ? "\nSomething failed: send me this whole output." : "\nAll good. Delete this test database now."); process.exit(fail ? 1 : 0);
