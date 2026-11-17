// Thinq group bots on Telegram. One shared Telegram bot (made with @BotFather) serves every Thinq user's group bots:
// each Telegram group is linked to one Thinq bot with a code, and then the bot answers there with that bot's name,
// facts and reminders. Set TELEGRAM_BOT_TOKEN; the webhook is registered automatically at startup.
//
// In groups the bot answers when someone uses /ask, replies to one of its messages, or @mentions it
// (mentions need "Group Privacy" turned off in @BotFather, or the bot made a group admin).
import { createHash, timingSafeEqual } from "node:crypto";
import * as store from "./store.js";
import * as bots from "./bots.js";
import { DAILY_LIMIT } from "./turns.js";
import { publicUrl } from "./providers/google.js";

const API = (process.env.TELEGRAM_API_URL || "https://api.telegram.org").replace(/\/$/, "");
const token = () => String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
export const telegramConfigured = () => /^\d+:[\w-]{20,}$/.test(token());
// Telegram sends this back on every webhook call, so we know the call really came from Telegram.
const webhookSecret = () => process.env.TELEGRAM_WEBHOOK_SECRET || createHash("sha256").update(`thinq-telegram:${token()}`).digest("hex").slice(0, 48);

let me = null; // { id, username } of the bot
export const botUsername = () => me?.username || null;

export async function tg(method, body = {}) {
  const res = await fetch(`${API}/bot${token()}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    console.warn(`[telegram] ${method} failed: ${data.error_code ?? res.status} ${data.description ?? ""}`.trim());
    const err = new Error(data.description || `Telegram ${method} failed`);
    err.code = data.error_code ?? res.status;
    throw err;
  }
  return data.result;
}
const say = (chatId, text, replyTo) =>
  tg("sendMessage", { chat_id: chatId, text: String(text).slice(0, 4000), ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}), link_preview_options: { is_disabled: true } });

// ---------- startup: learn our name and point Telegram at our webhook ----------
export async function startTelegram() {
  if (!telegramConfigured()) return;
  try {
    me = await tg("getMe");
    const base = publicUrl();
    if (/^https:\/\//.test(base)) {
      await tg("setWebhook", { url: `${base}/webhooks/telegram`, secret_token: webhookSecret(), allowed_updates: ["message", "my_chat_member"], drop_pending_updates: false });
    } else {
      console.log("  Telegram: webhook not set (needs a public https address - works once hosted)");
    }
    await tg("setMyCommands", { commands: [
      { command: "ask", description: "Ask the group's bot a question" },
      { command: "reminders", description: "Show upcoming reminders" },
      { command: "help", description: "What this bot can do" },
      { command: "link", description: "Connect this group to a Thinq bot (admins)" },
      { command: "pause", description: "Pause answers and reminders (admins)" },
      { command: "resume", description: "Turn the bot back on (admins)" },
      { command: "unlink", description: "Disconnect this group (admins)" },
    ] }).catch(() => {});
  } catch (err) {
    console.warn(`[telegram] couldn't start: ${err.message}`);
  }
  setInterval(() => sendDueReminders().catch((e) => console.warn("[telegram] reminders:", e.message)), 30_000);
  setTimeout(() => sendDueReminders().catch(() => {}), 5_000);
}

// ---------- reminders ----------
export async function sendDueReminders() {
  if (!telegramConfigured()) return;
  for (const r of await bots.claimDueReminders()) {
    if (r.late) { await store.logAction(r.user_id, "bot_reminder_skipped", { botId: r.bot_id, reason: "server was asleep" }); continue; }
    for (const g of await bots.groupsForBot(r.bot_id)) {
      try {
        await say(g.chat_id, `⏰ ${r.message}`);
        await store.logAction(r.user_id, "bot_reminder", { botId: r.bot_id });
      } catch (err) {
        if (err.code === 403 || err.code === 400) await bots.unlinkGroup(g.chat_id); // removed from the group, or the group is gone
      }
    }
  }
}

// ---------- receiving ----------
const recent = new Map(); // chatId -> answer timestamps (per-group limit)
function groupTooBusy(chatId) {
  const now = Date.now(), list = (recent.get(chatId) || []).filter((t) => now - t < 3600e3);
  list.push(now); recent.set(chatId, list);
  return list.length > 30;
}
const isAdmin = async (chatId, userId) => {
  try { const m = await tg("getChatMember", { chat_id: chatId, user_id: userId }); return ["creator", "administrator"].includes(m.status); } catch { return false; }
};
const HELP_GROUP = (name) => `I'm ${name}. Ask me with /ask followed by your question, or reply to one of my messages.\n/reminders shows what's coming up.\nGroup admins: /pause, /resume, /unlink.`;

export function mountTelegram(app) {
  app.post("/webhooks/telegram", (req, res) => {
    if (!telegramConfigured()) return res.sendStatus(404);
    const got = Buffer.from(String(req.get("x-telegram-bot-api-secret-token") || "")), want = Buffer.from(webhookSecret());
    if (got.length !== want.length || !timingSafeEqual(got, want)) return res.sendStatus(401);
    res.sendStatus(200); // answer at once; Telegram retries slow webhooks
    handleUpdate(req.body).catch((err) => console.error("[telegram] update failed:", err.message));
  });
}

