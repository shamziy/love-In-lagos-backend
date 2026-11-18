LOVE IN LAGOS — UPDATED BACKEND

Contents:
- server.mjs: complete replacement for your current backend server file.
- package.json: same Node.js 22.13+ project configuration you supplied.

INSTALL:
1. Make a backup of your current Render backend repository first.
2. Replace the existing server.mjs and package.json with these two files.
3. Do not add amebo.mjs or amebo-core.cjs. Amebo is integrated directly into server.mjs.
4. Commit and push the changes to the backend repository connected to Render.
5. Wait for the Render deployment to finish, then check:
   https://love-in-lagos-api.onrender.com/health
   It should return: {"ok":true}

WHAT IS INCLUDED:
- Amebo of the Day API: anonymous/public posts, one post per user per Lagos day,
  random reading, reactions, reports (hidden after 3 unique reports), deletion,
  read history, streaks, and WAT midnight expiry.
- Amebo data is stored in SQLite in the same database as your existing accounts.
- Stack Game API: up to 30 XP per run and 60 XP per Lagos day.
- Existing routes and account tables are retained.
- Account deletion also removes that account's Amebo records.

IMPORTANT:
- This backend requires Node.js 22.13 or newer.
- Keep your existing Render environment variables. In particular, keep JWT_SECRET
  stable so existing login tokens remain valid.
- SQLite persistence follows the same DB_PATH and filesystem as your existing
  user database. If your Render service uses an ephemeral filesystem, configure a
  persistent disk and point DB_PATH to it; otherwise account and Amebo data can be
  lost when Render replaces the instance.
- This ZIP updates the backend only. The matching Amebo frontend files from your
  Amebo update ZIP must also be deployed to the frontend repository.
