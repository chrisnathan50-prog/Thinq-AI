# Thinq AI

A personal assistant you chat with, powered by Groq (free) or Claude. It reads your Gmail and Google Calendar, answers questions about them, and drafts replies and meeting invites. **It never sends or books anything by itself**: drafts and invites wait in the **Approvals** panel until you click *Send* or *Add to calendar*.

One server runs everything:

| Address | What it is |
|---|---|
| `/` | The Thinq website (built from `../src/pages` into `../thinq-site`) |
| `/login.html` | Sign in / create an account with Google |
| `/app` | The assistant — signed-in people only, each with their own data |

## What you can ask it

- "Plan my day"
- "What needs a reply from me?"
- "Draft replies to my unread emails"
- "Find 30 minutes with Priya this week and send her an invite"
- "Remember: sign my emails as Alex, and no meetings before 10am"
- Attach a PDF, Word or text file (paperclip, drag-and-drop or paste) and ask "What are the key dates in this contract?"
- Tap the microphone to record a voice note instead of typing (up to 2 minutes). It's turned into text you can check before sending.
- Click **Read aloud** under any answer to hear it.
- "Make an image of a cozy home office, warm morning light" — the picture appears in the chat with a Download button (needs the Cloudflare setting below).

### Documents and voice notes

- **Documents**: up to 5 per message, 10 MB each (PDF with selectable text, .docx, .txt, .md, .csv, .json, .html). Thinq keeps only the text, not the file. Long documents are split into parts the AI reads one at a time with the `read_document` tool. Scanned PDFs (photos of pages) aren't supported yet.
- **Voice notes** use Groq's free Whisper speech-to-text (`whisper-large-v3-turbo`, change with `GROQ_TRANSCRIBE_MODEL`), so they need `GROQ_API_KEY` even if you use Claude for chat. The recording is sent once to be transcribed and isn't stored. Each voice note counts as one request toward the daily limit.
- **Read aloud** uses the browser's built-in voice, so it costs nothing.

### Images (free, optional)

Thinq creates images with **Cloudflare Workers AI** (FLUX.1 schnell) through a `create_image` tool. It works with either AI choice (Groq or Claude).

