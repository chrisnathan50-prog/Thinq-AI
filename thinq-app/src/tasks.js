// Tasks and follow-ups: the to-do list Thinq keeps for the person.
//
//   todo      - something the person has to do ("Send Priya the contract", due Friday). Added by asking Thinq,
//               typed into the Tasks tab, or suggested from a meeting's action items.
//   waiting   - something the person is waiting on from someone else ("Priya to reply about the contract").
//               When it's tied to an email thread, Thinq checks Gmail and closes it by itself when they reply.
//               Without a reply by the "nudge" date, the person gets a notification offering a follow-up.
//
// status: open | done | suggested (from a meeting, waiting for the person to tap Add) | dismissed.
// A todo with a due date gets one notification when it's due (09:00 on the day when no time was given).
import { query, one } from "./db.js";
import { id } from "./secrets.js";
import * as store from "./store.js";
import { validTimeZone } from "./bots.js";
import { notify } from "./notify.js";
import { providerFor } from "./providers/index.js";

export const MAX_OPEN_TASKS = 300;
export class TaskError extends Error {}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;
const DEFAULT_REMIND_TIME = "09:00";
const REPLY_CHECK_MINUTES = 20; // how often one waiting-on thread is checked in Gmail

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await query(`create table if not exists tasks (
    id text primary key,
    user_id text not null references users(id) on delete cascade,
    kind text not null default 'todo',
    title text not null,
    notes text,
    status text not null default 'open',
    due_date text,
    due_time text,
    remind_at timestamptz,
    reminded_at timestamptz,
    time_zone text not null default 'UTC',
    person text,
    email_thread_id text,
    waiting_since timestamptz,
    replied_at timestamptz,
    reply_from text,
    checked_at timestamptz,
    source text not null default 'chat',
    source_ref text,
    source_label text,
    created_at timestamptz not null default now(),
    done_at timestamptz
  )`);
  await query(`create index if not exists tasks_user on tasks(user_id, status)`);
  await query(`create index if not exists tasks_remind on tasks(remind_at) where status = 'open' and reminded_at is null`);
  await query(`create index if not exists tasks_thread on tasks(checked_at) where status = 'open' and kind = 'waiting' and email_thread_id is not null`);
  schemaReady = true;
}

