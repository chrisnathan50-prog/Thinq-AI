// Thinq AI - one server for the website and the app.
//   /            the marketing website (../thinq-site), including /login.html
//   /app         the assistant (./public) - signed-in users only
//   /api/...     the app's data and chat (per user)
//   /auth/...    Google sign-in, connecting Gmail & Calendar, log out
import * as bots from "./src/bots.js";
import * as routines from "./src/routines.js";
import * as tasks from "./src/tasks.js";
import { searchEverything } from "./src/search.js";
import { attention, markRead } from "./src/attention.js";
import { mountTelegram, startTelegram, telegramConfigured, botUsername } from "./src/telegram.js";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, query } from "./src/db.js";
import * as store from "./src/store.js";
import { hasApiKey, apiKeyName, MODEL, AI_PROVIDER } from "./src/agent.js";
import { providerFor } from "./src/providers/index.js";
import { googleConfigured, publicUrl, redirectUri } from "./src/providers/google.js";
import { attachUser, requireUser, mountAuth } from "./src/auth.js";
import { extractDocument, DocumentError, acceptedTypes, MAX_UPLOAD_BYTES, partCount } from "./src/documents.js";
import { transcribe, voiceAvailable, MAX_AUDIO_BYTES } from "./src/llm/transcribe.js";
import { imagesAvailable, IMAGE_DAILY_LIMIT } from "./src/llm/images.js";
import { speechAvailable, liveServerVoice, liveFreeOnly, synthesize, trimForSpeech } from "./src/llm/speech.js";
import { Readable } from "node:stream";
import { suggestionsFor } from "./src/suggestions.js";
import { friendlyError } from "./src/errors.js";
import { chatTurn, TurnError, busy, DAILY_LIMIT } from "./src/turns.js";
import { approveItem, declineItem } from "./src/approvals.js";
import { mountWhatsApp, whatsappConfigured, whatsappNumber, linkUrl } from "./src/whatsapp.js";
import { mountTesters, loadApprovedTesters, isAdmin } from "./src/testers.js";
import { syncAvailable, syncState, startSync, cancelSync, disconnectSync, resumeAllSyncs, stopAllSyncs } from "./src/whatsapp-sync.js";
import * as meetings from "./src/meetings.js";
import * as recordings from "./src/recordings.js";
import * as notifier from "./src/notify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = process.env.SITE_DIR || path.resolve(here, "..", "thinq-site");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");

await initDb();
await loadApprovedTesters();

const app = express();
app.set("trust proxy", 1); // behind Render's proxy, so secure cookies work
app.disable("x-powered-by");
// Keep the raw bytes of WhatsApp webhook calls so their signature can be checked.
app.use(express.json({ limit: "200kb", verify: (req, res, buf) => { if (req.originalUrl.startsWith("/webhooks/")) req.rawBody = buf; } }));

// Basic security headers.
app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "DENY" });
  next();
});

// Block cross-site requests: state-changing calls must come from this site's own pages.
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const origin = req.get("origin");
  if (origin && new URL(origin).host !== req.get("host")) return res.status(403).json({ error: "Cross-site request blocked" });
  next();
});

app.get("/healthz", (req, res) => res.json({ ok: true }));
mountWhatsApp(app); // Meta calls this directly - no Thinq sign-in
mountTelegram(app); // Telegram calls this directly (checked with a secret header)
meetings.mountMeetings(app); // Attendee (the meeting notetaker) calls this - no Thinq sign-in
app.use(attachUser);
mountAuth(app);
mountTesters(app); // website tester form + admin tester list

const validTz = (tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "UTC"; } };

// ---------- the app (signed in only) ----------
app.get(["/app", "/app/"], requireUser, (req, res) => res.sendFile(path.join(here, "public", "index.html")));
app.get("/app/admin", requireUser, (req, res) => (isAdmin(req.user.email) ? res.sendFile(path.join(here, "public", "admin.html")) : res.redirect("/app")));
// The notification service worker: allowed to cover /app itself (not just /app/...), and never cached.
app.get("/app/sw.js", (req, res) => {
  res.set({ "Service-Worker-Allowed": "/app", "Cache-Control": "no-cache" });
  res.sendFile(path.join(here, "public", "sw.js"));
});
app.use("/app", express.static(path.join(here, "public"), { index: false }));

