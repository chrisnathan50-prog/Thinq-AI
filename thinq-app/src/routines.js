// Routines: tasks Thinq does on a schedule without being asked again.
//
//   report  - Thinq runs an instruction ("summarise my unread emails and flag anything urgent") and tells the user:
//             a notification, the result saved in the routine's own chat, and (optionally) an email to themselves.
//             These only ever tell the user things, so they start right away.
//   message - Thinq sends a message to someone else on WhatsApp (through the user's linked WhatsApp) or by email.
//             These start as "needs_ok": the user turns them on in the app's Routines tab, which shows exactly who
//             gets what and when. The AI has no tool that turns a routine on. Fixed text then goes out by itself;
//             a message Thinq writes fresh each time waits in Approvals unless the user chose "send without asking".
//
// Schedules: once, daily, weekly (chosen weekdays) or monthly, in the user's time zone (same rules as group bots).
import { query, one } from "./db.js";
import { id } from "./secrets.js";
import * as store from "./store.js";
import { nextRun, normalizeReminder, describeSchedule, validTimeZone } from "./bots.js";
import { providerFor } from "./providers/index.js";
import { chatTurn, busy, TurnError } from "./turns.js";
import { notify } from "./notify.js";
import { resolveChat, sendToChat } from "./whatsapp-sync.js";
import { groqComplete } from "./llm/groq.js";
import { AI_PROVIDER, MODEL } from "./agent.js";
import Anthropic from "@anthropic-ai/sdk";
import { publicUrl } from "./providers/google.js";
import { friendlyError } from "./errors.js";

export const MAX_ROUTINES = 20;
export class RoutineError extends Error {}
const EMAIL = /^[^\s@<>()",;:]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const LATE_LIMIT_MS = 2 * 3600e3; // the server was asleep longer than this: skip that run instead of sending it very late

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await query(`create table if not exists routines (
    id text primary key,
    user_id text not null references users(id) on delete cascade,
    title text not null,
    kind text not null,
    instruction text,
    channel text,
    recipient text,
    recipient_name text,
    message_text text,
    write_fresh boolean not null default false,
    auto_send boolean not null default false,
    email_me boolean not null default false,
    repeat text not null,
    time_of_day text not null,
    on_date text,
    weekdays text,
    day_of_month integer,
    time_zone text not null default 'UTC',
    status text not null default 'active',
    next_run_at timestamptz,
    last_run_at timestamptz,
    last_result text,
    conversation_id text,
    created_at timestamptz not null default now()
  )`);
  await query(`create index if not exists routines_due on routines(next_run_at) where status = 'active'`);
  schemaReady = true;
}

// ---------- shaping ----------
export function routineOut(r) {
  return {
    id: r.id, title: r.title, kind: r.kind, instruction: r.instruction, channel: r.channel, recipient: r.recipient, recipientName: r.recipient_name,
    messageText: r.message_text, writeFresh: r.write_fresh, autoSend: r.auto_send, emailMe: r.email_me,
    schedule: describeSchedule(r), repeat: r.repeat, timeZone: r.time_zone, status: r.status,
    nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, lastResult: r.last_result, conversationId: r.conversation_id,
  };
}

// Tool input -> validated schedule fields (reuses the group-bot reminder rules).
function scheduleFields(s, timeZone) {
  const r = normalizeReminder({ message: "x", repeat: s.repeat, time: s.time, date: s.date, weekdays: s.weekdays, day_of_month: s.day_of_month }, timeZone);
  return { repeat: r.repeat, time_of_day: r.time_of_day, on_date: r.on_date, weekdays: r.weekdays, day_of_month: r.day_of_month, next_run_at: r.next_run_at };
}

async function resolveRecipient(userId, channel, to) {
  if (channel === "email") {
    const email = String(to || "").trim().toLowerCase();
    if (!EMAIL.test(email)) throw new RoutineError(`"${to}" isn't an email address.`);
    return { recipient: email, recipient_name: email };
  }
  if (channel === "whatsapp") {
    const r = await resolveChat(userId, String(to || "")).catch(() => ({ error: "WhatsApp isn't linked to Thinq." }));
    if (r.error) throw new RoutineError(r.error);
    return { recipient: r.jid, recipient_name: r.chat };
  }
  throw new RoutineError("Messages can go by WhatsApp or email.");
}