export async function handleUpdate(u) {
  if (!u || typeof u.update_id !== "number") return;
  if (!(await store.firstTimeWhatsAppMessage(`tg:${u.update_id}`))) return; // same de-duplication table as WhatsApp

  // Added to / removed from a group
  if (u.my_chat_member) {
    const { chat, new_chat_member: m } = u.my_chat_member;
    if (["left", "kicked"].includes(m?.status)) return bots.unlinkGroup(chat.id);
    if (["member", "administrator"].includes(m?.status) && chat.type !== "private" && !(await bots.botForGroup(chat.id))) {
      return say(chat.id, `Hi! I'm a Thinq group bot. To set me up, build your bot in the Thinq app (${publicUrl()}/app), tap "Link a group" to get a code, and a group admin sends /link CODE here.`);
    }
    return;
  }

  const msg = u.message;
  if (!msg?.chat || !msg.from || msg.from.is_bot) return;
  const chatId = msg.chat.id, text = String(msg.text || msg.caption || "").trim();
  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd?.startsWith("/") ? rawCmd.slice(1).split("@")[0].toLowerCase() : null;
  const forOtherBot = rawCmd?.includes("@") && me?.username && rawCmd.split("@")[1]?.toLowerCase() !== me.username.toLowerCase();
  if (cmd && forOtherBot) return;
  const asker = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") || msg.from.username;

  // Private chat with the bot: explain how it works.
  if (msg.chat.type === "private") {
    return say(chatId, `Hi${msg.from.first_name ? ` ${msg.from.first_name}` : ""}! I'm the Thinq group bot.\n\n1. In the Thinq app (${publicUrl()}/app), ask Thinq to build you a bot - e.g. "build a bot for my book club that answers questions about meetings and reminds everyone every first Monday at 7pm".\n2. Add me to your Telegram group.\n3. In the app, tap "Link a group" and send /link CODE in the group.`);
  }

  const bot = await bots.botForGroup(chatId);

  if (cmd === "link") {
    if (!(await isAdmin(chatId, msg.from.id))) return say(chatId, "Only group admins can link me.", msg.message_id);
    const code = rest.join("").replace(/\D/g, "");
    const linked = code.length === 6 && (await bots.useLinkCode(code, chatId, msg.chat.title || null));
    if (!linked) return say(chatId, "That code didn't work - it may have expired. Get a new one in the Thinq app (Bots → Link a group).", msg.message_id);
    await store.logAction(linked.user_id, "bot_linked", { botId: linked.id, platform: "telegram" });
    return say(chatId, `✅ Linked! I'm now ${linked.name} in this group.\n\n${HELP_GROUP(linked.name)}`);
  }
  if (!bot) {
    if (cmd) return say(chatId, `I'm not set up in this group yet. Build a bot in the Thinq app (${publicUrl()}/app), then a group admin sends /link CODE here.`, msg.message_id);
    return;
  }
  if (["pause", "resume", "unlink"].includes(cmd)) {
    if (!(await isAdmin(chatId, msg.from.id))) return say(chatId, "Only group admins can do that.", msg.message_id);
    if (cmd === "unlink") { await bots.unlinkGroup(chatId); return say(chatId, "Disconnected. I won't answer or send reminders here any more. You can remove me from the group."); }
    await bots.setGroupPaused(chatId, cmd === "pause");
    return say(chatId, cmd === "pause" ? "⏸ Paused - no answers or reminders until an admin sends /resume." : "▶️ I'm back on.");
  }
  if (cmd === "help" || cmd === "start") return say(chatId, HELP_GROUP(bot.name), msg.message_id);
  if (cmd === "reminders") {
    const list = await bots.upcomingReminders(bot.id, 8);
    const when = (d) => new Date(d).toLocaleString("en-US", { timeZone: bot.time_zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return say(chatId, list.length ? `Coming up:\n${list.map((r) => `• ${when(r.next_run_at)} - ${r.message}`).join("\n")}` : "No reminders scheduled.", msg.message_id);
  }

  // A question? /ask, a reply to the bot, or an @mention.
  const mentioned = me?.username && text.toLowerCase().includes(`@${me.username.toLowerCase()}`);
  const replyToBot = msg.reply_to_message?.from?.id === me?.id;
  if (!(cmd === "ask" || (!cmd && (mentioned || replyToBot)))) return;
  if (bot.group_paused || bot.status !== "active") return;
  let question = cmd === "ask" ? rest.join(" ") : text;
  if (me?.username) question = question.replace(new RegExp(`@${me.username}`, "ig"), "").trim();
  if (!question) return say(chatId, "What would you like to know? Try: /ask what time do we meet?", msg.message_id);
  if (groupTooBusy(chatId)) return;
  const usage = await store.useRequest(bot.user_id, DAILY_LIMIT);
  if (!usage.allowed) return say(chatId, "I've answered all I can for today - try again tomorrow, or ask the group's organiser.", msg.message_id);

  tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  try {
    const answer = await bots.answerQuestion(bot, { question, asker, groupTitle: msg.chat.title });
    await say(chatId, answer, msg.message_id);
    await store.logAction(bot.user_id, "bot_answer", { botId: bot.id, platform: "telegram" });
  } catch (err) {
    console.warn("[telegram] answer failed:", err.message);
    await say(chatId, "Sorry, I couldn't answer that just now. Try again in a minute.", msg.message_id).catch(() => {});
  }
}
