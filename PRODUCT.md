# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Busy professionals buried in email and meetings. They use Thinq to stay on top of their own inbox, calendar and messages: planning the day, catching what needs a reply, drafting responses, finding meeting times, and handing off recurring chores. They use it on desktop and as an installable web app on their phone.

## Product Purpose

Thinq AI is a personal assistant you chat with. It reads the person's Gmail and Google Calendar (and, optionally, linked WhatsApp), answers questions about them, and drafts replies, invites and messages. Success means the person spends less time triaging and writing, and trusts Thinq enough to hand it recurring work.

## Positioning

**Works where you are.** One assistant that spans Gmail, Google Calendar, WhatsApp and Telegram group bots, plus scheduled routines that keep running without being asked again. The person doesn't move their work into a new tool; Thinq reaches into the ones they already use.

## Operating Context

- Chat is the main interface: typed messages, voice notes (transcribed for review before sending), attached documents (PDF, .docx, .txt, .md, .csv, .json, .html), and read-aloud answers.
- **Approvals panel:** drafted emails and calendar invites wait there until the person clicks *Send* or *Add to calendar*.
- **Routines tab:** scheduled tasks (once, daily, weekly, monthly, in the user's time zone). Reports to the user start right away. Messages to other people are saved as *Needs your OK* until the user turns them on.
- **Bots tab:** Telegram group bots that Thinq builds by chat. They answer only from facts written into them and post scheduled reminders.
- Push notifications and an installable web app (PWA).
- Admin dashboard for admins: activity analytics (counts only, never content) and tester requests.
- Public marketing site (`src/pages`, built by `build.py`): home, products, use cases, pricing, resources, company, contact, legal, login, and a *Help Us Test* page.

## Capabilities and Constraints

- AI runs on Groq (free) or Claude, with a fallback chain. Images and a free voice come from Cloudflare; ElevenLabs is optional for natural voice.
- Requests count toward a daily per-user limit.
- Hosted on Render's free plan with a keep-awake ping. Scheduled runs can arrive a few minutes late, and runs more than 2 hours late are skipped.
- Access is gated: Google sign-in, with approved testers or allow-listed emails.
- Not supported: WhatsApp groups (Meta API limits) and scanned PDFs.
- Stage: early beta, actively recruiting testers.

## Brand Commitments

- Name: **Thinq AI** ("Thinq").
- Voice in the product: plain, specific and honest about limits (for example, "It never sends or books anything by itself").
- Icon assets in `thinq-app/public/` (icon-192, icon-512, apple-touch-icon, badge-96).

## Evidence on Hand

- Real: the feature set above, demonstrable in the running app.
- **No real social proof exists yet.** The website's "5.0 from 24.5k+ reviews", "9,677+ Active Users", "26,900,789 tasks completed", performance stats (4× faster, 96% less manual work, 2.5× efficiency), the Northwind / Wayne Grimshaw testimonial and case study, and the customer logos (Sisyphus, Magnolia, Epicurious, Halcyon, Northwind, Quadrant) are template placeholders. Future work must not present them, or invented replacements, as real.

## Product Principles

1. **Meet people in their existing tools.** Thinq extends Gmail, Calendar, WhatsApp and Telegram rather than replacing them.
2. **The person stays in control.** Anything sent on their behalf, or to someone else, is drafted for approval first, unless they explicitly turn on unattended sending for a routine.
3. **Tell once, keep working.** Routines and memory should spare the person from repeating themselves.
4. **Honest over impressive.** State real limits, and never claim usage, reviews or results that don't exist.
5. **Privacy by default.** Keep only what is needed (document text, not files; activity counts, not content).
