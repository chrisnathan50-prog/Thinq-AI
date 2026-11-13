// One chat turn, shared by the web app and WhatsApp: checks the daily limit, runs the assistant,
// saves both messages, and returns the reply with any queued approvals.
import * as store from "./store.js";
import { runTurn, hasApiKey, apiKeyName } from "./agent.js";
import { forgetSuggestions } from "./suggestions.js";

export const DAILY_LIMIT = Number(process.env.DAILY_REQUEST_LIMIT ?? 60); // AI requests per user per day (0 = no limit)
export const busy = new Set(); // one turn at a time per person

export class TurnError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export async function chatTurn({ user, conversationId, text, timeZone, attachments = [], channel = "app", onStatus = () => {} }) {
  if (!hasApiKey()) throw new TurnError(`Thinq's AI isn't set up yet. The site owner needs to add ${apiKeyName()} to the server settings.`, "not_configured");
  if (busy.has(user.id)) throw new TurnError("Thinq is still working on your last message.", "busy");
  const usage = await store.useRequest(user.id, DAILY_LIMIT);
  if (!usage.allowed) throw new TurnError(`You've used today's ${DAILY_LIMIT} requests. Your limit resets tomorrow.`, "limit");

  busy.add(user.id);
  try {
    let reply;
    await store.attachDocuments(user.id, conversationId, attachments.map((d) => d.id));
    for await (const event of runTurn({ user, conversationId, userText: text, timeZone, attachments, channel })) {
      if (event.type === "reply") reply = event;
      else if (event.type === "status") onStatus(event.text);
    }
    // Save the turn only once it finished, so a failed turn can simply be retried.
    await store.appendMessage(user.id, conversationId, "user", text, attachments.map(({ id, name, pages, chars }) => ({ id, name, pages, chars })));
    await store.appendMessage(user.id, conversationId, "assistant", reply.text, reply.images?.length ? reply.images.map((i) => ({ type: "image", id: i.id, prompt: i.prompt })) : null);
    return { ...reply, approvals: (await Promise.all(reply.approvals.map((id) => store.getApproval(user.id, id)))).filter(Boolean) };
  } finally {
    forgetSuggestions(user.id); // the inbox/calendar may have changed during this turn
    busy.delete(user.id);
  }
}
