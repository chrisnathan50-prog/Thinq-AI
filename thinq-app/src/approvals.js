// Sending an approved draft or invite. Used by the app's Approvals panel and by WhatsApp's "Send" button.
// claimApproval makes each item send at most once, even on a double click or a repeated WhatsApp tap.
import * as store from "./store.js";
import { providerFor } from "./providers/index.js";
import { friendlyError } from "./errors.js";

export async function approveItem(user, approvalId, via = "app") {
  const a = await store.claimApproval(user.id, approvalId);
  if (!a) return { ok: false, status: 404, error: "This item is no longer waiting for approval." };
  try {
    const p = await providerFor(user);
    const result = a.kind === "email" ? await p.sendEmail(a.payload) : await p.createEvent(a.payload);
    await store.logAction(user.id, a.kind === "email" ? "email_sent" : "event_created", { approvalId: a.id, summary: a.summary, mode: p.mode, via });
    return { ok: true, approval: await store.updateApproval(user.id, a.id, { status: "done", result, mode: p.mode }) };
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
