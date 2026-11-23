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
5. If anything says FAIL, copy the whole output and send it to me. Do not go live yet.
6. Delete the staging database when done. The check creates test users, so never run it against your real database.

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