// ---------- app state ----------
const api = express.Router();
api.use(requireUser);

api.get("/state", async (req, res) => {
  const p = await providerFor(req.user);
  res.json({
    user: { name: req.user.name, email: req.user.email, picture: req.user.picture, tourDone: Boolean(req.user.tour_done_at) },
    mode: p.mode,
    profile: await p.profile().catch(() => null),
    googleConfigured: googleConfigured(),
    hasApiKey: hasApiKey(),
    apiKeyName: apiKeyName(),
    aiProvider: AI_PROVIDER,
    model: MODEL,
    usage: { today: await store.usageToday(req.user.id), limit: DAILY_LIMIT },
    voiceAvailable: voiceAvailable(),
    attention: await attention(req.user.id, validTz(req.get("x-time-zone"))).catch(() => null),
    telegram: telegramConfigured() ? { username: botUsername() } : null,
    admin: isAdmin(req.user.email) ? { pendingTesters: (await store.listTesters()).filter((t) => t.status === "pending").length } : null,
    speechAvailable: speechAvailable(),
    liveVoice: { available: voiceAvailable(), serverVoice: liveServerVoice() }, // live voice mode (hearing needs Groq)
    whatsapp: await whatsappState(req.user.id),
    whatsappSync: await syncState(req.user.id),
    meetings: await meetingsState(req.user.id),
    notifications: await notifyState(req.user.id).catch(() => null),
    images: { available: imagesAvailable(), today: await store.imagesToday(req.user.id), limit: IMAGE_DAILY_LIMIT },
    documentTypes: acceptedTypes(),
    conversations: await store.listConversations(req.user.id),
    approvals: await store.listApprovals(req.user.id),
    notes: await store.listNotes(req.user.id),
  });
});

// The welcome tour: shown once to each person (on any device) until they finish or skip it.
api.post("/tour", async (req, res) => {
  const done = req.body?.done !== false;
  await query(`update users set tour_done_at = ${done ? "now()" : "null"} where id = $1`, [req.user.id]);
  if (done) await store.logAction(req.user.id, "tour_done", { step: String(req.body?.step || "").slice(0, 20) });
  res.json({ ok: true });
});
api.post("/conversations", async (req, res) => res.json(await store.createConversation(req.user.id)));
api.delete("/conversations/:id", async (req, res) => {
  const ok = await store.deleteConversation(req.user.id, req.params.id);
  if (ok) await store.logAction(req.user.id, "conversation_deleted", { id: req.params.id });
  ok ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
});
api.delete("/conversations", async (req, res) => {
  const n = await store.deleteAllConversations(req.user.id);
  await store.logAction(req.user.id, "all_conversations_deleted", { count: n });
  res.json({ ok: true, deleted: n });
});
api.get("/suggestions", async (req, res) => {
  try {
    res.json({ suggestions: await suggestionsFor(req.user, validTz(req.query.tz)) });
  } catch (err) {
    console.error(err);
    res.json({ suggestions: [] });
  }
});
api.get("/conversations/:id", async (req, res) => {
  const c = await store.getConversation(req.user.id, req.params.id);
  if (c) await markRead(req.user.id, c.id); // opening a chat clears its "new result" dot
  c ? res.json(c) : res.status(404).json({ error: "Not found" });
});

// ---------- chat (Server-Sent Events) ----------
api.post("/chat", async (req, res) => {
  const { conversationId, text } = req.body || {};
  const attachmentIds = Array.isArray(req.body?.attachments) ? req.body.attachments.map(String).slice(0, 5) : [];
  const timeZone = validTz(req.body?.timeZone);
  const conversation = await store.getConversation(req.user.id, conversationId);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });
  if (typeof text !== "string" || !text.trim() || text.length > 8000) return res.status(400).json({ error: "Please type a message (up to 8,000 characters)." });
  if (busy.has(req.user.id)) return res.status(409).json({ error: "Thinq is still working on your last message." });
  const attachments = await store.ownedDocuments(req.user.id, attachmentIds);

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  try {
    const channel = req.body?.channel === "voice" ? "voice" : "app"; // live voice mode: short spoken replies
    const reply = await chatTurn({ user: req.user, conversationId, text: text.trim(), timeZone, attachments, channel, onStatus: (t) => send({ type: "status", text: t }) });
    send(reply);
  } catch (err) {
    if (!(err instanceof TurnError)) console.error(err);
    send({ type: "error", text: err instanceof TurnError ? err.message : friendlyError(err) });
  } finally {
    res.end();
  }
});


