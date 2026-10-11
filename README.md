# Team Kanban Board

A simple shared kanban board: To Do / In Progress / Done, drag-and-drop cards,
assign tasks to teammates, due dates, live sync across everyone who has the
link. No accounts or passwords — people just pick their name once.

It's a plain static site (`index.html` + `style.css` + `app.js`) backed by a
free Supabase database, so it works for teammates whether or not they have a
Claude, GitHub, or any other account — they just need the URL you give them.

## 1. Create the free backend (5 min, one-time)

1. Go to https://supabase.com, sign up free, click **New project**.
2. Once it's created, open the **SQL Editor** (left sidebar), paste in the
   entire contents of `supabase-schema.sql` from this folder, and click **Run**.
   Then do the same with `supabase-migration-task-assignees.sql` (lets a task
   have several assignees; it copies over any existing assignments).
3. Go to **Project Settings -> API**. Copy:
   - **Project URL**
   - **anon public** key

## 2. Configure the app

Open `config.js` in this folder and replace the placeholders:

```js
window.KANBAN_CONFIG = {
  supabaseUrl: "https://xxxxxxxx.supabase.co",   // your Project URL
  supabaseAnonKey: "eyJhbGciOi...",              // your anon public key
  boardName: "Team Board",                        // shown at the top of the page
};
```

Save the file.

## 3. Try it locally (optional)

Just double-click `index.html` to open it in your browser and try it out
before sharing it. (Some browsers block local file access to `config.js` —
if the page looks stuck, run a tiny local server instead:
`python -m http.server 8080` in this folder, then visit
`http://localhost:8080`.)

## 4. Put it on the web

Easiest option — **Netlify Drop**, no account or command line needed:

1. Go to https://app.netlify.com/drop
2. Drag this whole `kanban-board` folder onto the page.
3. Netlify gives you a live URL (e.g. `https://random-name-123.netlify.app`)
   in seconds. That's the link you share with your team.

To be able to update it later (edit files, redeploy), make a free Netlify
account first at https://app.netlify.com/signup, then use the same drag-and-
drop from your dashboard — it'll update the same site instead of creating a
new one each time.

(Any other static host works too — GitHub Pages, Cloudflare Pages, Vercel —
since this is just static HTML/CSS/JS with no build step.)

## 5. Share it

Send teammates the deployed URL. First time they open it, they'll be asked
to pick their name (or add themselves) — no password. After that they can:

- Add tasks (+ Add task in any column)
- Assign tasks to anyone on the team
- Drag cards between columns to update status
- Click a card to edit, reassign, set a due date, or delete it
- Toggle **My tasks only** to filter to what's assigned to them
- Manage the team roster via the **Team** button

Everyone sees changes live — no refresh needed.

## Notes on security

There's no login: anyone with the link (and the Supabase key baked into
`config.js`) can read and write all tasks. That matches "share a link, no
sign-up" for your team, but it also means the link is effectively the
password — don't post it somewhere public. If you later want real accounts,
per-user permissions, or a private-org restriction, that's a bigger change
(Supabase Auth + row-level security rules) — ask and I can add it.
