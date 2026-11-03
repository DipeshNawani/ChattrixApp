# Chattrix — WhatsApp-style desktop chat
Built by **Dipesh Nawani**
Electron client  +  Node.js/Socket.IO server on **Render**  +  **Supabase** (Postgres database + file storage)

```
Electron app (any PC)  ──►  Render: Node + Socket.IO  ──►  Supabase Postgres  (users, chats, messages)
                                                     └──►  Supabase Storage   (photos, files, voice, avatars)
```

## 1. Supabase setup (one time, ~5 min)
1. supabase.com -> **New project**. Choose a name, a strong **database password** (save it!) and a region close to you
   (use the same area for Render, e.g. Singapore). Wait until it is ready.
2. Click **Connect** (top of the dashboard) -> copy the **Session pooler** connection string (looks like
   `postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`).
   Replace `[YOUR-PASSWORD]` with your password. If the password has special characters, URL-encode them (`@` -> `%40`, `#` -> `%23`).
   Do NOT add `?sslmode=...` at the end.
3. **Project Settings -> API**: copy the **Project URL** (`https://<ref>.supabase.co`) and the **service_role** key
   (new projects may call it "secret key"). This key is private: only put it in Render / your `.env`, never in the app or GitHub.
4. Nothing else! The server creates all tables automatically on first start (`server/schema.sql`) and creates a public
   Storage bucket called `chat-files`. (If it cannot: Storage -> New bucket -> name `chat-files` -> tick **Public**.)

## 2. Test locally first (recommended)
    cd server
    cp .env.example .env       # fill the 3 values from step 1
    npm install
    npm run dev                # -> "Storage: Supabase bucket chat-files" + "running on port 3000"

    cd ../client && npm install && npm start          # app 1
    cd client && npm run start:user2                  # app 2 (second user on the same PC)
In the login screen use Server URL `http://localhost:3000`, Sign up, and chat. Restart the server: your account and messages are still there.

## 3. Deploy on Render
1. Push this folder to GitHub (the `.gitignore` already excludes `.env`).
2. render.com -> **New -> Web Service** -> choose the repo.
   Root Directory `server` | Build `npm install` | Start `npm start` | Instance: Free | Region: Singapore (or nearest to Supabase).
3. **Environment** -> add `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (same values as `.env`) and `NODE_VERSION` = `22`.
4. Deploy. Open `https://<name>.onrender.com/` -> you should see `{"ok":true,"storage":"supabase"}`.
5. Put that URL in `client/app.js` -> `DEFAULT_SERVER`, or type it on the login screen.

Then build installers: `cd client && npm run dist` (-> `client/dist`), upload to Google Drive / GitHub Releases, share with the interviewer.

## Things to know
* Render free sleeps after ~15 min idle; the first connect takes up to ~1 min (the app waits for it).
* Supabase free pauses a project after 1 week of inactivity (data is kept; restore it from the dashboard). Open the dashboard before you send the mail.
* Supabase free limits: 500 MB database, 1 GB file storage. Max upload in the app: 25 MB.
* Calls use free STUN servers only: they work on most home/mobile networks, strict college/office networks may need a TURN server.

## Common errors
| Error | Fix |
|---|---|
| `DATABASE_URL is not set` | add the env var (`.env` locally, Environment tab on Render) |
| `password authentication failed` | wrong DB password, or special characters not URL-encoded |
| `Tenant or user not found` | use the **pooler** string; user must be `postgres.<project-ref>` (not just `postgres`) |
| `ENETUNREACH` / `ENOTFOUND db.xxxx.supabase.co` | you used the *direct* connection; use the **Session pooler** string |
| `Could not create bucket` | Storage -> New bucket `chat-files` -> Public |
| upload fails / `Invalid JWT` / row-level security | you pasted the *anon* key; use the **service_role / secret** key |
| App says "Cannot reach server" | Render is waking up; wait ~1 min and press the button again |

## Features (all 15)
Reactions · Reply/edit/delete (me / everyone) · Unread, notifications, mute · Avatars, last seen, status ·
File & media previews, upload progress, drag-drop, download history · Search with filters · Group roles ·
Invite links (+ `chattrix://` deep link) · Group settings · Polls & pins · 1-to-1 voice/video calls (WebRTC) ·
Voice messages · Multi-device sync · Light/Dark/System themes · Channels

## UI notes
Dark / Light / System themes, bundled Inter font (client/fonts, OFL license), Lucide icons (ISC), single-pane layout under 900 px,
keyboard friendly (Tab, Enter, Esc, Ctrl+K), reduced-motion support.

## Layout
server/server.js   REST + Socket.IO handlers     server/db.js   Postgres pool    server/storage.js   Supabase Storage
server/schema.sql  tables (auto-run)             client/        Electron app (main, preload, app.js, calls.js, util.js, styles.css)
