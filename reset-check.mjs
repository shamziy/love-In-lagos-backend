// RESET CHECK: password reset, email contents, rate limits and anti-faking checks, run against a REAL PostgreSQL.
// It starts the real server and a fake email service on your computer, and creates test users in the database.
// Use ONLY a throwaway database:   DATABASE_URL="postgres://..." node reset-check.mjs --yes-this-is-a-test-database
const URL_ = process.env.DATABASE_URL || "";
if (!URL_ || !process.argv.includes("--yes-this-is-a-test-database")) { console.error("Usage: DATABASE_URL=<throwaway test database> node reset-check.mjs --yes-this-is-a-test-database"); process.exit(2); }
const SFX = Math.random().toString(36).slice(2, 6);
import { spawn } from "node:child_process";
import http from "node:http";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0; const ok = (n, c, x = "") => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : "  -> " + JSON.stringify(x).slice(0, 300))); };
// ---- a fake Resend: records every email, and can be slow or refuse
const mails = []; let mode = "ok";
const mock = http.createServer((req, res) => { let d = ""; req.on("data", c => d += c); req.on("end", async () => { const b = JSON.parse(d || "{}"); mails.push({ auth: req.headers.authorization, ...b }); if (mode === "slow") await sleep(3000); if (mode === "fail") { res.writeHead(422, { "content-type": "application/json" }); return res.end(JSON.stringify({ message: "You can only send testing emails to your own email address." })); } res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"x"}'); }); });
await new Promise(r => mock.listen(4599, r));
async function start(port, env) {
  const p = spawn("node", ["server.mjs"], { env: { ...process.env, PORT: port, DATABASE_URL: URL_, JWT_SECRET: "a-test-secret-that-is-long-enough-123456", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let err = ""; p.stderr.on("data", d => err += d);
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break } catch {} await sleep(150) }
  return { p, port, err: () => err };
}
const call = (port, tk) => async (m, path, b, hdr = {}) => { const r = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: m, headers: { "content-type": "application/json", ...(tk ? { authorization: "Bearer " + tk } : {}), ...hdr }, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json() } catch {} return [r.status, j] };
const codeOf = m => (m.text.match(/\b(\d{6})\b/) || [])[1];

// ======================= server 1: real email configured (DEMO off) =======================
const S = await start(3995, { DEMO: "false", RESEND_API_KEY: "re_test_key", RESEND_URL: "http://127.0.0.1:4599/emails", MAIL_FROM: "Love in Lagos <no-reply@example.com>", RESET_COOLDOWN_MS: "1500" });
const A = call(3995);
const su = async (u, pw = "oldpassword1") => (await A("POST", "/signup", { username: u, email: u + "@example.org", password: pw }))[1];
const U = await su("amaka_t" + SFX + ""), V = await su("bola_t" + SFX + ""), W = await su("wale_t" + SFX + "");
ok("startup does NOT warn when email is configured", !/RESEND_API_KEY is not set/.test(S.err()));

// 1. email goes out with the code
let [st, body] = await A("POST", "/forgot", { identifier: "amaka_t" + SFX + "@example.org" });
await sleep(300);
ok("forgot: 200, generic message, no code in the reply", st === 200 && body.ok && !("devCode" in body) && /If that account exists/.test(body.message), body);
ok("exactly one email was sent, to the right person", mails.length === 1 && mails[0].to[0] === "amaka_t" + SFX + "@example.org", mails);
ok("email uses your MAIL_FROM and the API key", mails[0].from === "Love in Lagos <no-reply@example.com>" && mails[0].auth === "Bearer re_test_key");
const code1 = codeOf(mails[0]);
ok("email has a 6-digit code in subject, text and html", /^\d{6}$/.test(code1) && mails[0].subject.includes(code1) && mails[0].html.includes(code1) && /15 minutes/.test(mails[0].text), mails[0].subject);
// 2. no account enumeration
const before = mails.length; const [st2, body2] = await A("POST", "/forgot", { identifier: "nobody_here@example.org" }); await sleep(200);
ok("unknown account: identical reply and NO email", st2 === 200 && JSON.stringify(body2) === JSON.stringify(body) && mails.length === before, [body2]);
// 3. slow email service must not slow the reply (otherwise reply time reveals which accounts exist)
mode = "slow"; const t0 = Date.now(); const [st3] = await A("POST", "/forgot", { identifier: "bola_t" + SFX + "@example.org" }); const dt = Date.now() - t0; mode = "ok";
ok("a slow email service does not delay the reply (" + dt + " ms)", st3 === 200 && dt < 1000, dt);
await sleep(3200);
// 4. cooldown: no email flooding
await A("POST", "/forgot", { identifier: "amaka_t" + SFX + "@example.org" }); await sleep(300); const n0 = mails.length, codeA = codeOf(mails[mails.length - 1]);
await A("POST", "/forgot", { identifier: "amaka_t" + SFX + "@example.org" }); await A("POST", "/forgot", { identifier: "amaka_t" + SFX + "" }); await sleep(300);
ok("asking again at once (twice) sends no further email: flood protection", mails.length === n0, mails.length - n0);
await sleep(1600); await A("POST", "/forgot", { identifier: "amaka_t" + SFX + "@example.org" }); await sleep(300);
ok("after the cooldown a new code is sent, and it is different", mails.length === n0 + 1 && codeOf(mails[mails.length - 1]) !== codeA, mails.length - n0);
const code2 = codeOf(mails[mails.length - 1]);
// 5. guessing: 5 wrong tries lock that code
for (let i = 0; i < 5; i++) await A("POST", "/reset", { identifier: "amaka_t" + SFX + "", code: "000000" === code2 ? "111111" : "000000", password: "brandnewpass1" });
ok("after 5 wrong guesses even the right code is refused", (await A("POST", "/reset", { identifier: "amaka_t" + SFX + "", code: code2, password: "brandnewpass1" }))[0] === 400);
await sleep(1600); await A("POST", "/forgot", { identifier: "amaka_t" + SFX + "" }); await sleep(300); const code3 = codeOf(mails[mails.length - 1]);
ok("asking for a fresh code unlocks it", code3 && code3 !== code2);
// 6. the reset itself
ok("password under 8 characters refused", (await A("POST", "/reset", { identifier: "amaka_t" + SFX + "", code: code3, password: "short" }))[0] === 400);
const [rs, rb] = await A("POST", "/reset", { identifier: "amaka_t" + SFX + "@example.org", code: code3, password: "brandnewpass1" });
ok("correct code + new password: success and signed in", rs === 200 && rb.token && rb.user.username === "amaka_t" + SFX + "", rb);
ok("new password logs in", (await A("POST", "/login", { identifier: "amaka_t" + SFX + "", password: "brandnewpass1" }))[0] === 200);
ok("old password no longer works", (await A("POST", "/login", { identifier: "amaka_t" + SFX + "", password: "oldpassword1" }))[0] === 401);
ok("the old login token (other devices) is signed out", (await call(3995, U.token)("GET", "/me"))[0] === 401);
ok("the code cannot be used twice", (await A("POST", "/reset", { identifier: "amaka_t" + SFX + "", code: code3, password: "another-pass-1" }))[0] === 400);
// 7. email service refuses (e.g. domain not verified): the user sees the same thing, YOU see why in the log
mode = "fail"; await sleep(1600); await A("POST", "/forgot", { identifier: "wale_t" + SFX + "@example.org" }, { "x-forwarded-for": "1.1.1.1, 203.0.113.70, 10.9.9.9" }); await sleep(500); mode = "ok";
const codeFail = codeOf(mails[mails.length - 1]);
ok("email refused: server log explains why (not silent)", /Email service refused a message \(HTTP 422\).*own email address/.test(S.err()) && /NOT sent/.test(S.err()), S.err().slice(-300));
const allCodes = mails.map(codeOf).filter(Boolean);
ok("no reset code is ever written to the server log", allCodes.every(c => !S.err().includes(c)) && !S.err().includes(codeFail), allCodes);
// 8. faking X-Forwarded-For must not beat the limits. Render's chain: <whatever the visitor typed>, <real client>, <proxy>
const chain = i => ({ "x-forwarded-for": `9.9.9.${i}, 203.0.113.50, 10.9.9.9` });
const rs8 = []; for (let i = 0; i < 12; i++) rs8.push((await A("POST", "/forgot", { identifier: "nobody" + i }, chain(i)))[0]);
ok("12 forgot requests with a different FAKE first address each: still limited to 8 per minute", rs8.filter(x => x === 200).length === 8 && rs8.filter(x => x === 429).length === 4, rs8);
ok("a genuinely different visitor is not affected", (await A("POST", "/forgot", { identifier: "x" }, { "x-forwarded-for": "1.1.1.1, 203.0.113.51, 10.9.9.9" }))[0] === 200);
ok("Cloudflare's header is trusted when present", (await A("GET", "/myip", null, { "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "6.6.6.6, 203.0.113.50, 10.9.9.9" }))[1].ip === "198.51.100.7");
ok("/api/myip shows the real address, not the fake one", (await A("GET", "/myip", null, chain(77)))[1].ip === "203.0.113.50");
// 9. wrong-password guessing on one account
for (let i = 0; i < 10; i++) await A("POST", "/login", { identifier: "bola_t" + SFX + "", password: "wrong" + i }, { "x-forwarded-for": `5.5.5.${i}, 203.0.113.${100 + i}, 10.9.9.9` });
const [lb] = await A("POST", "/login", { identifier: "bola_t" + SFX + "", password: "oldpassword1" }, { "x-forwarded-for": "5.5.5.99, 203.0.113.199, 10.9.9.9" });
ok("10 wrong passwords from 10 different addresses: that account is slowed down (429)", lb === 429, lb);
ok("other accounts are not affected", (await A("POST", "/login", { identifier: "wale_t" + SFX + "", password: "oldpassword1" }))[0] === 200);
for (let i = 0; i < 5; i++) await A("POST", "/login", { identifier: "wale_t" + SFX + "", password: "bad" + i }); await A("POST", "/login", { identifier: "wale_t" + SFX + "", password: "oldpassword1" });
for (let i = 0; i < 5; i++) await A("POST", "/login", { identifier: "wale_t" + SFX + "", password: "bad" + i });
ok("a successful login resets the counter", (await A("POST", "/login", { identifier: "wale_t" + SFX + "", password: "oldpassword1" }))[0] === 200);
S.p.kill();

// ======================= server 2: DEMO on, no email service (the risky default) =======================
const D = await start(3996, { DEMO: "true" }); const B = call(3996);
const du = (await B("POST", "/signup", { username: "real_user" + SFX + "", email: "real@example.org", password: "oldpassword1" }))[1];
ok("startup note (not an alarm) in demo mode without email", /RESEND_API_KEY is not set/.test(D.err()) && !/WARNING/.test(D.err()));
const [, local] = await B("POST", "/forgot", { identifier: "real_user" + SFX + "" });
ok("running on your own computer: the code is shown on screen so you can test", /^\d{6}$/.test(local.devCode || ""), local);
await sleep(1100);
const [, viaProxy] = await B("POST", "/forgot", { identifier: "real_user" + SFX + "" }, { "x-forwarded-for": "8.8.8.8, 203.0.113.60, 10.9.9.9" });
ok("through a proxy (= on Render) the code is NEVER in the reply, even with DEMO on", !("devCode" in viaProxy), viaProxy);
ok("the same with Cloudflare's header", !("devCode" in (await B("POST", "/forgot", { identifier: "real_user" + SFX + "" }, { "cf-connecting-ip": "8.8.4.4" }))[1]));
D.p.kill();
// ======================= server 3: DEMO off, no email service: loud warning =======================
const N = await start(3997, { DEMO: "false" }); ok("production without an email key: loud WARNING at start-up", /WARNING: RESEND_API_KEY is not set/.test(N.err()), N.err().slice(0, 200)); N.p.kill();
mock.close(); console.log(`\n${pass} passed, ${fail} failed`); console.log(fail ? "\nSomething failed: send me this whole output." : "\nAll good. Delete this test database now."); process.exit(fail ? 1 : 0);
