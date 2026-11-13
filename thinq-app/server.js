// Thinq AI - one server for the website and the app.
//   /            the marketing website (../thinq-site), including /login.html
//   /app         the assistant (./public) - signed-in users only
//   /api/...     the app's data and chat (per user)
//   /auth/...    Google sign-in, connecting Gmail & Calendar, log out
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { initDb } from "./src/db.js";
import * as store from "./src/store.js";
import { runTurn, hasApiKey, apiKeyName, MODEL, AI_PROVIDER } from "./src/agent.js";
import { GroqError } from "./src/llm/groq.js";
import { providerFor } from "./src/providers/index.js";
import { googleConfigured, publicUrl, redirectUri } from "./src/providers/google.js";
import { attachUser, requireUser, mountAuth } from "./src/auth.js";
import { extractDocument, DocumentError, ACCEPTED, MAX_UPLOAD_BYTES, partCount } from "./src/documents.js";
import { transcribe, voiceAvailable, MAX_AUDIO_BYTES } from "./src/llm/transcribe.js";
import { imagesAvailable, IMAGE_DAILY_LIMIT } from "./src/llm/images.js";
import { suggestionsFor, forgetSuggestions } from "./src/suggestions.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = process.env.SITE_DIR || path.resolve(here, "..", "thinq-site");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const DAILY_LIMIT = Number(process.env.DAILY_REQUEST_LIMIT ?? 60); // AI requests per user per day (0 = no limit)

await initDb();

const app = express();
app.set("trust proxy", 1); // behind Render's proxy, so secure cookies work
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));

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
app.use(attachUser);
mountAuth(app);

const validTz = (tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return "UTC"; } };

// ---------- the app (signed in only) ----------
app.get(["/app", "/app/"], requireUser, (req, res) => res.sendFile(path.join(here, "public", "index.html")));
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
const busy = new Set();
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

  if (!hasApiKey()) {
    send({ type: "error", text: `Thinq's AI isn't set up yet. The site owner needs to add ${apiKeyName()} to the server settings.` });
    return res.end();
  }
  const usage = await store.useRequest(req.user.id, DAILY_LIMIT);
  if (!usage.allowed) {
    send({ type: "error", text: `You've used today's ${DAILY_LIMIT} requests. Your limit resets tomorrow.` });
    return res.end();
  }

  busy.add(req.user.id);
  try {
    let reply;
    await store.attachDocuments(req.user.id, conversationId, attachments.map((d) => d.id));
    for await (const event of runTurn({ user: req.user, conversationId, userText: text.trim(), timeZone, attachments })) {
      if (event.type === "reply") reply = event;
      else send(event);
    }
    // Save the turn only once it finished, so a failed turn can simply be retried.
    await store.appendMessage(req.user.id, conversationId, "user", text.trim(), attachments.map(({ id, name, pages, chars }) => ({ id, name, pages, chars })));
    await store.appendMessage(req.user.id, conversationId, "assistant", reply.text, reply.images?.length ? reply.images.map((i) => ({ type: "image", id: i.id, prompt: i.prompt })) : null);
    send({ ...reply, approvals: await Promise.all(reply.approvals.map((id) => store.getApproval(req.user.id, id))) });
  } catch (err) {
    console.error(err);
    send({ type: "error", text: friendlyError(err) });
  } finally {
    forgetSuggestions(req.user.id); // the inbox/calendar may have changed during this turn
    busy.delete(req.user.id);
    res.end();
  }
});

function friendlyError(err) {
  if (err instanceof GroqError) {
    if (err.status === 401) return "The server's Groq API key was rejected. The site owner needs to check GROQ_API_KEY.";
    if (err.status === 429) return "Thinq's AI is busy (free-tier limit reached). Wait a minute and try again.";
    if (err.status === 404 || err.code === "model_not_found" || err.code === "model_decommissioned") return `The AI model "${MODEL}" isn't available any more. The site owner needs to set GROQ_MODEL.`;
    if (err.status === 413 || err.code === "context_length_exceeded") return "This conversation got too long. Start a new conversation and try again.";
    if (err.status === 400 && err.code === "tool_use_failed") return "The AI got confused while using a tool. Try rephrasing your request.";
    if (err.status === 0) return "Couldn't reach the AI service. Try again in a moment.";
    return `The AI service returned an error (${err.status}). Try again in a moment.`;
  }
  if (err instanceof Anthropic.AuthenticationError) return "The server's Anthropic API key was rejected. The site owner needs to check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.PermissionDeniedError) return "The server's API key doesn't have access to the model.";
  if (err instanceof Anthropic.RateLimitError) return "Thinq is getting too many requests right now. Wait a minute and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the AI service. Try again in a moment.";
  if (err instanceof Anthropic.APIError) return `The AI service returned an error (${err.status}). Try again in a moment.`;
  if (/invalid_grant|Google is not connected/i.test(String(err?.message))) return "Your Google connection has expired. Click “Connect Gmail & Calendar” in the sidebar to reconnect.";
  return "Something went wrong. Try again in a moment.";
}

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
  const a = await store.claimApproval(req.user.id, req.params.id);
  if (!a) return res.status(404).json({ error: "This item is no longer waiting for approval." });
  try {
    const p = await providerFor(req.user);
    const result = a.kind === "email" ? await p.sendEmail(a.payload) : await p.createEvent(a.payload);
    await store.logAction(req.user.id, a.kind === "email" ? "email_sent" : "event_created", { approvalId: a.id, summary: a.summary, mode: p.mode });
    res.json(await store.updateApproval(req.user.id, a.id, { status: "done", result, mode: p.mode }));
  } catch (err) {
    console.error(err);
    await store.updateApproval(req.user.id, a.id, { status: "pending", error: String(err.message || err).slice(0, 300) });
    res.status(500).json({ error: friendlyError(err) });
  }
});

api.post("/approvals/:id/decline", async (req, res) => {
  const a = await store.getApproval(req.user.id, req.params.id);
  if (!a || a.status !== "pending") return res.status(404).json({ error: "Nothing to decline" });
  await store.logAction(req.user.id, "declined", { approvalId: a.id, summary: a.summary });
  res.json(await store.updateApproval(req.user.id, a.id, { status: "declined" }));
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
  console.log(`  Invite list: ${process.env.ALLOWED_EMAILS ? process.env.ALLOWED_EMAILS : process.env.NODE_ENV === "production" ? "⚠ empty - nobody can sign in" : "not set (anyone can sign in locally)"}`);
  console.log(`  Daily limit: ${DAILY_LIMIT || "none"} AI requests per person\n`);
});
