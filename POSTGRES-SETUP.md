# Moving Love in Lagos to PostgreSQL: step by step

## What changed in the server
- Data now lives in PostgreSQL (your Render database) instead of a file on the server, so redeploys and restarts no longer touch it, and Render keeps backups.
- Same website, same URLs, same answers. Nothing changes in the frontend for this step.
- Faster for many users: the chat list now loads in 3 database queries instead of several per match, and the tables have indexes.
- One person's own changes (buy, gift, post...) run one at a time, so quick double taps cannot spend the same XP twice.
- Tables are created automatically the first time the server starts. There is no data to move because you have no users yet.

## Before you start
1. **Put the new website files live first** (the 700-question bank in `js/questions.js`). The new server can pick questions 500 to 699, which an older website cannot show.
2. Decide about demo people: the server adds 16 pretend users and fake activity unless the environment variable `DEMO` is set to `false`. For a real launch you almost certainly want `DEMO=false`.

## Step 1: Test on a throwaway database (do this first, about 15 minutes)
1. Render dashboard, New, PostgreSQL. Name it `lagos-staging`, free plan, any region. Create.
2. Open it and copy the **External Database URL**.
3. On your computer (needs Node.js 22.13 or newer) open a terminal in this folder and run:
       npm install
       DATABASE_URL="PASTE-THE-EXTERNAL-URL-HERE" node staging-check.mjs --yes-this-is-a-test-database
   (On Windows PowerShell: `$env:DATABASE_URL="..."; node staging-check.mjs --yes-this-is-a-test-database`)
4. You want to see `0 failed` and `All good` at the end (about 40 checks pass). Then run it once more with `demo` at the end of the command (`... --yes-this-is-a-test-database demo`) for the demo-people mode.
5. Then run the password-reset check the same way (it starts a pretend email service on your computer, so no real email is sent):
       DATABASE_URL="PASTE-THE-EXTERNAL-URL-HERE" node reset-check.mjs --yes-this-is-a-test-database
   (use a fresh throwaway database for each run). You want `0 failed` here too.
6. If anything says FAIL, copy the whole output and send it to me. Do not go live yet.
7. Delete the staging database when done. The check creates test users, so never run it against your real database.

## Step 2: Create the real database
1. Render, New, PostgreSQL. Name `lagos-db`. **Same region as your web service.** Plan: Basic-256mb ($6). Create.
2. Copy its **Internal Database URL** (it has no dots in the host name; it only works between your Render services).

## Step 3: Switch the server over
1. Render, your web service, Environment. Add:
   - `DATABASE_URL` = the Internal Database URL
   - `DEMO` = `false` (for launch)
   - keep your existing `JWT_SECRET` (long random text; if it is missing, everyone is logged out on every restart)
2. Settings: Build Command `npm install`. Start Command `node server.mjs`.
3. Push the new `server.mjs`, `package.json`, `staging-check.mjs` to your backend repository. Render redeploys.
4. Open the deploy log. You should see `Love in Lagos is running`. If you see `DATABASE_URL is not set` or `'pg' package is not installed`, the message tells you which step above was missed.
5. Open `https://love-in-lagos-api.onrender.com/` and check it says the backend is running. Then sign up on your real website and try chat, shop, a gist and 20 Questions.

## Password reset emails (needed, or people who forget their password are locked out)
The "Forgot password" link works end to end, but the server can only send the 6-digit code if an email service is connected. It uses Resend (resend.com).
1. Create a free Resend account, then Domains, Add domain. You need a domain you own (for example `yourdomain.com`). Add the DNS records Resend shows you (SPF and DKIM) where you bought the domain, and wait until Resend says Verified.
   Until a domain is verified, Resend only delivers to your own account's email address, so real users would get nothing.
2. Resend, API Keys, Create API key (sending access). Copy it.
3. On your Render web service add two environment variables:
   - `RESEND_API_KEY` = the key
   - `MAIL_FROM` = `Love in Lagos <no-reply@yourdomain.com>` (an address on the verified domain)
4. Redeploy, then test with a real email address: Log in screen, Forgot password, check the inbox and the spam folder.
5. If no email arrives, open your Render logs. The server now says why, for example "Email service refused a message (HTTP 403): ... domain is not verified". At start-up it also prints a WARNING if `RESEND_API_KEY` is missing.
Good to know: emails are not verified when people sign up, so someone who typed their email wrongly cannot reset by email. Only that account's real inbox receives codes.

## Security settings (new)
- **`ALLOWED_ORIGIN`**: set it to your website's address, for example `https://shamziy.github.io` (just the site, no folder). The default `*` lets any website call your server.
- **Who is calling (`TRUSTED_PROXY_HOPS`, default 2).** Render only *adds* to the `X-Forwarded-For` header, so the first entry can be typed by a visitor. The server now uses Cloudflare's own header, or the entry added by Render's proxies, so the limits on login, sign-up, messages and gists can't be dodged by faking it. I can't see Render's live set-up, so check it once after deploying (2 minutes):
  1. Open `https://love-in-lagos-api.onrender.com/api/myip` in your browser. It should show your own public address (compare with a "what is my IP" site).
  2. In a terminal run: `curl -H "X-Forwarded-For: 1.2.3.4" https://love-in-lagos-api.onrender.com/api/myip`. It must STILL show your real address. If it shows `1.2.3.4`, or the same address for everybody, tell me what both show and I will adjust the number.
- **Limits now in place:** 10 wrong passwords for one account in 15 minutes slows that account down (429); "Forgot password" is limited to 8 requests a minute per visitor and one email per account per minute; a reset code is 6 digits, lasts 15 minutes, allows 5 guesses and works once; changing the password signs out the person's other devices.
- **A reset code is never put in the reply or the log.** In demo mode on your own computer the code is shown on screen so you can test; on Render this can never happen, even if `DEMO` is left on.

## Backups (do not skip)
- Render keeps continuous recovery history for paid databases. Check how many days your workspace plan keeps (the shortest is 3 days).
- Also keep your own copy weekly, somewhere that is not Render. With the External Database URL, from a computer with PostgreSQL tools installed:
      pg_dump "EXTERNAL-URL" -Fc -f lagos-backup-2026-12-01.dump
- Practise restoring once before launch: create a second empty database and run
      pg_restore --no-owner -d "OTHER-DATABASE-URL" lagos-backup-2026-12-01.dump
  and check the data is there. A backup you have never restored is only a hope.

## Watching it after launch
- Render, your database, Metrics: if CPU or memory stays high, or you see "too many connections" in the web service log, move up one database size (a setting, nothing to rebuild).
- The server uses at most 10 database connections (`PG_POOL_MAX`). The $6 plan allows about 100.
- One web service instance is what this is built for. Do not run two copies yet.

## If you must go back
`old-sqlite-version/server.mjs` is the previous server. It needs no database URL but stores data in a file that Render erases on every redeploy, so it is only for emergencies and demos.
