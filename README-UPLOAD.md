# Love in Lagos — BACKEND repository

This folder is prepared to be uploaded directly into the ROOT of your existing backend GitHub repository.

## Upload
1. Open this folder.
2. Select everything inside it (`server.mjs`, `package.json`, `.env.example`, `.gitignore`, `.node-version`, this README).
3. Drag the selected contents into the root of your existing backend repository on GitHub.
4. Commit the changes.

Do not upload the parent `BACKEND-REPOSITORY` folder itself. `package.json` and `server.mjs` must be at the repository root.

## Existing Render service settings
For the existing Render Web Service connected to this backend repository:
- Root Directory: leave blank (the files are now at repository root)
- Build Command: `npm install`
- Start Command: `npm start`
- Runtime: Node
- Environment: `NODE_VERSION=22.13.0`
- Keep your existing `JWT_SECRET` secret.
- Keep your existing persistent disk and `DB_PATH` settings, if configured.
- Set `ALLOWED_ORIGIN=https://shamziy.github.io` for the frontend origin.
- `DEMO=true` keeps the 16 demo residents while you test. Set `DEMO=false` when you are ready for real users.

Do not create a second Render service if you want to keep using the existing one. After committing the backend files, Render should deploy the existing service automatically if auto-deploy is enabled.

## Important correction in this package
`PORT` is parsed as a number before `server.listen()`. Render supplies its `PORT` environment variable as text; passing that text directly to Node's `listen()` can be interpreted as a named pipe instead of a TCP port. This package corrects that deployment issue.

## Database
Do not delete or replace your existing database or change `DB_PATH` casually. For persistent user accounts, the database must live on a mounted Render disk. The app's SQLite database is created automatically if the configured file does not exist.