// ---------- documents ----------
const rawBody = (limit) => express.raw({ type: () => true, limit });
api.post("/documents", rawBody(MAX_UPLOAD_BYTES + 1024), async (req, res) => {
  const name = decodeURIComponent(String(req.get("x-filename") || "document")).replace(/[\\/\u0000-\u001f]/g, " ").trim() || "document";
  try {
    // Reading a photo or scanned PDF uses the AI, so it counts as one request toward the daily limit.
    const looksLikePicture = /\.(jpe?g|png|webp|gif)$/i.test(name) || /^image\//.test(req.get("content-type") || "") ;
    if (looksLikePicture && DAILY_LIMIT && (await store.usageToday(req.user.id)) >= DAILY_LIMIT) return res.status(429).json({ error: `You've used today's ${DAILY_LIMIT} requests. Your limit resets tomorrow.` });
    const out = await extractDocument(name, req.body);
    if (out.ocr) await store.useRequest(req.user.id, 0);
    const doc = await store.addDocument(req.user.id, { name, sizeBytes: req.body.length, pages: out.pages, text: out.text });
    await store.logAction(req.user.id, "document_added", { id: doc.id, name, chars: out.chars, ocr: out.ocr || undefined });
    res.json({ ...doc, parts: partCount(out.chars), truncated: out.truncated });
  } catch (err) {
    if (err instanceof DocumentError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Couldn't read that file. Try again or use a different format." });
  }
});
api.delete("/documents/:id", async (req, res) => { await store.deleteDocument(req.user.id, req.params.id); res.json({ ok: true }); });

// ---------- WhatsApp linking ----------
async function whatsappState(userId) {
  if (!whatsappConfigured()) return { available: false };
  const link = await store.whatsappLinkForUser(userId);
  return { available: true, number: whatsappNumber(), chatUrl: whatsappNumber() ? `https://wa.me/${whatsappNumber()}` : null,
    linked: link ? { number: `+${link.wa_id.slice(0, -4).replace(/\d/g, "•")}${link.wa_id.slice(-4)}`, name: link.name, since: link.linked_at } : null };
}
api.post("/whatsapp/code", async (req, res) => {
  if (!whatsappConfigured()) return res.status(400).json({ error: "WhatsApp isn't set up on this server yet." });
  const code = await store.createWhatsAppCode(req.user.id, validTz(req.body?.timeZone));
  res.json({ code, url: whatsappNumber() ? linkUrl(code) : null, number: whatsappNumber(), expiresInMinutes: 10 });
});
api.delete("/whatsapp", async (req, res) => {
  await store.unlinkWhatsApp(req.user.id);
  await store.logAction(req.user.id, "whatsapp_unlinked", {});
  res.json({ ok: true });
});

// ---------- WhatsApp chat sync (Thinq reads your own chats as a linked device) ----------
api.get("/whatsapp-sync", async (req, res) => res.json(await syncState(req.user.id)));
api.post("/whatsapp-sync", async (req, res) => {
  if (req.body?.accept !== true) return res.status(400).json({ error: "Please confirm you understand the risks first." });
  try {
    await store.logAction(req.user.id, "whatsapp_sync_started", { method: req.body?.phone ? "code" : "qr" });
    res.json(await startSync(req.user.id, { phone: req.body?.phone }));
  } catch (err) {
    console.error("[wa-sync] start failed:", err.message);
    res.status(400).json({ error: err.message || "Couldn't start WhatsApp linking. Try again." });
  }
});
api.post("/whatsapp-sync/cancel", async (req, res) => { await cancelSync(req.user.id); res.json(await syncState(req.user.id)); });
api.delete("/whatsapp-sync", async (req, res) => {
  await disconnectSync(req.user.id);
  await store.logAction(req.user.id, "whatsapp_sync_disconnected", {});
  res.json({ ok: true });
});

// ---------- notifications (Web Push), reminders and email alerts ----------
async function notifyState(userId) {
  return { publicKey: await notifier.publicKey(), ...(await notifier.channels(userId)), prefs: await notifier.getPrefs(userId), items: await notifier.listItems(userId), whatsappLinked: Boolean(await store.whatsappLinkForUser(userId)) && whatsappConfigured() };
}
const notifyErr = (res, err) => {
  if (!err?.userFacing) console.error("[notify]", err);
  res.status(400).json({ error: err?.userFacing ? err.message : "Something went wrong with notifications. Try again." });
};
api.get("/notifications", async (req, res) => {
  try { res.json(await notifyState(req.user.id)); } catch (err) { notifyErr(res, err); }
});
api.post("/notifications/subscribe", async (req, res) => {
  try {
    await notifier.subscribe(req.user.id, req.body?.subscription, req.get("user-agent"));
    await store.logAction(req.user.id, "notifications_on", {});
    res.json(await notifyState(req.user.id));
  } catch (err) { notifyErr(res, err); }
});
api.post("/notifications/unsubscribe", async (req, res) => {
  await notifier.unsubscribe(req.user.id, req.body?.endpoint);
  res.json(await notifyState(req.user.id));
});
api.post("/notifications/test", async (req, res) => {
  try {
    const n = await notifier.notify(req.user.id, { title: "Thinq notifications are on", body: "This is how reminders and alerts will look.", tag: "test" }, "test");
    n ? res.json({ ok: true, reached: n }) : res.status(400).json({ error: "No device has notifications on yet." });
  } catch (err) { notifyErr(res, err); }
});
api.put("/notifications/settings", async (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const k of ["calendar", "meetings", "whatsapp"]) if (typeof b[k] === "boolean") patch[k] = b[k];
  if (b.calendarMinutes != null) patch.calendarMinutes = Number(b.calendarMinutes);
  await notifier.setPrefs(req.user.id, patch);
  res.json(await notifyState(req.user.id));
});
api.delete("/reminders/:id", async (req, res) => {
  (await notifier.cancelItem(req.user.id, req.params.id)) ? res.json(await notifyState(req.user.id)) : res.status(404).json({ error: "Not found" });
});

