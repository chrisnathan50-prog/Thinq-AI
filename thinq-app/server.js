// Thinq AI - one server for the website and the app.
//   /            the marketing website (../thinq-site), including /login.html
//   /app         the assistant (./public) - signed-in users only
//   /api/...     the app's data and chat (per user)
//   /auth/...    Google sign-in, connecting Gmail & Calendar, log out
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initDb } from "./src/db.js";
import * as store from "./src/store.js";
import { hasApiKey, apiKeyName, MODEL, AI_PROVIDER } from "./src/agent.js";
import { providerFor } from "./src/providers/index.js";
import { googleConfigured, publicUrl, redirectUri } from "./src/providers/google.js";
import { attachUser, requireUser, mountAuth } from "./src/auth.js";
import { extractDocument, DocumentError, ACCEPTED, MAX_UPLOAD_BYTES, partCount } from "./src/documents.js";
import { transcribe, voiceAvailable, MAX_AUDIO_BYTES } from "./src/llm/transcribe.js";
import { imagesAvailable, IMAGE_DAILY_LIMIT } from "./src/llm/images.js";
import { speechAvailable, synthesize, trimForSpeech } from "./src/llm/speech.js";
import { Readable } from "node:stream";
import { suggestionsFor } from "./src/suggestions.js";
import { friendlyError } from "./src/errors.js";
import { chatTurn, TurnError, busy, DAILY_LIMIT } from "./src/turns.js";
import { approveItem, declineItem } from "./src/approvals.js";
import { mountWhatsApp, whatsappConfigured, whatsappNumber, linkUrl } from "./src/whatsapp.js";
import { mountTesters, loadApprovedTesters, isAdmin } from "./src/testers.js";

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
app.use(attachUser);
mountAuth(app);
mountTesters(app); // website tester form + admin tester list

const validTz = (tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "UTC"; } };

// ---------- the app (signed in only) ----------
app.get(["/app", "/app/"], requireUser, (req, res) => res.sendFile(path.join(here, "public", "index.html")));
app.get("/app/admin", requireUser, (req, res) => (isAdmin(req.user.email) ? res.sendFile(path.join(here, "public", "admin.html")) : res.redirect("/app")));
app.use("/app", express.static(path.join(here, "public"), { index: false }));

// ---------- app state ----------
const api = express.Router();
api.use(requireUser);

api.get("/state", async (req, res) => {
  const p = await providerFor(req.user);
  res.json({
    user: { name: req.user.name, email: req.user.email, picture: req.user.picture },
    mode: p.mode,
    profile: await p.profile().catch(() => null),
    googleConfigured: googleConfigured(),
    hasApiKey: hasApiKey(),
    apiKeyName: apiKeyName(),
    aiProvider: AI_PROVIDER,
    model: MODEL,
    usage: { today: await store.usageToday(req.user.id), limit: DAILY_LIMIT },
    voiceAvailable: voiceAvailable(),
    admin: isAdmin(req.user.email) ? { pendingTesters: (await store.listTesters()).filter((t) => t.status === "pending").length } : null,
    speechAvailable: speechAvailable(),
    whatsapp: await whatsappState(req.user.id),
    images: { available: imagesAvailable(), today: await store.imagesToday(req.user.id), limit: IMAGE_DAILY_LIMIT },
    documentTypes: ACCEPTED,
    conversations: await store.listConversations(req.user.id),
    approvals: await store.listApprovals(req.user.id),
    notes: await store.listNotes(req.user.id),
  });
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
    const reply = await chatTurn({ user: req.user, conversationId, text: text.trim(), timeZone, attachments, onStatus: (t) => send({ type: "status", text: t }) });
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
    const out = await extractDocument(name, req.body);
    const doc = await store.addDocument(req.user.id, { name, sizeBytes: req.body.length, pages: out.pages, text: out.text });
    await store.logAction(req.user.id, "document_added", { id: doc.id, name, chars: out.chars });
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
  const usage = await store.useRequest(req.user.id, DAILY_LIMIT);
  if (!usage.allowed) return res.status(429).json({ error: `You've used today's ${DAILY_LIMIT} requests. Your limit resets tomorrow.` });
  try {
    const text = await transcribe(req.body, req.get("content-type"));
    if (!text) return res.status(400).json({ error: "Couldn't hear any speech in that recording. Try again a little closer to the microphone." });
    await store.logAction(req.user.id, "voice_note", { chars: text.length });
    res.json({ text });
  } catch (err) {
    console.error(err);
    res.status(err.status === 429 ? 429 : 500).json({ error: err.status === 429 ? "Voice transcription is busy (free-tier limit). Wait a minute and try again." : friendlyError(err) });
  }
});

// ---------- read aloud (ElevenLabs, then Cloudflare's free voice) ----------
// The browser falls back to its built-in voice whenever this returns an error.
api.post("/speak", async (req, res) => {
  if (!speechAvailable()) return res.status(400).json({ error: "Read aloud voices aren't set up on this server." });
  const text = trimForSpeech(req.body?.text);
  if (!text) return res.status(400).json({ error: "Nothing to read." });
  const usage = await store.useRequest(req.user.id, DAILY_LIMIT);
  if (!usage.allowed) return res.status(429).json({ error: `You've used today's ${DAILY_LIMIT} requests. Your limit resets tomorrow.` });
  try {
    const { voice, body } = await synthesize(text);
    await store.logAction(req.user.id, "read_aloud", { chars: text.length, voice });
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
  if (a.kind !== "email") return res.status(400).json({ error: "Only email drafts can be edited here" });
  const b = req.body || {};
  const edits = {};
  if (Array.isArray(b.to)) edits.to = b.to.map(String).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(b.cc)) edits.cc = b.cc.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof b.subject === "string") edits.subject = b.subject.slice(0, 500);
  if (typeof b.body === "string") edits.body = b.body.slice(0, 50000);
  if (edits.to && !edits.to.length) return res.status(400).json({ error: "Add at least one recipient." });
  res.json(await store.updateApproval(req.user.id, a.id, { payload: { ...a.payload, ...edits } }));
});

api.post("/approvals/:id/approve", async (req, res) => {
  const out = await approveItem(req.user, req.params.id);
  out.ok ? res.json(out.approval) : res.status(out.status).json({ error: out.error });
});

api.post("/approvals/:id/decline", async (req, res) => {
  const out = await declineItem(req.user, req.params.id);
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

app.listen(PORT, HOST, () => {
  console.log(`\n  Thinq is running at ${publicUrl()}`);
  console.log(`  Website: ${fs.existsSync(SITE_DIR) ? SITE_DIR : "not found (app only)"}`);
  console.log(`  AI: ${AI_PROVIDER === "groq" ? "Groq" : "Anthropic"} (${MODEL})${hasApiKey() ? "" : ` - ⚠ ${apiKeyName()} missing`}`);
  console.log(`  Google sign-in: ${googleConfigured() ? `on (redirect URI: ${redirectUri()})` : "⚠ not configured"}`);
  console.log(`  Invite list: ${process.env.ALLOWED_EMAILS || "(none)"} · admins: ${process.env.ADMIN_EMAILS || "⚠ none - set ADMIN_EMAILS to review tester requests"} · plus testers approved in the app`);
  console.log(`  WhatsApp: ${whatsappConfigured() ? `on (+${whatsappNumber() || "number not set"})` : "off"}`);
  console.log(`  Daily limit: ${DAILY_LIMIT || "none"} AI requests per person\n`);
});
