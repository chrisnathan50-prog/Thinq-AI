// Thinq on WhatsApp, through Meta's official WhatsApp Business Platform (Cloud API).
//
// People message Thinq's WhatsApp number. Each person links their number to their Thinq account once,
// by sending a 6-digit code shown in the app. After that they can chat, send voice notes and documents,
// forward messages from other chats, and share WhatsApp chat exports. Drafts and invites come back as
// messages with Send / Discard buttons - nothing is sent without a tap, same as in the app.
//
// Settings (see README): WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET,
// WHATSAPP_VERIFY_TOKEN, WHATSAPP_NUMBER (the number people message, digits only, for wa.me links).
import { createHmac, timingSafeEqual } from "node:crypto";
import * as store from "./store.js";
import { isAllowed } from "./auth.js";
import { publicUrl } from "./providers/google.js";
import { chatTurn, TurnError, DAILY_LIMIT } from "./turns.js";
import { approveItem, declineItem } from "./approvals.js";
import { friendlyError } from "./errors.js";
import { extractDocument, DocumentError, partCount, MAX_UPLOAD_BYTES } from "./documents.js";
import { transcribe, voiceAvailable, MAX_AUDIO_BYTES } from "./llm/transcribe.js";

const GRAPH = (process.env.WHATSAPP_GRAPH_URL || "https://graph.facebook.com").replace(/\/$/, "");
const VERSION = process.env.WHATSAPP_API_VERSION || "v27.0";
const env = (k) => String(process.env[k] || "").trim();
export const whatsappConfigured = () => Boolean(env("WHATSAPP_TOKEN") && env("WHATSAPP_PHONE_NUMBER_ID") && env("WHATSAPP_APP_SECRET") && env("WHATSAPP_VERIFY_TOKEN"));
export const whatsappNumber = () => env("WHATSAPP_NUMBER").replace(/\D/g, "");
export const linkUrl = (code) => `https://wa.me/${whatsappNumber()}?text=${encodeURIComponent(`Link ${code}`)}`;

// ---------- sending ----------
async function graph(path, { method = "POST", json, form } = {}) {
  const res = await fetch(`${GRAPH}/${VERSION}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${env("WHATSAPP_TOKEN")}`, ...(json ? { "Content-Type": "application/json" } : {}) },
    body: json ? JSON.stringify(json) : form,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data.error || {};
    console.warn(`[whatsapp] ${method} ${path.split("/").pop()} failed: ${res.status} ${e.code ?? ""} ${e.message ?? ""}`.trim());
    throw new Error(`WhatsApp API error ${res.status}`);
  }
  return data;
}
const sendMessage = (to, body) => graph(`${env("WHATSAPP_PHONE_NUMBER_ID")}/messages`, { json: { messaging_product: "whatsapp", recipient_type: "individual", to, ...body } });

// Markdown from the AI -> WhatsApp formatting (*bold*, _italic_), split into WhatsApp-sized pieces.
export function toWhatsAppText(md) {
  return md
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^[ \t]*#{1,6}[ \t]+(.+)$/gm, "*$1*")
    .replace(/^[ \t]*[-•][ \t]+/gm, "• ")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1 ($2)")
    .replace(/^[ \t]*\|[ \t:|-]+\|[ \t]*\n?/gm, "") // table separator rows
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, (row) => row.replace(/^[ \t]*\||\|[ \t]*$/g, "").split("|").map((c) => c.trim()).join(" · "))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export async function sendText(to, text) {
  let rest = toWhatsAppText(text) || "…";
  while (rest) {
    let cut = rest.length <= 3900 ? rest.length : rest.lastIndexOf("\n", 3900);
    if (cut < 1000) cut = 3900;
    await sendMessage(to, { type: "text", text: { body: rest.slice(0, cut), preview_url: false } });
    rest = rest.slice(cut).trim();
  }
}
async function sendImage(to, { mime, data }, caption) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([data], { type: mime }), `thinq.${mime.split("/")[1] || "jpg"}`);
  const { id } = await graph(`${env("WHATSAPP_PHONE_NUMBER_ID")}/media`, { form });
  await sendMessage(to, { type: "image", image: { id, caption: caption?.slice(0, 900) } });
}
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
async function sendApproval(to, a, timeZone) {
  const p = a.payload;
  const when = (iso) => new Date(iso).toLocaleString("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const body = a.kind === "email"
    ? `✉️ *Draft email* (not sent yet)\nTo: ${p.to.join(", ")}${p.cc?.length ? `\nCc: ${p.cc.join(", ")}` : ""}\nSubject: ${p.subject}\n\n${p.body}`
    : `📅 *Invite* (not sent yet)\n${p.title}\n${when(p.start)} – ${new Date(p.end).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" })}${p.attendees?.length ? `\nGuests: ${p.attendees.join(", ")}` : ""}`;
  await sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: clip(body, 1000) },
      footer: { text: "Or edit it in the Thinq app first" },
      action: { buttons: [
        { type: "reply", reply: { id: `ok:${a.id}`, title: a.kind === "email" ? "Send" : "Send invite" } },
        { type: "reply", reply: { id: `no:${a.id}`, title: "Discard" } },
      ] },
    },
  });
}
// Marks their message as read and shows "typing…" while Thinq works (clears itself when we reply).
const showTyping = (messageId) =>
  graph(`${env("WHATSAPP_PHONE_NUMBER_ID")}/messages`, { json: { messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } } }).catch(() => {});