// ---------- meeting notes (Thinq's notetaker bot in Meet / Zoom / Teams calls) ----------
// Meeting notes come from two places: recordings made in the browser (needs GROQ_API_KEY), and the optional
// notetaker bot (needs an Attendee server: ATTENDEE_URL + ATTENDEE_API_KEY).
async function meetingsState(userId) {
  const bot = meetings.meetingsConfigured(), record = recordings.recordingAvailable();
  if (!bot && !record) return { available: false };
  return { available: true, bot, record, ...(bot ? await meetings.getPrefs(userId) : { autoJoin: false }), meetings: await meetings.listMeetings(userId, 12) };
}
api.post("/recordings", async (req, res) => {
  try { res.json(await recordings.startRecording(req.user.id, { title: req.body?.title, withTab: req.body?.withTab === true, separate: req.body?.separate === true })); }
  catch (err) { meetingErr(res, err); }
});
api.post("/recordings/:id/segments", rawBody(recordings.MAX_SEGMENT_BYTES + 1024), async (req, res) => {
  try {
    res.json(await recordings.addSegment(req.user.id, req.params.id, {
      n: Number(req.query.n), offsetMs: Number(req.query.offset) || 0, mime: req.get("content-type"), audio: req.body, track: String(req.query.track || "mixed"),
    }));
  } catch (err) { meetingErr(res, err); }
});
api.post("/recordings/:id/finish", async (req, res) => {
  try { res.json(await recordings.finishRecording(req.user.id, req.params.id)); } catch (err) { meetingErr(res, err); }
});
api.delete("/recordings/:id", async (req, res) => {
  (await recordings.cancelRecording(req.user.id, req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
});
const meetingErr = (res, err) => {
  if (!err?.userFacing) console.error("[meetings]", err);
  res.status(400).json({ error: err?.userFacing ? err.message : "Something went wrong with the notetaker. Try again." });
};
api.get("/meetings", async (req, res) => res.json(await meetingsState(req.user.id)));
api.get("/meetings/:id", async (req, res) => {
  const m = await meetings.getMeeting(req.user.id, req.params.id);
  m ? res.json(m) : res.status(404).json({ error: "Not found" });
});
api.post("/meetings", async (req, res) => {
  try { res.json(await meetings.sendNotetaker(req.user, { meetingUrl: String(req.body?.meetingUrl || ""), title: req.body?.title })); }
  catch (err) { meetingErr(res, err); }
});
api.post("/meetings/:id/stop", async (req, res) => {
  try { res.json(await meetings.stopNotetaker(req.user.id, req.params.id)); } catch (err) { meetingErr(res, err); }
});
api.post("/meetings/:id/summarize", async (req, res) => {
  const m = await meetings.getMeeting(req.user.id, req.params.id);
  if (!m?.hasTranscript) return res.status(404).json({ error: "No transcript to summarize." });
  meetings.summarize(m.id).catch(() => {});
  res.json({ ok: true });
});
api.delete("/meetings/:id", async (req, res) => {
  (await meetings.deleteMeeting(req.user.id, req.params.id)) ? res.json({ ok: true }) : res.status(404).json({ error: "Not found" });
});
api.put("/meetings/settings", async (req, res) => {
  if (!meetings.meetingsConfigured()) return res.status(400).json({ error: "Meeting notes aren't set up on this server yet." });
  await meetings.setPrefs(req.user.id, { autoJoin: req.body?.autoJoin === true });
  await store.logAction(req.user.id, "meetings_auto_join", { on: req.body?.autoJoin === true });
  res.json(await meetingsState(req.user.id));
});

// ---------- routines (tasks on a schedule) ----------
const routineErr = (res, err) => (err instanceof routines.RoutineError || err.userFacing || err instanceof TurnError ? res.status(400).json({ error: err.message }) : (console.error(err), res.status(500).json({ error: friendlyError(err) })));
api.get("/routines", async (req, res) => res.json({ routines: await routines.listRoutines(req.user.id) }));
// Just the counts, for keeping the app icon and tab title up to date without reloading everything.
api.get("/attention", async (req, res) => res.json(await attention(req.user.id, validTz(req.get("x-time-zone")))));
// Turning a routine on is only ever done here, by the user's own click - the AI has no tool for it.
api.post("/routines/:id/on", async (req, res) => {
  try { res.json(await routines.turnOn(req.user.id, req.params.id, { autoSend: req.body?.autoSend === true })); } catch (err) { routineErr(res, err); }
});
api.patch("/routines/:id", async (req, res) => {
  try { res.json(await routines.updateRoutine(req.user.id, req.params.id, { paused: req.body?.paused === true ? true : req.body?.paused === false ? false : undefined })); } catch (err) { routineErr(res, err); }
});
api.post("/routines/:id/run", async (req, res) => {
  try { res.json({ result: await routines.runNow(req.user.id, req.params.id) }); } catch (err) { routineErr(res, err); }
});
api.delete("/routines/:id", async (req, res) => { await routines.deleteRoutine(req.user.id, req.params.id); res.json({ ok: true }); });

// ---------- search (sidebar): past chats, meeting notes, documents ----------
api.get("/search", async (req, res) => {
  const q = String(req.query.q || "").slice(0, 200);
  res.json({ results: await searchEverything(req.user.id, q, { limit: 30 }) });
});

// ---------- tasks and follow-ups ----------
const taskErr = (res, err) => (err instanceof tasks.TaskError ? res.status(400).json({ error: err.message }) : (console.error(err), res.status(500).json({ error: friendlyError(err) })));
api.get("/tasks", async (req, res) => {
  const tz = validTz(req.get("x-time-zone"));
  res.json({ tasks: await tasks.listTasks(req.user.id), today: tasks.localDate(tz) });
});
api.post("/tasks", async (req, res) => {
  const b = req.body || {};
  try {
    res.json(await tasks.addTask(req.user.id, { title: b.title, notes: b.notes, kind: b.kind === "waiting" ? "waiting" : "todo", person: b.person,
      dueDate: b.dueDate || null, dueTime: b.dueTime || null, timeZone: validTz(req.get("x-time-zone")), source: "you" }));
  } catch (err) { taskErr(res, err); }
});
api.patch("/tasks/:id", async (req, res) => {
  const b = req.body || {}, patch = {};
  for (const k of ["title", "notes", "status", "dueDate", "dueTime", "person"]) if (k in b) patch[k] = b[k];
  try { res.json(await tasks.updateTask(req.user.id, req.params.id, patch)); } catch (err) { taskErr(res, err); }
});
api.delete("/tasks/:id", async (req, res) => { await tasks.deleteTask(req.user.id, req.params.id); res.json({ ok: true }); });

// ---------- group bots (built by chatting with Thinq; live in Telegram groups) ----------
const botErr = (res, err) => (err instanceof bots.BotError ? res.status(400).json({ error: err.message }) : (console.error(err), res.status(500).json({ error: "Something went wrong." })));
api.get("/bots", async (req, res) => res.json({ bots: await bots.listBots(req.user.id), telegram: { available: telegramConfigured(), username: botUsername() } }));
api.post("/bots/:id/link-code", async (req, res) => {
  try { res.json({ code: await bots.createLinkCode(req.user.id, req.params.id), username: botUsername(), expiresInMinutes: 30 }); } catch (err) { botErr(res, err); }
});
api.patch("/bots/:id", async (req, res) => {
  try { res.json(await bots.updateBot(req.user.id, req.params.id, { status: req.body?.paused === true ? "paused" : req.body?.paused === false ? "active" : undefined })); } catch (err) { botErr(res, err); }
});
api.delete("/bots/:id", async (req, res) => { await bots.deleteBot(req.user.id, req.params.id); res.json({ ok: true }); });
api.delete("/bots/:id/reminders/:rid", async (req, res) => { await bots.deleteReminder(req.user.id, req.params.id, req.params.rid); res.json({ ok: true }); });
api.delete("/bots/:id/groups/:chatId", async (req, res) => { await bots.unlinkGroupForUser(req.user.id, req.params.id, req.params.chatId); res.json({ ok: true }); });

// ---------- generated images ----------
api.get("/images/:id", async (req, res) => {
  const img = await store.getImage(req.user.id, req.params.id);
  if (!img) return res.status(404).json({ error: "Not found" });
  res.set({ "Content-Type": img.mime, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
  if (req.query.download) res.attachment(`thinq-${req.params.id}.${img.mime.split("/")[1].replace("jpeg", "jpg")}`);
  res.send(img.data);
});

// ---------- voice notes ----------
api.post("/transcribe", rawBody(MAX_AUDIO_BYTES), async (req, res) => {
  if (!voiceAvailable()) return res.status(400).json({ error: "Voice notes aren't set up on this server (it needs GROQ_API_KEY)." });
  if (!req.body?.length || req.body.length < 1000) return res.status(400).json({ error: "That recording was too short. Hold on a little longer and try again." });
  // Live voice mode: hearing you is part of one spoken exchange, which counts once (when Thinq answers). It still
  // needs requests left today, and has its own daily cap so it can't be used as unlimited free transcription.
  const live = req.query.live === "1";
  if (live) {
    if (DAILY_LIMIT && (await store.usageToday(req.user.id)) >= DAILY_LIMIT) return res.status(429).json({ error: `You've used today's ${DAILY_LIMIT} requests. Your limit resets tomorrow.` });
    if (!liveHearing(req.user.id)) return res.status(429).json({ error: "That's a lot of talking for one day. Voice mode will be back tomorrow." });
  } else {
    const usage = await store.useRequest(req.user.id, DAILY_LIMIT);
    if (!usage.allowed) return res.status(429).json({ error: `You've used today's ${DAILY_LIMIT} requests. Your limit resets tomorrow.` });
  }
  try {
    const text = await transcribe(req.body, req.get("content-type"));
    if (!text) return res.status(400).json({ error: "Couldn't hear any speech in that recording. Try again a little closer to the microphone." });
    await store.logAction(req.user.id, live ? "voice_live_heard" : "voice_note", { chars: text.length });
    res.json({ text });
  } catch (err) {
    console.error(err);
    res.status(err.status === 429 ? 429 : 500).json({ error: err.status === 429 ? "Voice transcription is busy (free-tier limit). Wait a minute and try again." : friendlyError(err) });
  }
});

// Live voice mode's own allowance: hearings (and spoken replies) per person per day, kept in memory.
const LIVE_PER_DAY = Math.max(50, DAILY_LIMIT * 4);
const liveCounts = new Map(); // userId -> { day, n }
function liveHearing(userId) {
  const day = new Date().toISOString().slice(0, 10), c = liveCounts.get(userId);
  if (!c || c.day !== day) { liveCounts.set(userId, { day, n: 1 }); return true; }
  return ++c.n <= LIVE_PER_DAY;
}

// ---------- read aloud (ElevenLabs, then Cloudflare's free voice) ----------
// The browser falls back to its built-in voice whenever this returns an error.
api.post("/speak", async (req, res) => {
  if (!speechAvailable()) return res.status(400).json({ error: "Read aloud voices aren't set up on this server." });
  // live: a spoken reply in voice mode - part of the exchange already counted, kept short. Same voices as Read
  // aloud (ElevenLabs, then Cloudflare's free voice), or free only with LIVE_VOICE=free.
  const live = req.body?.live === true;
  const text = trimForSpeech(live ? String(req.body?.text || "").slice(0, 900) : req.body?.text);
  if (!text) return res.status(400).json({ error: "Nothing to read." });
  if (live) {
    if (!liveServerVoice()) return res.status(400).json({ error: "No server voice; using the device's voice.", fallback: true });
    if (!liveHearing(req.user.id)) return res.status(429).json({ error: "Voice mode is done for today.", fallback: true });
  } else {
    const usage = await store.useRequest(req.user.id, DAILY_LIMIT);
    if (!usage.allowed) return res.status(429).json({ error: `You've used today's ${DAILY_LIMIT} requests. Your limit resets tomorrow.` });
  }
  try {
    const { voice, body } = await synthesize(text, { freeOnly: live && liveFreeOnly() });
    await store.logAction(req.user.id, live ? "voice_live_spoke" : "read_aloud", { chars: text.length, voice });
    res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Thinq-Voice": voice });
    if (Buffer.isBuffer(body)) return res.send(body);
    Readable.fromWeb(body).on("error", () => res.destroy()).pipe(res);
  } catch (err) {
    res.status(err.status === 429 ? 429 : 502).json({ error: err.message, quota: Boolean(err.quota) });
  }
});

// ---------- approvals ----------
api.patch("/approvals/:id", async (req, res) => {
  const a = await store.getApproval(req.user.id, req.params.id);
  if (!a || a.status !== "pending") return res.status(404).json({ error: "Nothing to edit" });
  const b = req.body || {};
  if (a.kind === "whatsapp") {
    const text = typeof b.text === "string" ? b.text.trim().slice(0, 4000) : "";
    if (!text) return res.status(400).json({ error: "The message can't be empty." });
    return res.json(await store.updateApproval(req.user.id, a.id, { payload: { ...a.payload, text } }));
  }
  if (a.kind !== "email") return res.status(400).json({ error: "Only email and WhatsApp drafts can be edited here" });
  const edits = {};
  if (Array.isArray(b.to)) edits.to = b.to.map(String).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(b.cc)) edits.cc = b.cc.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof b.subject === "string") edits.subject = b.subject.slice(0, 500);
  if (typeof b.body === "string") edits.body = b.body.slice(0, 50000);
  if (edits.to && !edits.to.length) return res.status(400).json({ error: "Add at least one recipient." });
  res.json(await store.updateApproval(req.user.id, a.id, { payload: { ...a.payload, ...edits } }));
});

api.post("/approvals/:id/approve", async (req, res) => {
  const out = await approveItem(req.user, req.params.id, req.body?.via === "notification" ? "notification" : "app");
  out.ok ? res.json(out.approval) : res.status(out.status).json({ error: out.error });
});

api.post("/approvals/:id/decline", async (req, res) => {
  const out = await declineItem(req.user, req.params.id, req.body?.via === "notification" ? "notification" : "app");
  out.ok ? res.json(out.approval) : res.status(404).json({ error: out.error });
});

// ---------- agenda panel ----------
api.get("/agenda", async (req, res) => {
  const tz = validTz(req.query.timeZone);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 3);
  try {
    const p = await providerFor(req.user);
    res.json({ timeZone: tz, events: await p.listEvents({ timeMin: start.toISOString(), timeMax: end.toISOString() }) });
  } catch (err) {
    res.status(500).json({ error: friendlyError(err) });
  }
});

api.delete("/notes/:id", async (req, res) => { await store.deleteNote(req.user.id, req.params.id); res.json({ ok: true }); });

api.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "That file is too big. Documents can be up to 10 MB and voice notes about 15 minutes." });
  next(err);
});
app.use("/api", api);

