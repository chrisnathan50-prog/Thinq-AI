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

- **Documents**: up to 5 per message, 10 MB each (PDF with selectable text, .docx, .txt, .md, .csv, .json, .html). Thinq keeps only the text, not the file. Long documents are split into parts the AI reads one at a time with the `read_document` tool.
- **Photos and scanned PDFs**: attach or paste a photo (receipt, whiteboard, letter, screenshot) or a PDF without a text layer, and Thinq reads the text from the picture. With Claude, the picture goes to Claude. With Groq, a Groq model that accepts images reads it. Groq retires models, so a list is tried in order (`GROQ_VISION_MODELS`, default `qwen/qwen3.8-27b`, then two Llama 4 models), and a model that no longer exists is skipped. Scanned PDFs on Groq are read one page at a time, up to `MAX_SCAN_PAGES` (default 15). The app shrinks photos to about 2000px before uploading. Each photo or scan counts as one request toward the daily limit. `VISION=off` turns this off. HEIC photos the browser can't open are refused with a hint to send a JPEG.
- **Voice notes** use Groq's free Whisper speech-to-text (`whisper-large-v3-turbo`, change with `GROQ_TRANSCRIBE_MODEL`), so they need `GROQ_API_KEY` even if you use Claude for chat. The recording is sent once to be transcribed and isn't stored. Each voice note counts as one request toward the daily limit.
- **Read aloud** tries three voices in order:
  1. **ElevenLabs** (most natural) when `ELEVENLABS_API_KEY` is set. Get the key at elevenlabs.io → Developers → API Keys; it starts with `sk_`. Change the voice with `ELEVENLABS_VOICE_ID`. ElevenLabs bills per character.
  2. **Cloudflare MeloTTS** (free) when the Cloudflare image settings are set, or when ElevenLabs is out of credits. It shares the free daily Cloudflare allowance with images but uses very little of it. Turn it off with `SPEECH_FREE_VOICE=off`, or use only it with `SPEECH_PROVIDER=cloudflare`.
  3. **The browser's built-in voice** when neither is available.

  Each read is capped at `SPEECH_MAX_CHARS` (2,500 by default) and counts toward the daily request limit. Replaying the same message doesn't cost again.

### Admin dashboard

Admins (`ADMIN_EMAILS`) get **Admin dashboard** in the ⋯ menu (`/app/admin`):

- **Analytics** for the last 7, 30 or 90 days: people, active today / last 7 days, AI requests, Gmail and WhatsApp connections; charts of active people and AI requests per day; which features get used; app vs WhatsApp; and a sortable table of every person (joined, last active, active days, requests, chats, emails/invites sent, most-used feature).
- **Tester requests** (below).

It shows activity counts only — never anyone's messages, emails or files. Days are UTC. Requests per day come from the daily usage counter, so they stay accurate even after people delete chats; the app-vs-WhatsApp split counts from when this dashboard was added.

### Finding testers ("Help Us Test")

The website has a **Help Us Test** page (`/testers.html`, linked from the home page, footer and login page). Visitors leave their name, Google email and what they'd use Thinq for; requests are saved in the database.

- Set `ADMIN_EMAILS` to your own address. Admins can always sign in and see **Tester requests** in the ⋯ menu (or go to `/app/admin`).
- **Approve** lets that person sign in right away — no need to edit `ALLOWED_EMAILS`. **Remove access** signs them out.
- If you've connected Gmail, approving also puts a ready-to-send "You're in" email in your Approvals panel, and you get a heads-up email in your inbox for each new request.
- While your Google sign-in is in *Testing*, also add each approved tester's Gmail under Google Cloud → Google Auth Platform → **Audience → Test users** (up to 100). The admin page links there and has a copy button.
- Optional `CONTACT_EMAIL` shows a "Prefer email?" link on the page. It's public, so use an address you're happy to share.
- The form has spam protection (hidden field + 5 requests per hour per visitor).

### Tasks and follow-ups

The **Tasks** tab is the person's to-do list, and Thinq keeps it with them:

- **To-dos**: "I need to send the lease back by Monday", typed in the Tasks tab or said in chat. A task with a due date gets one notification when it's due (09:00 that day if no time was given). Overdue tasks and tasks due today show as a number on the Tasks tab.
- **Waiting on others**: when Thinq drafts an email that asks someone for something, it sets *follow up if no reply in N days*. Once you send it, a "waiting on" task tracks the Gmail thread (checked about every 20 minutes). It closes by itself when they reply ("Priya replied" notification); if they don't, you're nudged on the day, and **Draft a nudge** writes the follow-up in the same thread.
- **From meetings**: action items in meeting notes that are yours (or have no clear owner) appear at the top of the Tasks tab as suggestions with **Add** / dismiss. Nothing is added unless you tap Add.
- "Plan my day" sees what's overdue, due today and what you're waiting on.

### Search

The search box in the sidebar (and Thinq itself, with `search_history`) searches past chats, meeting notes and transcripts, and the text of attached documents and photos. Every word must appear. Results show the newest first; meeting results open their notes.

### Send and Discard right from a notification

When a routine prepares a draft (an email or WhatsApp message waiting in Approvals), its notification has **Send** and **Discard** buttons on Chrome, Edge and Firefox (computer and Android). It's sent without opening Thinq, and a second notification confirms it. iPhone and Mac Safari don't show notification buttons, so tapping the notification opens Approvals instead.

### Routines: tasks on a schedule

Tell Thinq once and it keeps doing it — no need to ask every day:

- **Reports to you** — *"Every weekday at 8am, summarise my unread emails and tell me what needs a reply."* Thinq runs the task at that time and sends you the result as a notification, in a chat called *Routine: …*, and (if you ask) as an email to yourself. These start right away.
- **Messages to someone else** — *"Every day at 9pm, send Mum a goodnight message on WhatsApp"* or a weekly email. These are saved as **Needs your OK**: you open the **Routines** tab and tap **Turn on**, which shows exactly who gets what and when. The AI can't turn a routine on. Fixed text then goes out by itself; if Thinq writes the message fresh each time, each one waits in Approvals unless you tick *Send without asking me*. Changing the recipient or the message needs your OK again.

Schedules: once, daily, weekly (any weekdays) or monthly, in your time zone. Manage them in the Routines tab (Turn on, Run now, Pause, Delete) or by asking Thinq ("move my summary to 7:30"). Each run counts as one AI request. WhatsApp messages go from your own number through the linked WhatsApp (see *WhatsApp chat sync*); email goes from your Gmail. Like reminders, a run more than 2 hours late (server asleep) is skipped.

### Group bots for Telegram (free, optional)

People can ask Thinq to **build them a bot** for a Telegram group: *"Build a bot for my running club group that answers questions about our runs and reminds everyone every Friday at 6pm."* Thinq writes the bot's facts and reminders; the person adds it to their group and links it with a code. In the group the bot:

- answers questions — `/ask …`, a reply to one of its messages, or an @mention — **only from the facts written into it** (it never sees the owner's email, calendar or documents);
- posts reminders on schedule (once, daily, weekly or monthly, in the owner's time zone);
- has admin commands: `/link CODE`, `/pause`, `/resume`, `/unlink`; anyone can use `/reminders` and `/help`.

People manage their bots in the app's **Bots** tab (link a group, pause, delete reminders) or just by asking Thinq ("move the Friday reminder to 7pm"). Answers count toward the owner's daily request limit, and each group gets at most 30 answers an hour.

**Setup** (5 minutes): in Telegram, message **@BotFather** → `/newbot` → pick a name and a username ending in `bot` → copy the token it gives you into Render as `TELEGRAM_BOT_TOKEN`. Thinq registers its webhook by itself on startup. Optional: in @BotFather, `/setprivacy` → *Disable* lets @mentions work (otherwise members use `/ask` or reply to the bot). One Telegram bot serves everyone's group bots — each group shows the bot it's linked to.

Reminders need the server awake: the keep-awake ping (GitHub Action + self-ping) handles that on Render's free plan, though a reminder can arrive a few minutes late after the server wakes up; one more than 2 hours late is skipped.

WhatsApp groups aren't supported: Meta's official API only allows groups a business creates itself (max 8 people, Official Business Account required).

### WhatsApp (optional)

People can chat with Thinq on WhatsApp through Meta's official **WhatsApp Cloud API**. Each person links their number once: in the app, *Connect WhatsApp* shows a 6-digit code that they send to Thinq's WhatsApp number. After that they can:

- chat, send **voice notes**, and send **documents** (PDF, Word, text);
- **forward** a message from any chat and ask "what should I reply?";
- share a **chat export** (in a chat: ⋯ → More → Export chat → Thinq) and ask for a summary — exports also work as attachments in the web app;
- ask for **images**;
- approve drafts and invites with **Send / Discard** buttons — still nothing is sent without a tap;
- send *new* to start a fresh conversation, *help* for tips.

This bot only sees what people send or forward to it. Reading people's own chats is a separate opt-in feature: see *WhatsApp chat sync* below.

**Setup** (about 30 minutes, free to start):

1. <https://developers.facebook.com> → **My Apps → Create app** → use case **Connect with customers through WhatsApp** (type *Business*). Link or create a Meta Business portfolio when asked.
2. **WhatsApp → API Setup**: Meta gives you a free **test number**. Note the **Phone number ID**, click **Generate access token** (lasts 24 h — fine for testing), and under *To*, add up to 5 people's WhatsApp numbers who may test it.
3. **App settings → Basic**: copy the **App secret**.
4. In Render → Environment add `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` (any long random string you make up) and `WHATSAPP_NUMBER` (the test number, digits only).
5. **WhatsApp → Configuration → Webhook → Edit**: Callback URL `https://YOUR-APP.onrender.com/webhooks/whatsapp`, Verify token = the same `WHATSAPP_VERIFY_TOKEN`. Then **Manage** webhook fields and subscribe to **messages**.
6. In the Thinq app, click **Connect WhatsApp**.

For real use: add your own phone number (one not already on WhatsApp) in WhatsApp → API Setup, and replace the 24-hour token with a permanent **System User** token (Business settings → Users → System users → Generate token with `whatsapp_business_messaging` and `whatsapp_business_management`).

Cost: messages people send are free; each Thinq number gets 1,000 free replies a month, then roughly a cent each depending on the country. Thinq can only reply within 24 hours of someone's last message (it never messages people first).

### WhatsApp chat sync (unofficial, opt-in)

People can let Thinq read their **own** WhatsApp chats, so they can ask "what did I miss on WhatsApp today?", "what did Sam say about Friday?" or "summarize the Family group this week", the same way Thinq reads Gmail and Calendar. It works without the Meta setup above.

In the app, **Link WhatsApp chats** shows a warning, then a QR code to scan in WhatsApp → *Settings → Linked devices → Link a device*. People using Thinq on their phone choose *I'm on my phone* and get a pairing code to type instead. Thinq then shows up as a linked device, like WhatsApp Web.

- **Reads, and sends only what you approve.** Thinq saves the text of new and recent messages (photos, voice notes etc. show as `[photo]`, `[voice note]`) and has assistant tools to list, search and read chats (`whatsapp_recent_chats`, `search_whatsapp`, `read_whatsapp_chat`). `draft_whatsapp` writes a text message to an existing chat; like email drafts it waits in Approvals (or as a Send / Discard message from the Thinq bot) and only goes out when the person taps Send. Thinq never reacts, marks messages as read or shows the person as online.
- **Stored:** the linked-device keys (encrypted with `TOKEN_ENCRYPTION_KEY`) and message text from the last `WA_SYNC_KEEP_DAYS` days (default 90). **Disconnect & delete** logs Thinq out of WhatsApp and deletes everything.
- **Risks.** WhatsApp has no official API for this, so it uses the unofficial [Baileys](https://github.com/WhiskeySockets/Baileys) library. It isn't allowed by WhatsApp's terms: **WhatsApp can restrict or ban numbers that use it**, and a WhatsApp update can break it. The app tells people this before they link. Turn the feature off with `WHATSAPP_SYNC=off`.
- **Hosting:** the server keeps one live connection per linked person. On Render's free plan the server sleeps when idle, so messages that arrive while it sleeps can be missed (WhatsApp sends some recent history again when it reconnects). For reliable sync, use an always-on plan.

### Meeting notes (free)

**Record a meeting** in the browser and Thinq writes the notes: summary, decisions, action items, open questions and key points. It's in **Connections → Meeting notes** and needs only `GROQ_API_KEY` (Groq's free Whisper does the transcription).

- **What's recorded:** the microphone, and on desktop Chrome or Edge, optionally a meeting tab's sound too (Google Meet, Zoom or Teams open in the browser). Chrome asks which tab to share; pick the meeting and keep *Share tab audio* on. That way the other people in the call are heard even with headphones. Phones and Safari record the microphone only.
- **How it works:** the browser sends the audio in 5-minute pieces, and each piece is transcribed as soon as it arrives. The audio is deleted once it's turned into text; only the transcript and notes are kept. Long meetings (up to 4 hours) work, and if the tab closes mid-meeting, whatever was already sent still becomes notes after about 12 minutes.
- **Afterwards:** the meeting appears in Meeting notes (View notes, full transcript, delete), and people can ask Thinq about it ("what did we decide about the launch date?", "draft the follow-up email").
- **Who said what:** with *Also record a meeting tab's sound* on, your microphone and the meeting tab are recorded as two separate tracks. The transcript labels your lines with your first name and everyone else's as *Others in the call*, merged in time order with Whisper timestamps. If you're on speakers rather than headphones, the call's sound picked up by your microphone is dropped. Whisper can't tell different voices apart within one track, so the people on the call share one label, and microphone-only recordings (one room) have no speaker names.
- **Limits:** the notes only name an action's owner when it's clear (you, or a name mentioned in the words). Groq's free tier transcribes about 2 hours of audio per hour; pieces that hit the limit are retried automatically. Each person can record up to `RECORDINGS_PER_DAY` meetings a day (default 10).
- **Consent:** the app reminds people to tell everyone in the meeting they're being recorded.

#### Optional: a notetaker bot that joins calls

Thinq can also send a notetaker bot into **Google Meet, Zoom and Microsoft Teams** calls. It joins as "*Name*'s Thinq Notetaker", posts a message in the meeting chat so everyone knows they're being transcribed, and Thinq saves the transcript split by speaker. This needs a self-hosted Attendee server (below); without `ATTENDEE_URL` the bot options stay hidden.

- **Sending it:** paste a meeting link in *Meeting notes*, or ask Thinq ("send the notetaker to my 3pm"). When Thinq suggests it, it waits in Approvals until you tap *Send notetaker*.
- **Auto-join** (optional, per person): sends the notetaker to every calendar meeting that has a Meet, Zoom or Teams link, a minute before it starts.
- **Free transcription:** the notetaker reads the meeting's own live captions, so there is no transcription bill and no audio or video is recorded. Captions are a little less accurate than a paid speech-to-text service. To use one instead, set `ATTENDEE_TRANSCRIPTION` to Attendee's transcription settings as JSON, e.g. `{"deepgram":{"language":"en-US"}}` (Deepgram gives $200 of free credit), and add that provider's key in Attendee.
- **Privacy:** once Thinq has the transcript, it asks Attendee to delete its copy. Deleting a meeting in Thinq deletes its notes and transcript.
- **Limits:** someone in the meeting may have to let the notetaker in from the waiting room, and meetings restricted to one company's accounts may not let it in at all. Thinq shows why when it couldn't join.

**Setup.** The notetaker is [Attendee](https://github.com/attendee-labs/attendee), an open-source meeting-bot server you host yourself. Each bot is a real browser, so it needs an always-on machine with about 2 GB of memory per meeting happening at the same time — Render's free plan is too small. A free option:

1. Create an **Oracle Cloud "Always Free"** account and an *Ampere A1* VM (up to 4 CPUs / 24 GB free) with Ubuntu. Open ports 80 and 443.
2. Point a domain or subdomain (e.g. `bots.yourdomain.com`) at the VM — Attendee's webhooks and Google Meet need HTTPS.
3. On the VM: install Docker, then follow Attendee's self-hosting guide (`docker compose` with Postgres and Redis), and put Caddy or nginx in front of it for HTTPS.
4. Open Attendee in a browser, create an account, and copy an **API key** from *API Keys*.
5. In Render → Environment add `ATTENDEE_URL` (e.g. `https://bots.yourdomain.com`) and `ATTENDEE_API_KEY`. Optional: `MEETINGS_LANGUAGE` (caption language, default `en-US`).
6. Zoom meetings also need Zoom OAuth credentials in Attendee's *Settings* (see Attendee's Zoom guide). Meet and Teams work without them.

Thinq tells Attendee to call `https://YOUR-APP/webhooks/attendee` when a bot changes state; Thinq treats that only as a hint and re-checks the bot through the API, and also checks active meetings every minute, so nothing is lost while the Render server is asleep.

### Notifications and reminders (free)

People can turn on notifications in **Connections → Notifications**. Then Thinq can:

- **Remind them**: "remind me at 2:27 to join the call", "remind me 3 minutes before my 2:30 meeting".
- **Tell them when an email arrives**: "tell me when Sam's email comes in and what time the meeting is". Thinq checks Gmail about every minute (for up to 7 days by default). When the email arrives, it reads it and puts the answer in the notification and in the chat.
- **Give calendar heads-ups** 5–30 minutes before each event, and say when **meeting notes are ready**. Both can be turned off.
- Optionally send a copy to their Thinq WhatsApp chat.

How it works: standard Web Push (the `web-push` library). The browser runs `public/sw.js`, which shows notifications even when Thinq is closed. Nothing to sign up for:
- The server's push keys (VAPID) are created on first start and stored encrypted in the database. You can set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` instead. Changing keys turns off everyone's notifications until they turn them on again.

Works in Chrome, Edge and Firefox (desktop and Android) and Safari on Mac. **On iPhone/iPad (iOS 16.4+), people must first add Thinq to their Home Screen** (Share → Add to Home Screen) and open it from there. The pane explains this.

**Keeping the server awake.** Render's free plan sleeps the server after about 15 minutes without visitors, and a sleeping server can't send reminders. Two things keep it awake:
1. In production the server visits its own `/healthz` every 10 minutes (`KEEP_AWAKE=off` turns this off).
2. A GitHub Action (`.github/workflows/keep-awake.yml`) visits `https://thinq.onrender.com/healthz` every 5 minutes. This wakes the server after a deploy or crash. Change the URL there if your address changes.

One always-on free service uses about 730 of Render's 750 free hours a month, so don't run a second free service on the same account. For guaranteed uptime, use a paid instance.

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
6. **Log out / delete chats** — the ⋯ menu next to your name has *Log out* and *Delete all chats*. Hover a chat in the list for its trash button. Deleting a chat also removes its attached documents and images; drafts waiting in Approvals stay.
7. **Personal starter questions** — a new chat suggests questions built from your own inbox, calendar and saved preferences (your next meeting, who's waiting on a reply, unread count, time of day). They come straight from your data, without an AI call, and refresh every few minutes.

### When the free AI is busy

Groq's free tier allows about 8,000 tokens a minute **per model**, and one Thinq request is 3,000–4,000 — so on its own it handles only a couple of messages a minute for everyone. Thinq therefore tries a chain and moves on the moment one is busy: Groq `gpt-oss-120b` → Groq `gpt-oss-20b` → Groq `qwen3.8-27b` → **Cloudflare Workers AI** (`glm-4.7-flash`, using the same `CLOUDFLARE_*` settings as images; roughly 200 extra requests a day, shared with images) → Mistral / OpenRouter if you add their keys. A busy service is skipped until its wait is over. Admins can see the chain and test each service under **Admin dashboard → AI services → Check them now**. On Groq, Thinq also only sends the tools a message needs, to stay under the per-request limit.

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
| Model | `openai/gpt-oss-120b` (change with `GROQ_MODEL`; switches to `openai/gpt-oss-20b` when the free per-minute limit is hit, set with `GROQ_FALLBACK_MODEL`) | Claude Opus 5.5 (change with `THINQ_MODEL`) |
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
                     ├──▶ src/agent.js         assistant: instructions + 9 tools; src/whatsapp.js for WhatsApp ──▶ Groq or Claude
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