// ---------- receiving media ----------
async function downloadMedia(mediaId, maxBytes) {
  const meta = await graph(mediaId, { method: "GET" });
  if (meta.file_size && Number(meta.file_size) > maxBytes) throw new DocumentError("That file is too big for Thinq (10 MB for documents, about 15 minutes for voice notes).");
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${env("WHATSAPP_TOKEN")}` }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Media download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new DocumentError("That file is too big for Thinq (10 MB for documents, about 15 minutes for voice notes).");
  return { buffer: buf, mime: meta.mime_type };
}

// ---------- the webhook ----------
const strangerReplies = new Map(); // waId -> last time we told an unlinked number how to link (avoid spamming)
const failedCodes = new Map(); // waId -> { n, since } to slow down code guessing

function signatureOk(req) {
  const sig = String(req.get("x-hub-signature-256") || "");
  if (!sig.startsWith("sha256=") || !req.rawBody) return false;
  const want = Buffer.from(createHmac("sha256", env("WHATSAPP_APP_SECRET")).update(req.rawBody).digest("hex"));
  const got = Buffer.from(sig.slice(7));
  return got.length === want.length && timingSafeEqual(got, want);
}

export function mountWhatsApp(app) {
  // Meta checks the webhook once when you set it up.
  app.get("/webhooks/whatsapp", (req, res) => {
    if (whatsappConfigured() && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === env("WHATSAPP_VERIFY_TOKEN")) {
      return res.type("text/plain").send(String(req.query["hub.challenge"] ?? ""));
    }
    res.sendStatus(403);
  });

  app.post("/webhooks/whatsapp", (req, res) => {
    if (!whatsappConfigured()) return res.sendStatus(404);
    if (!signatureOk(req)) return res.sendStatus(401); // only Meta can call this
    res.sendStatus(200); // answer fast; Meta retries slow webhooks
    for (const entry of req.body?.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const msg of v.messages || []) {
          handleMessage(msg, names[msg.from]).catch((err) => console.error("[whatsapp] handling failed:", err.message));
        }
      }
    }
  });
}

const HELP = `Here's what you can do:
• Ask anything about your email and calendar
• Send a voice note instead of typing
• Send a PDF, Word or text file and ask about it
• Forward me a message from any chat and ask "what should I reply?"
• Share a chat export (in a chat: ⋯ → More → Export chat → Thinq) and ask for a summary
• Ask for an image
• Send *new* to start a fresh conversation`;

export async function handleMessage(msg, profileName) {
  if (!msg?.id || !msg.from) return;
  if (!(await store.firstTimeWhatsAppMessage(msg.id))) return;
  const from = msg.from;
  const text = msg.type === "text" ? String(msg.text?.body || "").trim() : "";

  // ---- not linked yet: accept a link code, otherwise explain how ----
  let link = await store.whatsappLinkByNumber(from);
  if (!link) {
    const code = text.match(/\b(\d{6})\b/)?.[1];
    const fails = failedCodes.get(from);
    if (fails && Date.now() - fails.since > 3600e3) failedCodes.delete(from);
    if (code && (failedCodes.get(from)?.n || 0) < 5) {
      const userId = await store.useWhatsAppCode(code, from, profileName || null);
      const user = userId && (await store.getUser(userId));
      if (user && isAllowed(user.email)) {
        await store.logAction(user.id, "whatsapp_linked", {});
        strangerReplies.delete(from); failedCodes.delete(from);
        return sendText(from, `✅ Linked to *${user.name || user.email}*'s Thinq account.\n\n${HELP}\n\nI still never send an email or invite without your tap.`);
      }
      if (user) { await store.unlinkWhatsApp(user.id); return sendText(from, "This Thinq account isn't on the invite list."); }
      failedCodes.set(from, { n: (failedCodes.get(from)?.n || 0) + 1, since: failedCodes.get(from)?.since || Date.now() });
      return sendText(from, "That code didn't work - it may have expired. In the Thinq app, tap *Connect WhatsApp* to get a new one.");
    }
    if (Date.now() - (strangerReplies.get(from) || 0) < 3600e3) return;
    strangerReplies.set(from, Date.now());
    return sendText(from, `Hi! I'm Thinq, a personal assistant. To chat with me here, sign in at ${publicUrl()}/app and tap *Connect WhatsApp*.`);
  }

  const user = await store.getUser(link.user_id);
  if (!user || !isAllowed(user.email)) return sendText(from, "This Thinq account no longer has access.");
  const timeZone = link.time_zone || "UTC";

  // ---- buttons on drafts/invites ----
  if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
    const [action, approvalId] = String(msg.interactive.button_reply?.id || "").split(":");
    if (action === "ok") {
      const out = await approveItem(user, approvalId, "whatsapp");
      if (!out.ok) return sendText(from, out.status === 404 ? "That one was already handled." : out.error);
      const demo = out.approval.mode === "demo" ? " (demo mode - nothing really went out)" : "";
      return sendText(from, out.approval.kind === "email" ? `✅ Sent${demo}.` : `✅ Added to your calendar and invites sent${demo}.`);
    }
    if (action === "no") {
      const out = await declineItem(user, approvalId, "whatsapp");
      return sendText(from, out.ok ? "🗑️ Discarded." : "That one was already handled.");
    }
    return;
  }

  // ---- commands ----
  if (/^\/?(new|reset|new chat)$/i.test(text)) {
    await store.setWhatsAppConversation(from, null);
    return sendText(from, "🆕 Started a fresh conversation.");
  }
  if (/^\/?(help|\?)$/i.test(text)) return sendText(from, HELP);

  showTyping(msg.id);

  // ---- turn the message into text (+ documents) for the assistant ----
  let userText = text, attachments = [];
  try {
    if (msg.type === "audio") {
      if (!voiceAvailable()) return sendText(from, "Voice notes aren't set up on this Thinq server yet - please type instead.");
      const usage = await store.useRequest(user.id, DAILY_LIMIT);
      if (!usage.allowed) return sendText(from, `You've used today's ${DAILY_LIMIT} requests. Your limit resets tomorrow.`);
      const audio = await downloadMedia(msg.audio.id, MAX_AUDIO_BYTES);
      const heard = await transcribe(audio.buffer, audio.mime || "audio/ogg");
      if (!heard) return sendText(from, "I couldn't hear any words in that voice note. Try again a little closer to the mic?");
      userText = `[Voice note, transcribed] ${heard}`;
      await store.logAction(user.id, "voice_note", { chars: heard.length, via: "whatsapp" });
    } else if (msg.type === "document") {
      const d = msg.document || {};
      const name = String(d.filename || "document").slice(0, 200);
      const file = await downloadMedia(d.id, MAX_UPLOAD_BYTES);
      const out = await extractDocument(name, file.buffer);
      const doc = await store.addDocument(user.id, { name, sizeBytes: file.buffer.length, pages: out.pages, text: out.text });
      attachments = [{ ...doc, parts: partCount(out.chars) }];
      userText = String(d.caption || "").trim() || (out.whatsapp
        ? "Please read this WhatsApp chat and give me a short summary: the main topics, any plans or dates, and anything people are waiting on me for."
        : "Please read the attached document and give me a short summary.");
    } else if (msg.type === "image") {
      return sendText(from, "I can't read photos yet. If it's a document, send it as a PDF or Word file instead.");
    } else if (msg.type === "text") {
      if (!userText) return;
    } else {
      return sendText(from, "I can read text, voice notes and documents (PDF, Word, text, WhatsApp chat exports). That kind of message isn't supported yet.");
    }
  } catch (err) {
    if (err instanceof DocumentError) return sendText(from, err.message);
    console.error("[whatsapp] reading the message failed:", err.message);
    return sendText(from, err.status === 429 ? "Voice transcription is busy right now. Wait a minute and try again." : "Sorry, I couldn't open that. Try sending it again.");
  }
  if (msg.context?.forwarded || msg.context?.frequently_forwarded) userText = `[Forwarded WhatsApp message - written by someone else]\n${userText}`;
  userText = userText.slice(0, 8000);

  // ---- one WhatsApp conversation per person (send "new" to start another) ----
  let conversationId = link.conversation_id;
  if (!conversationId || !(await store.getConversation(user.id, conversationId))) {
    conversationId = (await store.createConversation(user.id)).id;
    await store.setConversationTitle(user.id, conversationId, "WhatsApp chat");
    await store.setWhatsAppConversation(from, conversationId);
  }

  let reply;
  try {
    reply = await chatTurn({ user, conversationId, text: userText, timeZone, attachments, channel: "whatsapp", onStatus: () => showTyping(msg.id) });
  } catch (err) {
    if (!(err instanceof TurnError)) console.error("[whatsapp] turn failed:", err.message);
    return sendText(from, err instanceof TurnError ? err.message : friendlyError(err));
  }

  await sendText(from, reply.text);
  for (const img of reply.images || []) {
    const data = await store.getImage(user.id, img.id);
    if (data) await sendImage(from, data, img.prompt).catch(() => sendText(from, "(I made an image but couldn't send it here - open the Thinq app to see it.)"));
  }
  for (const a of reply.approvals || []) if (a.status === "pending") await sendApproval(from, a, timeZone);
}
