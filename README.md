# Love in Lagos: BACKEND folder

The server: accounts, matching, chat, 20 Questions, daily question, visitors, presence and 16 demo residents.
**It runs on its own.** It does not need the frontend folder.

Files: `server.mjs`, `package.json`, `.env.example`, `README.md`

## Run it
1. Install Node.js 22.13 or newer from nodejs.org
2. Open this folder in VS Code, open a terminal (Ctrl + `)
3. `node server.mjs`
4. Open http://localhost:3000 (a status page appears; the API is at `/api`, health check at `/health`)

If a folder named `frontend` sits next to this folder, the backend also shows the website at the same address.

## If it does not work
| What you see | Fix |
|---|---|
| `node` is not recognised | Install Node.js, then close and reopen VS Code |
| "needs Node.js 22.13 or newer" | Install the current Node.js, check with `node -v` |
| "Port 3000 is already in use" | `PORT=3001 node server.mjs` (Windows PowerShell: `$env:PORT=3001; node server.mjs`) |
| "Cannot use import statement" | The file must be named exactly `server.mjs` |

## Settings (environment variables, all optional)
`PORT` (3000), `JWT_SECRET`, `DB_PATH` (lagos.db), `DEMO` (true = 16 pretend residents, false = real people only), `FRONTEND_DIR`, `ALLOWED_ORIGIN`.

## Put it online
Upload this folder to GitHub, create a Render (or Railway) web service, start command `node server.mjs`, set `NODE_VERSION` to `22`, `JWT_SECRET`, and `DEMO=false` for a real launch. Free hosts wipe the database file on redeploy: use a persistent disk and `DB_PATH` for a real launch.

## Match rules
5-20% not a match (nothing sent) | 21-50% worth a trial | 51-79% potential | 80-94% interesting | 95-100% instant match. "Talking stage": 90%+ match, or 10+ messages a day for 3 days in a row. Profile pictures unlock after 100 messages.
