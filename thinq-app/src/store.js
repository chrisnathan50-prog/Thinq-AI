// Everything Thinq stores, always scoped to one user: conversations, approvals, remembered notes,
// Google connections (encrypted), sessions and daily usage.
import { query, one } from "./db.js";
import { id, encrypt, decrypt, hash, newToken } from "./secrets.js";

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

// ---------- users ----------
export async function upsertGoogleUser({ sub, email, name, picture }) {
  const existing = await one(`select * from users where google_sub = $1 or lower(email) = lower($2) limit 1`, [sub, email]);
  if (existing) {
    return one(`update users set google_sub = $2, email = $3, name = $4, picture = $5, last_login_at = now() where id = $1 returning *`,
      [existing.id, sub, email, name, picture]);
  }
  return one(`insert into users (id, email, name, picture, google_sub, last_login_at) values ($1, $2, $3, $4, $5, now()) returning *`,
    [id("usr"), email, name, picture, sub]);
}
export const getUser = (userId) => one(`select * from users where id = $1`, [userId]);
export const countUsers = async () => Number((await one(`select count(*)::int as n from users`)).n);

// ---------- sessions (cookie holds a random token; we store only its hash) ----------
const SESSION_DAYS = 30;
export async function createSession(userId) {
  const token = newToken();
  await query(`insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`, [hash(token), userId]);
  return { token, maxAgeMs: SESSION_DAYS * 864e5 };
}
export async function userForSession(token) {
  if (!token) return null;
  return one(`select u.* from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()`, [hash(token)]);
}
export const deleteSession = (token) => query(`delete from sessions where token_hash = $1`, [hash(token)]);

// ---------- Google connection (Gmail + Calendar tokens, encrypted at rest) ----------
export async function getGoogle(userId) {
  const row = await one(`select * from google_connections where user_id = $1`, [userId]);
  return row ? { email: row.email, tokens: decrypt(row.tokens_enc) } : null;
}
export async function setGoogle(userId, { email, tokens }) {
  await query(
    `insert into google_connections (user_id, email, tokens_enc, updated_at) values ($1, $2, $3, now())
     on conflict (user_id) do update set email = excluded.email, tokens_enc = excluded.tokens_enc, updated_at = now()`,
    [userId, email, encrypt(tokens)]);
}
export async function updateGoogleTokens(userId, newTokens) {
  const cur = await getGoogle(userId);
  if (cur) await setGoogle(userId, { email: cur.email, tokens: { ...cur.tokens, ...newTokens } });
}
export const deleteGoogle = (userId) => query(`delete from google_connections where user_id = $1`, [userId]);

// ---------- conversations ----------
export async function createConversation(userId) {
  const c = await one(`insert into conversations (id, user_id) values ($1, $2) returning *`, [id("conv"), userId]);
  return { id: c.id, title: c.title, createdAt: iso(c.created_at), messages: [] };
}
export async function getConversation(userId, conversationId) {
  const c = await one(`select * from conversations where id = $1 and user_id = $2`, [conversationId, userId]);
  if (!c) return null;
  const msgs = await query(`select role, text, attachments, created_at from messages where conversation_id = $1 order by id`, [c.id]);
  return { id: c.id, title: c.title, createdAt: iso(c.created_at), messages: msgs.map((m) => ({ role: m.role, text: m.text, attachments: m.attachments || [], at: iso(m.created_at) })) };
}
export async function appendMessage(userId, conversationId, role, text, attachments = null) {
  await query(`insert into messages (conversation_id, role, text, attachments) select id, $3, $4, $5 from conversations where id = $1 and user_id = $2`,
    [conversationId, userId, role, text, attachments?.length ? JSON.stringify(attachments) : null]);
  if (role === "user") await query(`update conversations set title = $3 where id = $1 and user_id = $2 and title = 'New conversation'`, [conversationId, userId, text.slice(0, 60)]);
}
export async function listConversations(userId) {
  const rows = await query(
    `select c.id, c.title, c.created_at from conversations c
     where c.user_id = $1 and exists (select 1 from messages m where m.conversation_id = c.id)
     order by c.created_at desc limit 100`, [userId]);
  return rows.map((r) => ({ id: r.id, title: r.title, createdAt: iso(r.created_at) }));
}