// ---------- create / change ----------
export async function createRoutine(userId, input) {
  await ensureSchema();
  const n = (await one(`select count(*)::int as n from routines where user_id = $1 and status <> 'done'`, [userId])).n;
  if (n >= MAX_ROUTINES) throw new RoutineError(`You already have ${MAX_ROUTINES} routines. Delete one first.`);
  const tz = validTimeZone(input.timeZone) ? input.timeZone : "UTC";
  const kind = input.kind === "message" ? "message" : "report";
  const sched = scheduleFields(input.schedule || {}, tz);
  let rec = { recipient: null, recipient_name: null };
  if (kind === "message") {
    rec = await resolveRecipient(userId, input.channel, input.to);
    if (!input.writeFresh && !String(input.messageText || "").trim()) throw new RoutineError("Give the exact message to send, or set write_fresh_each_time with an instruction.");
    if (input.writeFresh && !String(input.instruction || "").trim()) throw new RoutineError("Say what Thinq should write each time.");
  } else if (!String(input.instruction || "").trim()) {
    throw new RoutineError("Say what Thinq should do each time.");
  }
  const r = await one(`insert into routines (id, user_id, title, kind, instruction, channel, recipient, recipient_name, message_text, write_fresh, email_me,
      repeat, time_of_day, on_date, weekdays, day_of_month, time_zone, status, next_run_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning *`,
    [id("rtn"), userId, String(input.title || "Routine").slice(0, 80), kind, input.instruction ? String(input.instruction).slice(0, 3000) : null,
      kind === "message" ? input.channel : null, rec.recipient, rec.recipient_name,
      input.messageText ? String(input.messageText).slice(0, 2000) : null, Boolean(input.writeFresh), kind === "report" && Boolean(input.emailMe),
      sched.repeat, sched.time_of_day, sched.on_date, sched.weekdays, sched.day_of_month, tz,
      kind === "message" ? "needs_ok" : "active", sched.next_run_at]);
  await store.logAction(userId, "routine_created", { id: r.id, kind });
  return routineOut(r);
}

export async function updateRoutine(userId, routineId, patch) {
  await ensureSchema();
  const r = await one(`select * from routines where id = $1 and user_id = $2`, [routineId, userId]);
  if (!r) throw new RoutineError("No routine with that id.");
  const f = {};
  if (patch.title) f.title = String(patch.title).slice(0, 80);
  if (patch.instruction != null) f.instruction = String(patch.instruction).slice(0, 3000);
  if (patch.schedule) Object.assign(f, scheduleFields(patch.schedule, r.time_zone));
  if (patch.emailMe != null && r.kind === "report") f.email_me = Boolean(patch.emailMe);
  let needsOkAgain = false;
  if (r.kind === "message") {
    if (patch.to) { Object.assign(f, await resolveRecipient(userId, patch.channel || r.channel, patch.to)); if (patch.channel) f.channel = patch.channel; needsOkAgain = true; }
    if (patch.messageText != null) { f.message_text = String(patch.messageText).slice(0, 2000); needsOkAgain = true; }
    if (patch.writeFresh != null) { f.write_fresh = Boolean(patch.writeFresh); needsOkAgain = true; }
    if (patch.instruction != null && r.write_fresh) needsOkAgain = true;
  }
  if (needsOkAgain) { f.status = "needs_ok"; f.auto_send = false; } // what gets sent changed: the user must OK it again
  if (patch.paused === true && r.status === "active" && !needsOkAgain) f.status = "paused"; // only something already on can be paused
  if (patch.paused === false && r.status === "paused" && !needsOkAgain) f.status = "active";
  if (f.status === "active" || (patch.schedule && (f.status ?? r.status) === "active")) f.next_run_at = f.next_run_at ?? nextRun({ ...r, ...f }, r.time_zone);
  const keys = Object.keys(f);
  if (keys.length) await query(`update routines set ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")} where id = $1 and user_id = $2`, [routineId, userId, ...keys.map((k) => f[k])]);
  return routineOut(await one(`select * from routines where id = $1`, [routineId]));
}

// Only called from the app (the user's own click) - never offered to the AI.
export async function turnOn(userId, routineId, { autoSend = false } = {}) {
  await ensureSchema();
  const r = await one(`select * from routines where id = $1 and user_id = $2`, [routineId, userId]);
  if (!r) throw new RoutineError("No routine with that id.");
  const next = nextRun(r, r.time_zone);
  if (!next) throw new RoutineError("That time has already passed. Ask Thinq to change the schedule.");
  await query(`update routines set status = 'active', auto_send = $3, next_run_at = $4 where id = $1 and user_id = $2`, [routineId, userId, r.kind === "message" && r.write_fresh && Boolean(autoSend), next]);
  await store.logAction(userId, "routine_turned_on", { id: routineId, autoSend: Boolean(autoSend) });
  return routineOut(await one(`select * from routines where id = $1`, [routineId]));
}

export async function listRoutines(userId) {
  await ensureSchema();
  return (await query(`select * from routines where user_id = $1 order by (status = 'needs_ok') desc, status = 'done', next_run_at nulls last, created_at`, [userId])).map(routineOut);
}
export async function deleteRoutine(userId, routineId) {
  await ensureSchema();
  await query(`delete from routines where id = $1 and user_id = $2`, [routineId, userId]);
}