// ---------- time helpers ----------
function offsetMinutes(timeZone, date) {
  const s = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(date).find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = s.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
}
// "2026-11-21" + "14:30" in Europe/London -> the exact moment.
export function zonedTime(ymd, hm, timeZone) {
  const [y, mo, d] = ymd.split("-").map(Number), [h, mi] = hm.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall;
  for (let i = 0; i < 2; i++) t = wall - offsetMinutes(timeZone, new Date(t)) * 60_000;
  return new Date(t);
}
export function localDate(timeZone, date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function dueFields(dueDate, dueTime, timeZone) {
  if (dueDate == null || dueDate === "") return { due_date: null, due_time: null, remind_at: null };
  if (!DATE.test(dueDate)) throw new TaskError(`"${dueDate}" isn't a date (use YYYY-MM-DD).`);
  if (dueTime && !TIME.test(dueTime)) throw new TaskError(`"${dueTime}" isn't a time (use HH:MM, 24-hour).`);
  const time = dueTime ? dueTime.padStart(5, "0") : null;
  return { due_date: dueDate, due_time: time, remind_at: zonedTime(dueDate, time || DEFAULT_REMIND_TIME, timeZone) };
}

// ---------- shaping ----------
export function taskOut(t) {
  return {
    id: t.id, kind: t.kind, title: t.title, notes: t.notes, status: t.status,
    dueDate: t.due_date, dueTime: t.due_time, timeZone: t.time_zone,
    person: t.person, emailThreadId: t.email_thread_id, waitingSince: t.waiting_since, repliedAt: t.replied_at, replyFrom: t.reply_from,
    source: t.source, sourceRef: t.source_ref, sourceLabel: t.source_label,
    createdAt: t.created_at, doneAt: t.done_at,
  };
}

// ---------- create / change ----------
export async function addTask(userId, input) {
  await ensureSchema();
  const n = (await one(`select count(*)::int as n from tasks where user_id = $1 and status in ('open','suggested')`, [userId])).n;
  if (n >= MAX_OPEN_TASKS) throw new TaskError(`You have ${MAX_OPEN_TASKS} open tasks. Finish or delete some first.`);
  const title = String(input.title || "").trim().slice(0, 300);
  if (!title) throw new TaskError("Say what the task is.");
  const tz = validTimeZone(input.timeZone) ? input.timeZone : "UTC";
  const kind = input.kind === "waiting" ? "waiting" : "todo";
  const due = dueFields(input.dueDate, input.dueTime, tz);
  const t = await one(`insert into tasks (id, user_id, kind, title, notes, status, due_date, due_time, remind_at, time_zone, person, email_thread_id, waiting_since, source, source_ref, source_label)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
    [id("tsk"), userId, kind, title, input.notes ? String(input.notes).slice(0, 2000) : null, input.status === "suggested" ? "suggested" : "open",
      due.due_date, due.due_time, due.remind_at, tz,
      input.person ? String(input.person).slice(0, 120) : null, kind === "waiting" && input.emailThreadId ? String(input.emailThreadId) : null,
      kind === "waiting" ? (input.waitingSince ? new Date(input.waitingSince) : new Date()) : null,
      input.source || "chat", input.sourceRef || null, input.sourceLabel ? String(input.sourceLabel).slice(0, 120) : null]);
  if (t.status === "open") await store.logAction(userId, "task_added", { id: t.id, kind, source: t.source });
  return taskOut(t);
}

export async function updateTask(userId, taskId, patch) {
  await ensureSchema();
  const t = await one(`select * from tasks where id = $1 and user_id = $2`, [taskId, userId]);
  if (!t) throw new TaskError("No task with that id.");
  const f = {};
  if (patch.title != null) { const s = String(patch.title).trim().slice(0, 300); if (!s) throw new TaskError("A task needs a title."); f.title = s; }
  if (patch.notes !== undefined) f.notes = patch.notes ? String(patch.notes).slice(0, 2000) : null;
  if (patch.person !== undefined) f.person = patch.person ? String(patch.person).slice(0, 120) : null;
  if (patch.dueDate !== undefined || patch.dueTime !== undefined) {
    Object.assign(f, dueFields(patch.dueDate !== undefined ? patch.dueDate : t.due_date, patch.dueTime !== undefined ? patch.dueTime : t.due_time, t.time_zone));
    f.reminded_at = null; // a new due time gets its own reminder
  }
  if (patch.status && patch.status !== t.status) {
    if (!["open", "done", "dismissed"].includes(patch.status)) throw new TaskError("Status can be open, done or dismissed.");
    f.status = patch.status;
    f.done_at = patch.status === "done" ? new Date() : null;
    if (patch.status === "open" && t.status === "suggested") await store.logAction(userId, "task_added", { id: t.id, kind: t.kind, source: t.source });
    if (patch.status === "done") await store.logAction(userId, "task_done", { id: t.id, kind: t.kind });
  }
  const keys = Object.keys(f);
  if (keys.length) await query(`update tasks set ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")} where id = $1 and user_id = $2`, [taskId, userId, ...keys.map((k) => f[k])]);
  return taskOut(await one(`select * from tasks where id = $1`, [taskId]));
}

export async function deleteTask(userId, taskId) {
  await ensureSchema();
  await query(`delete from tasks where id = $1 and user_id = $2`, [taskId, userId]);
}

// Open + suggested tasks, plus the most recently finished ones.
export async function listTasks(userId, { includeDone = true, doneLimit = 15 } = {}) {
  await ensureSchema();
  const open = await query(`select * from tasks where user_id = $1 and status in ('open','suggested')
    order by status = 'suggested', due_date nulls last, due_time nulls last, created_at`, [userId]);
  const done = includeDone ? await query(`select * from tasks where user_id = $1 and status = 'done' order by done_at desc limit $2`, [userId, doneLimit]) : [];
  return [...open, ...done].map(taskOut);
}

// Find tasks by id or words in the title (for the AI's update tool).
export async function findTasks(userId, text) {
  await ensureSchema();
  const exact = await one(`select * from tasks where id = $1 and user_id = $2`, [text, userId]);
  if (exact) return [taskOut(exact)];
  return (await query(`select * from tasks where user_id = $1 and status in ('open','suggested') and title ilike $2 order by created_at desc limit 5`,
    [userId, `%${String(text).replace(/[%_\\]/g, "\\$&")}%`])).map(taskOut);
}

// For the AI's context and the "Plan my day" view: what's overdue, due today, and what they're waiting on.
export async function agendaFor(userId, timeZone) {
  await ensureSchema();
  const today = localDate(timeZone);
  const rows = await query(`select * from tasks where user_id = $1 and status = 'open' and (kind = 'waiting' or (due_date is not null and due_date <= $2))
    order by due_date nulls last, due_time nulls last limit 30`, [userId, addDays(today, 1)]);
  const counts = await one(`select count(*) filter (where status = 'open')::int as open, count(*) filter (where status = 'suggested')::int as suggested from tasks where user_id = $1`, [userId]);
  return {
    today,
    overdue: rows.filter((t) => t.kind === "todo" && t.due_date < today).map(taskOut),
    dueToday: rows.filter((t) => t.kind === "todo" && t.due_date === today).map(taskOut),
    dueTomorrow: rows.filter((t) => t.kind === "todo" && t.due_date > today).map(taskOut),
    waiting: rows.filter((t) => t.kind === "waiting").map(taskOut),
    open: counts.open, suggested: counts.suggested,
  };
}

// For the side-panel badge: overdue or due today, plus meeting suggestions waiting for Add.
export async function countNeedingAttention(userId, timeZone = "UTC") {
  await ensureSchema();
  const today = localDate(validTimeZone(timeZone) ? timeZone : "UTC");
  return (await one(`select count(*)::int as n from tasks where user_id = $1 and (status = 'suggested' or (status = 'open' and kind = 'todo' and due_date <= $2))`, [userId, today])).n;
}

// ---------- after an approved email goes out ----------
// draft_email can ask Thinq to watch for a reply: the sent email becomes a "waiting on" task tied to its thread.
export async function trackReply(user, { threadId, to, subject, days, timeZone }) {
  if (!threadId) return null;
  const tz = validTimeZone(timeZone) ? timeZone : "UTC";
  const who = (Array.isArray(to) ? to : [to]).filter(Boolean).join(", ");
  return addTask(user.id, {
    kind: "waiting", title: `Reply from ${who}: ${subject || "(no subject)"}`.slice(0, 300), person: who, emailThreadId: threadId,
    dueDate: addDays(localDate(tz), Math.max(1, Math.min(30, Number(days) || 3))), timeZone: tz, source: "email", sourceLabel: subject,
  });
}

// ---------- from meeting notes ----------
// Pulls the "Action items" bullets out of a meeting summary and saves the ones that are the user's (or have no
// clear owner) as suggestions. They show in the Tasks tab with Add / Dismiss - nothing lands on the list unasked.
export function parseActionItems(summary) {
  const m = String(summary || "").match(/\*\*Action items\*\*[^\n]*\n([\s\S]*?)(?:\n\s*\*\*[A-Z][^*]*\*\*|$)/);
  if (!m) return [];
  return m[1].split("\n").map((l) => l.replace(/^\s*[-*•]\s+/, "").trim()).filter(Boolean).map((line) => {
    const parts = line.split(/\s+[-–—:]\s+/);
    return parts.length > 1 ? { owner: parts[0].replace(/\*\*/g, "").trim(), task: parts.slice(1).join(" - ").trim() } : { owner: "", task: line };
  }).filter((a) => a.task.length > 2);
}
export async function suggestFromMeeting(meeting, user) {
  await ensureSchema();
  if (!meeting?.summary || !user) return 0;
  const done = await one(`select 1 from tasks where user_id = $1 and source = 'meeting' and source_ref = $2 limit 1`, [user.id, meeting.id]);
  if (done) return 0; // already suggested (summaries can be rewritten)
  const first = String(user.name || "").split(/\s+/)[0].toLowerCase();
  const mine = (owner) => {
    const o = owner.toLowerCase();
    return !o || /unclear|unknown|unassigned|^(i|me|you|we|everyone|all)$/.test(o) || (first && o.split(/[\s,/&]+/).includes(first));
  };
  let n = 0;
  for (const a of parseActionItems(meeting.summary).filter((x) => mine(x.owner)).slice(0, 12)) {
    await addTask(user.id, { title: a.task, notes: a.owner && !/unclear/i.test(a.owner) ? `Owner: ${a.owner}` : null, status: "suggested", source: "meeting",
      sourceRef: meeting.id, sourceLabel: meeting.title, timeZone: "UTC" }).catch(() => null);
    n++;
  }
  return n;
}

// ---------- background: due reminders and reply checks ----------
async function remindDue() {
  await ensureSchema();
  const due = await query(`select * from tasks where status = 'open' and kind = 'todo' and reminded_at is null and remind_at <= now() order by remind_at limit 50`);
  for (const t of due) {
    const claimed = await one(`update tasks set reminded_at = now() where id = $1 and reminded_at is null returning id`, [t.id]);
    if (!claimed) continue;
    if (Date.now() - new Date(t.remind_at).getTime() > 6 * 3600e3) continue; // server was asleep: don't send a stale ping
    await notify(t.user_id, { title: t.due_time ? `Due now: ${t.title}` : `Due today: ${t.title}`, body: t.notes || "Open Tasks to tick it off.", url: "/app#tasks", tag: `task-${t.id}` }, "reminder").catch(() => 0);
  }
  // Waiting-on without a reply by its nudge date
  const late = await query(`select * from tasks where status = 'open' and kind = 'waiting' and reminded_at is null and remind_at <= now() order by remind_at limit 50`);
  for (const t of late) {
    const claimed = await one(`update tasks set reminded_at = now() where id = $1 and reminded_at is null returning id`, [t.id]);
    if (!claimed) continue;
    await notify(t.user_id, { title: `Still waiting: ${t.person || "a reply"}`, body: `${t.title}. Want Thinq to draft a friendly nudge?`, url: "/app#tasks", tag: `task-${t.id}` }, "reminder").catch(() => 0);
  }
}

async function checkReplies() {
  await ensureSchema();
  const list = await query(`select * from tasks where status = 'open' and kind = 'waiting' and email_thread_id is not null
    and (checked_at is null or checked_at < now() - make_interval(mins => $1)) order by checked_at nulls first limit 25`, [REPLY_CHECK_MINUTES]);
  for (const t of list) {
    await query(`update tasks set checked_at = now() where id = $1`, [t.id]);
    try {
      const user = await store.getUser(t.user_id);
      if (!user) continue;
      const p = await providerFor(user);
      if (p.mode !== "google" || !p.threadReplies) continue;
      const replies = await p.threadReplies({ threadId: t.email_thread_id, after: t.waiting_since || t.created_at });
      if (!replies.length) continue;
      const r = replies[replies.length - 1];
      const fromName = (r.from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] || r.from).trim();
      await query(`update tasks set status = 'done', done_at = now(), replied_at = $2, reply_from = $3 where id = $1 and status = 'open'`, [t.id, r.date, fromName]);
      await store.logAction(t.user_id, "task_reply_detected", { id: t.id });
      await notify(t.user_id, { title: `${fromName} replied`, body: `${r.subject || t.title}: ${r.snippet || ""}`, url: "/app#tasks", tag: `task-${t.id}` }, "email").catch(() => 0);
    } catch (err) {
      console.warn("[tasks] reply check failed:", err.message);
    }
  }
}

export function startTaskWorker() {
  const safe = (fn) => () => fn().catch((e) => console.warn("[tasks]", e.message));
  setInterval(safe(remindDue), 30_000);
  setInterval(safe(checkReplies), 60_000);
  setTimeout(safe(remindDue), 10_000);
}

export { remindDue as _remindDue, checkReplies as _checkReplies, addDays };