// ---------- the website ----------
if (fs.existsSync(SITE_DIR)) {
  // Serve /pricing as well as /pricing.html; send people who are signed in straight to the app from the login page.
  app.get("/login.html", (req, res, next) => (req.user ? res.redirect("/app") : next()));
  app.use(express.static(SITE_DIR, { extensions: ["html"], index: "index.html" }));
  app.use((req, res) => res.status(404).sendFile(path.join(SITE_DIR, "404.html")));
} else {
  app.get("/", (req, res) => res.redirect(req.user ? "/app" : "/auth/google/login"));
}

meetings.startMeetingWorkers();
recordings.startRecordingWorker();
notifier.startNotifyWorker();
routines.startRoutineWorker(); // scheduled tasks: morning summaries, daily messages...
tasks.startTaskWorker(); // due-date reminders, and closing "waiting on" tasks when the reply arrives
await startTelegram(); // learns the bot's name, registers the webhook, starts group-bot reminders

// Keep-awake: Render's free plan puts the server to sleep after ~15 minutes without visitors, and a sleeping
// server can't send reminders. Visiting our own public /healthz every 10 minutes counts as a visitor.
// (A GitHub Action also pings it, to wake it again after a deploy or crash - see .github/workflows/keep-awake.yml.)
// Set KEEP_AWAKE=off to stop.
if (process.env.NODE_ENV === "production" && process.env.KEEP_AWAKE !== "off" && /^https:\/\//.test(publicUrl())) {
  setInterval(() => fetch(`${publicUrl()}/healthz`, { signal: AbortSignal.timeout(20_000) }).catch(() => {}), 10 * 60_000).unref();
}
const resumed = await resumeAllSyncs().catch((e) => { console.warn("[wa-sync] resume failed:", e.message); return 0; });