// ---------- running ----------
let anthropic;
async function write({ system, prompt }) {
  if (AI_PROVIDER === "groq") return groqComplete({ system, prompt, maxTokens: 800 });
  anthropic ??= new Anthropic();
  const res = await anthropic.messages.create({ model: MODEL, max_tokens: 800, system, messages: [{ role: "user", content: prompt }] });
  return res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

async function sendMessage(user, r, text) {
  if (r.channel === "whatsapp") return sendToChat(user.id, r.recipient, text);
  const p = await providerFor(user);
  return p.sendEmail({ to: [r.recipient], cc: [], subject: r.title, body: text, replyToId: null });
}

// Runs one routine now. Returns a short result line (also saved on the routine).
export async function runRoutine(r, { manual = false } = {}) {
  const user = await store.getUser(r.user_id);
  if (!user) return "User not found";
  const when = new Date().toLocaleString("en-US", { timeZone: r.time_zone, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  if (r.kind === "report") {
    let convId = r.conversation_id;
    if (!convId || !(await store.getConversation(user.id, convId))) {
      convId = (await store.createConversation(user.id)).id;
      await store.setConversationTitle(user.id, convId, `Routine: ${r.title}`);
      await query(`update routines set conversation_id = $2 where id = $1`, [r.id, convId]);
    }
    const reply = await chatTurn({
      user, conversationId: convId, timeZone: r.time_zone, channel: "routine",
      text: `[Routine "${r.title}" - ${manual ? "run now by the user" : `running automatically, ${when}`}]\n${r.instruction}`,
    });
    const preview = reply.text.replace(/[*#_`>|]/g, "").replace(/\s+/g, " ").trim();
    await notify(user.id, { title: r.title, body: preview, url: `/app#${convId}`, tag: `routine-${r.id}` }, "reminder").catch(() => 0);
    if (r.email_me) {
      const p = await providerFor(user);
      if (p.mode === "google") await p.sendEmail({ to: [user.email], cc: [], subject: `${r.title} - ${when}`, body: `${reply.text}\n\n- Thinq (routine: ${r.title}. Change or stop it in the Routines tab: ${publicUrl()}/app)`, replyToId: null }).catch((e) => console.warn("[routines] email to self failed:", e.message));
    }
    return `Done - ${preview.slice(0, 140)}`;
  }

  // message routine
  let text = r.message_text;
  if (r.write_fresh) {
    text = await write({
      system: `You write one short message that the user sends on a schedule. Write only the message itself - no quotes, no explanations, no options. Match the language and warmth the instruction asks for. Today is ${when}.`,
      prompt: `Recipient: ${r.recipient_name}\nWhat to write: ${r.instruction}`,
    });
    await store.useRequest(user.id, Number(process.env.DAILY_REQUEST_LIMIT ?? 60));
  }
  if (!text) return "Nothing to send";
  if (r.write_fresh && !r.auto_send) {
    const kind = r.channel === "whatsapp" ? "whatsapp" : "email";
    const payload = kind === "whatsapp" ? { jid: r.recipient, chat: r.recipient_name, text } : { to: [r.recipient], cc: [], subject: r.title, body: text, replyToId: null };
    const a = await store.addApproval(user.id, kind, payload, `${r.title} → ${r.recipient_name}`, null);
    await notify(user.id, { title: `Ready to send: ${r.title}`, body: `To ${r.recipient_name}: ${text}`, url: "/app", tag: `routine-${r.id}` }, "reminder").catch(() => 0);
    return `Drafted for your OK (${a.id})`;
  }
  await sendMessage(user, r, text);
  await store.logAction(user.id, "routine_sent", { id: r.id, channel: r.channel });
  return `Sent to ${r.recipient_name}`;
}

export async function runNow(userId, routineId) {
  await ensureSchema();
  const r = await one(`select * from routines where id = $1 and user_id = $2`, [routineId, userId]);
  if (!r) throw new RoutineError("No routine with that id.");
  if (r.kind === "message" && r.status !== "active") throw new RoutineError("Turn this routine on first.");
  const result = await runRoutine(r, { manual: true });
  await query(`update routines set last_result = $2 where id = $1`, [r.id, result]);
  return result;
}

async function runDue() {
  await ensureSchema();
  const due = await query(`select * from routines where status = 'active' and next_run_at <= now() order by next_run_at limit 20`);
  for (const r of due) {
    if (busy.has(r.user_id)) continue; // they're chatting right now - try again on the next tick
    const next = nextRun(r, r.time_zone, new Date());
    const claimed = await one(`update routines set next_run_at = $2, last_run_at = now(), status = $3 where id = $1 and next_run_at = $4 and status = 'active' returning id`,
      [r.id, next, next ? "active" : "done", r.next_run_at]);
    if (!claimed) continue;
    let result;
    if (Date.now() - new Date(r.next_run_at).getTime() > LATE_LIMIT_MS) result = "Skipped - Thinq's server was asleep at that time";
    else {
      try { result = await runRoutine(r); }
      catch (err) {
        result = `Didn't work: ${err instanceof TurnError || err.userFacing || err instanceof RoutineError ? err.message : friendlyError(err)}`;
        console.warn(`[routines] ${r.id} failed:`, err.message);
        await notify(r.user_id, { title: `Routine didn't run: ${r.title}`, body: result, url: "/app", tag: `routine-${r.id}` }, "reminder").catch(() => 0);
      }
    }
    await query(`update routines set last_result = $2 where id = $1`, [r.id, result]);
  }
}

export function startRoutineWorker() {
  const safe = () => runDue().catch((e) => console.warn("[routines]", e.message));
  setInterval(safe, 30_000);
  setTimeout(safe, 8_000);
}