// ---------- approvals ----------
const approvalOut = (a) => a && ({
  id: a.id, kind: a.kind, payload: a.payload, summary: a.summary, status: a.status, result: a.result, error: a.error, mode: a.mode,
  conversationId: a.conversation_id, createdAt: iso(a.created_at), updatedAt: iso(a.updated_at),
});
export async function addApproval(userId, kind, payload, summary, conversationId) {
  return approvalOut(await one(`insert into approvals (id, user_id, conversation_id, kind, payload, summary) values ($1, $2, $3, $4, $5, $6) returning *`,
    [id("apv"), userId, conversationId, kind, JSON.stringify(payload), summary]));
}
export async function listApprovals(userId) {
  return (await query(`select * from approvals where user_id = $1 order by created_at desc limit 50`, [userId])).map(approvalOut);
}
export const getApproval = async (userId, approvalId) => approvalOut(await one(`select * from approvals where id = $1 and user_id = $2`, [approvalId, userId]));
export async function updateApproval(userId, approvalId, patch) {
  const cols = { payload: "payload", status: "status", result: "result", error: "error", mode: "mode" };
  const sets = [], vals = [approvalId, userId];
  for (const [k, col] of Object.entries(cols)) {
    if (k in patch) { vals.push(k === "payload" || k === "result" ? JSON.stringify(patch[k]) : patch[k]); sets.push(`${col} = $${vals.length}`); }
  }
  return approvalOut(await one(`update approvals set ${sets.join(", ")}, updated_at = now() where id = $1 and user_id = $2 returning *`, vals));
}
// Claim a pending approval atomically, so a double-click can never send twice.
export async function claimApproval(userId, approvalId) {
  return approvalOut(await one(`update approvals set status = 'sending', error = null, updated_at = now() where id = $1 and user_id = $2 and status = 'pending' returning *`, [approvalId, userId]));
}

// ---------- remembered notes ----------
export async function addNote(userId, text) {
  return one(`insert into notes (id, user_id, text) values ($1, $2, $3) returning id, text`, [id("note"), userId, text]);
}
export const listNotes = (userId) => query(`select id, text from notes where user_id = $1 order by created_at`, [userId]);
export const deleteNote = (userId, noteId) => query(`delete from notes where id = $1 and user_id = $2`, [noteId, userId]);

// ---------- activity log ----------
export const logAction = (userId, kind, detail = {}) =>
  query(`insert into action_log (user_id, kind, detail) values ($1, $2, $3)`, [userId, kind, JSON.stringify(detail)]).catch(() => {});

// ---------- daily usage limits ----------
export async function useRequest(userId, limit) {
  const row = await one(
    `insert into usage_daily (user_id, day, requests) values ($1, current_date, 1)
     on conflict (user_id, day) do update set requests = usage_daily.requests + 1 returning requests`, [userId]);
  return { used: row.requests, allowed: !limit || row.requests <= limit };
}
export const usageToday = async (userId) => (await one(`select requests from usage_daily where user_id = $1 and day = current_date`, [userId]))?.requests ?? 0;

// ---------- documents (extracted text only; the original file isn't kept) ----------
const docOut = (d) => d && ({ id: d.id, name: d.name, pages: d.pages, chars: d.chars, sizeBytes: d.size_bytes, conversationId: d.conversation_id, createdAt: iso(d.created_at) });
export async function addDocument(userId, { name, sizeBytes, pages, text }) {
  return docOut(await one(`insert into documents (id, user_id, name, size_bytes, pages, chars, text) values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [id("doc"), userId, name.slice(0, 200), sizeBytes, pages, text.length, text]));
}
export async function getDocumentText(userId, docId) {
  return one(`select id, name, pages, chars, text from documents where id = $1 and user_id = $2`, [docId, userId]);
}
export async function ownedDocuments(userId, ids) {
  if (!ids?.length) return [];
  return (await query(`select * from documents where user_id = $1 and id = any($2::text[])`, [userId, ids])).map(docOut);
}
export async function attachDocuments(userId, conversationId, ids) {
  if (!ids?.length) return;
  await query(`update documents set conversation_id = $3 where user_id = $1 and id = any($2::text[]) and (conversation_id is null or conversation_id = $3)`, [userId, ids, conversationId]);
}
export async function conversationDocuments(userId, conversationId) {
  return (await query(`select * from documents where user_id = $1 and conversation_id = $2 order by created_at`, [userId, conversationId])).map(docOut);
}
export const deleteDocument = (userId, docId) => query(`delete from documents where id = $1 and user_id = $2`, [docId, userId]);