1. Make a free account at <https://dash.cloudflare.com> → **AI → Workers AI → Use REST API**.
2. Copy your **Account ID**, and click **Create a Workers AI API Token**.
3. Put them in `.env` (or Render → Environment) as `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

The free plan gives 10,000 "neurons" a day — about 130 images for the whole server — and resets at midnight UTC. Each person can also make `IMAGE_DAILY_LIMIT` images a day (default 10). Images are saved in the database so they stay in the conversation; only the owner can open them. Gemini's image models are better but have no free tier (about $0.03 per image).

## How accounts work

1. **Sign in** — the website's Log in / Get started buttons go to `/login.html` → *Log in with Google*. Thinq only asks Google for your name and email at this step. A new account is created on first sign-in.
2. **Try it** — everyone starts with their own **sample inbox and calendar** (demo mode).
3. **Connect Gmail & Calendar** — a button in the app's sidebar asks Google for mail and calendar access. Each person's Google access is stored **encrypted** and is only ever used for that person.
4. **Invite-only** — only emails on the `ALLOWED_EMAILS` list can sign in (emails or whole `@domains`). Remove someone from the list and they're signed out.
5. **Daily limit** — each person gets `DAILY_REQUEST_LIMIT` AI requests a day (default 60), so nobody can use up the shared AI quota.
6. **Log out** — bottom of the sidebar.

## Run it on your computer

You need **Node.js 22.13 or newer** (`node --version`).

```bash
cd thinq-app
npm install
cp .env.example .env    # then fill it in (below)
npm run dev
```

Open <http://localhost:3000>.

In `.env`, pick an AI service:

| | **Groq** (free) | **Claude** (paid) |
|---|---|---|
| Setting | `AI_PROVIDER=groq` | `AI_PROVIDER=anthropic` |
| Key | `GROQ_API_KEY` from <https://console.groq.com/keys> — no card needed | `ANTHROPIC_API_KEY` from <https://console.anthropic.com> — a few cents per request |
| Model | `openai/gpt-oss-120b` (change with `GROQ_MODEL`) | Claude Opus 5.5 (change with `THINQ_MODEL`) |
| Good for | Trying Thinq for free; simple requests | Best quality on multi-step requests and drafts in your voice |
| Watch out for | Free-tier limits per minute and per day — shared by everyone using your server | Cost on heavy use |

…and add your Google keys (next section). Locally, the database is stored in `data/` — no setup needed.

## Google setup (sign-in + Gmail/Calendar)

In <https://console.cloud.google.com> (project "Thinq local" or a new one):

1. **APIs & Services → Library**: enable **Gmail API** and **Google Calendar API**.
2. **OAuth consent screen / Google Auth Platform**: External, app name "Thinq", your support email.
   - **Audience → Test users**: add the Gmail address of **every person** who'll use Thinq (up to 100). While the app is in *Testing*, nobody else can sign in — and Google asks testers to sign in again about once a week.
3. **Clients → your Web client → Authorized redirect URIs** — add one per place Thinq runs:
   - `http://localhost:3000/auth/google/callback` (your computer)
   - `https://YOUR-APP.onrender.com/auth/google/callback` (once it's hosted)
   - `https://yourdomain.com/auth/google/callback` (if you add your own domain)
4. Put the Client ID and secret in `.env` (or the host's settings) as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

## Share it: host it on Render (about 30 minutes)

Hosting needs the project on **GitHub**, a free **database**, and a **Render** account.

1. **Put the project on GitHub** — the whole folder (website + `thinq-app` + `render.yaml`). `.gitignore` keeps your `.env` and local data out.
2. **Create a free database** at <https://neon.tech> → New project → copy the **connection string** (`postgresql://…`).
3. **Deploy on Render** — <https://render.com> → **New → Blueprint** → pick your GitHub repo. Render reads `render.yaml` and asks for:
   - `GROQ_API_KEY` — your Groq key (or switch `AI_PROVIDER` to `anthropic` and add `ANTHROPIC_API_KEY`)
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
   - `DATABASE_URL` — the Neon connection string
   - `ALLOWED_EMAILS` — e.g. `you@gmail.com,friend@gmail.com`
   - (`TOKEN_ENCRYPTION_KEY` is generated for you — never change it, or everyone has to reconnect Gmail)
4. When it's live, copy your address (e.g. `https://thinq.onrender.com`) and **add its callback URL to Google** (step 3 of Google setup).
5. **Invite someone**: add their Gmail to Google's **Test users** *and* to `ALLOWED_EMAILS` on Render, then send them the link. They click *Get started free* → *Sign up with Google*.

Notes:
- **Free plan sleeps** after ~15 minutes without visitors; the next visit takes about a minute to wake it. Render's paid "Starter" plan keeps it awake.
- **Own domain** (e.g. thinq.ai): add it in Render → Settings → Custom Domains, set `PUBLIC_URL=https://thinq.ai`, and add `https://thinq.ai/auth/google/callback` in Google.

## How it works

```
Browser ──▶ server.js ──▶ src/auth.js         sign-in, sessions, invite list
                     ├──▶ src/agent.js         assistant: instructions + 9 tools ──▶ Groq or Claude
                     ├──▶ src/providers/       google.js (real Gmail/Calendar) or demo.js (sample data)
                     └──▶ src/store.js + db.js per-user data in Postgres (PGlite locally)
```

- **Tools**: `search_inbox`, `read_email`, `list_events`, `find_free_time`, `draft_email`, `propose_event`, `remember`, `read_document`, `create_image`.
- **Approvals**: `draft_email` and `propose_event` only queue an item. Sending happens in `server.js` when the person clicks — the AI has no way to send. Each approval can only be sent once, even on a double click.
- **Isolation**: every database query is filtered by the signed-in person's ID; nobody can see or act on anyone else's conversations, approvals or connection.
- **Sessions**: a random token in an HttpOnly cookie (the database stores only its hash); 30 days.
- **Prompt-injection safety**: email bodies are marked as untrusted, the AI is told never to follow instructions inside them, and the approval step means a malicious email can't make Thinq send anything on its own.
- **Privacy**: when someone connects Gmail, the emails Thinq reads are sent to the AI service you chose. Check that service's data terms, and tell the people you invite.

## Before opening it to the public

- **Google verification** — to let anyone sign in (not just test users), Google must verify the app. Because Thinq reads and sends Gmail, that includes a paid third-party security assessment (CASA) and takes weeks.
- **Your website's legal pages** — `legal.html` is placeholder text; Google's review needs a real privacy policy.
- **Background jobs** (morning plan, reminders), **billing** (Stripe), **email/password sign-in**, and **an evaluation set** to check quality when you change prompts or models.