// Deploys and restarts: let go of WhatsApp links cleanly so the new copy of the server can take them over at once.
const shutdown = (sig) => {
  console.log(`  ${sig}: shutting down`);
  try { stopAllSyncs(); } catch {}
  setTimeout(() => process.exit(0), 1500).unref();
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

app.listen(PORT, HOST, () => {
  console.log(`\n  Thinq is running at ${publicUrl()}`);
  console.log(`  Website: ${fs.existsSync(SITE_DIR) ? SITE_DIR : "not found (app only)"}`);
  console.log(`  AI: ${AI_PROVIDER === "groq" ? "Groq" : "Anthropic"} (${MODEL})${hasApiKey() ? "" : ` - ⚠ ${apiKeyName()} missing`}`);
  console.log(`  Google sign-in: ${googleConfigured() ? `on (redirect URI: ${redirectUri()})` : "⚠ not configured"}`);
  console.log(`  Invite list: ${process.env.ALLOWED_EMAILS || "(none)"} · admins: ${process.env.ADMIN_EMAILS || "⚠ none - set ADMIN_EMAILS to review tester requests"} · plus testers approved in the app`);
  console.log(`  Telegram group bots: ${telegramConfigured() ? `on (@${botUsername() || "?"})` : "off (set TELEGRAM_BOT_TOKEN)"}`);
  console.log(`  WhatsApp: ${whatsappConfigured() ? `on (+${whatsappNumber() || "number not set"})` : "off"}`);
  console.log(`  WhatsApp chat sync: ${syncAvailable() ? `on (${resumed || 0} linked account${resumed === 1 ? "" : "s"} reconnecting)` : "off"}`);
  console.log(`  Meeting notes: ${recordings.recordingAvailable() ? "recording in the browser on" : "recording off (needs GROQ_API_KEY)"} · notetaker bot ${meetings.meetingsConfigured() ? `on (${process.env.ATTENDEE_URL})` : "off"}`);
  console.log(`  Notifications: on (reminders, email alerts, calendar heads-ups)${process.env.NODE_ENV === "production" && process.env.KEEP_AWAKE !== "off" ? " · keep-awake ping every 10 min" : ""}`);
  console.log(`  Daily limit: ${DAILY_LIMIT || "none"} AI requests per person\n`);
});
