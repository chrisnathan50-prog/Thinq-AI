// Sending an approved draft or invite. Used by the app's Approvals panel and by WhatsApp's "Send" button.
// claimApproval makes each item send at most once, even on a double click or a repeated WhatsApp tap.
import * as store from "./store.js";
import { providerFor } from "./providers/index.js";
import { friendlyError } from "./errors.js";
import { sendToChat } from "./whatsapp-sync.js";
import { sendNotetaker } from "./meetings.js";
import { trackReply } from "./tasks.js";

const SENT_LOG = { email: "email_sent", event: "event_created", whatsapp: "whatsapp_sent", notetaker: "notetaker_approved" };

export async function approveItem(user, approvalId, via = "app") {
  const a = await store.claimApproval(user.id, approvalId);
  if (!a) return { ok: false, status: 404, error: "This item is no longer waiting for approval." };
  try {
    let result, mode;
    if (a.kind === "whatsapp") {
      result = await sendToChat(user.id, a.payload.jid, a.payload.text);
      mode = "whatsapp";
    } else if (a.kind === "notetaker") {
      const m = await sendNotetaker(user, a.payload);
      result = { meetingId: m.id, note: m.status === "scheduled" ? "Thinq's notetaker will join a minute before it starts." : "Thinq's notetaker is joining now." };
      mode = "meetings";
    } else {
      const p = await providerFor(user);
      result = a.kind === "email" ? await p.sendEmail(a.payload) : await p.createEvent(a.payload);
      mode = p.mode;
    }
    await store.logAction(user.id, SENT_LOG[a.kind] || "approved", { approvalId: a.id, summary: a.summary, mode, via });
    // "Let me know if they don't reply": the sent email becomes a waiting-on task tied to its thread.
    if (a.kind === "email" && a.payload.followUpDays && result?.threadId) {
      await trackReply(user, { threadId: result.threadId, to: a.payload.to, subject: a.payload.subject, days: a.payload.followUpDays, timeZone: a.payload.timeZone })
        .catch((e) => console.warn("[tasks] couldn't track the reply:", e.message));
    }
    return { ok: true, approval: await store.updateApproval(user.id, a.id, { status: "done", result, mode }) };
  } catch (err) {
    console.error(err);
    await store.updateApproval(user.id, a.id, { status: "pending", error: String(err.message || err).slice(0, 300) });
    return { ok: false, status: 500, error: friendlyError(err) };
  }
}

export async function declineItem(user, approvalId, via = "app") {
  const a = await store.getApproval(user.id, approvalId);
  if (!a || a.status !== "pending") return { ok: false, status: 404, error: "Nothing to decline" };
  await store.logAction(user.id, "declined", { approvalId: a.id, summary: a.summary, via });
  return { ok: true, approval: await store.updateApproval(user.id, a.id, { status: "declined" }) };
}
