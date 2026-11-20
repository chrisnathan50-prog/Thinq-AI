// Search across everything the person has in Thinq: past chats, meeting notes (and transcripts), and the text of
// documents and photos they attached. Used by the sidebar search box and by the AI's search_history tool
// ("what did we decide about pricing last week?").
//
// Plain word search (every word must appear, any order, case-insensitive). Newest first.
import { query } from "./db.js";

const MAX_WORDS = 8;
const like = (w) => `%${w.replace(/[%_\\]/g, "\\$&")}%`;

export function words(q) {
  return [...new Set(String(q || "").toLowerCase().replace(/["'“”‘’]/g, " ").split(/\s+/).filter((w) => w.length > 1))].slice(0, MAX_WORDS);
}

// A short piece of text around the first matching word.
export function snippet(text, ws, size = 180) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const low = t.toLowerCase();
  let at = -1;
  for (const w of ws) { const i = low.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return t.slice(0, size) + (t.length > size ? "…" : "");
  const start = Math.max(0, at - Math.floor(size / 3));
  const end = Math.min(t.length, start + size);
  return (start > 0 ? "…" : "") + t.slice(start, end).trim() + (end < t.length ? "…" : "");
}

/**
 * Returns [{ type: "chat"|"meeting"|"document", id, conversationId?, title, snippet, at, role? }], newest first.
 * kinds: which sources to search (default all). sinceDays: only things from the last N days.
 */
export async function searchEverything(userId, q, { kinds = ["chat", "meeting", "document"], sinceDays, limit = 20 } = {}) {
  const ws = words(q);
  if (!ws.length) return [];
  const since = sinceDays ? new Date(Date.now() - sinceDays * 864e5) : new Date(0);
  const conds = (col, from) => ws.map((_, i) => `${col} ilike $${from + i}`).join(" and ");
  const params = [userId, since, ...ws.map(like)];
  const jobs = [];

  if (kinds.includes("chat")) {
    // One hit per chat: the newest matching message, plus chats whose title matches.
    jobs.push(query(`select distinct on (c.id) c.id as conversation_id, c.title, m.role, m.text, m.created_at
      from messages m join conversations c on c.id = m.conversation_id
      where c.user_id = $1 and m.created_at >= $2 and ((${conds("m.text", 3)}) or (${conds("c.title", 3)}))
      order by c.id, m.created_at desc`, params).then((rows) => rows.map((r) => ({
      type: "chat", id: r.conversation_id, conversationId: r.conversation_id, title: r.title, role: r.role, snippet: snippet(r.text, ws), at: r.created_at,
    }))));
  }
  if (kinds.includes("meeting")) {
    jobs.push(query(`select id, title, summary, transcript, coalesce(started_at, join_at, created_at) as at from meetings
      where user_id = $1 and coalesce(started_at, join_at, created_at) >= $2
        and ((${conds("coalesce(summary,'')", 3)}) or (${conds("coalesce(transcript,'')", 3)}) or (${conds("coalesce(title,'')", 3)}))
      order by at desc limit 40`, params).then((rows) => rows.map((r) => {
      const inNotes = ws.every((w) => `${r.title} ${r.summary || ""}`.toLowerCase().includes(w));
      return { type: "meeting", id: r.id, title: r.title || "Meeting", snippet: snippet(inNotes ? r.summary || r.title : r.transcript, ws), inTranscript: !inNotes, at: r.at };
    })));
  }
  if (kinds.includes("document")) {
    jobs.push(query(`select id, name, text, conversation_id, created_at from documents
      where user_id = $1 and conversation_id is not null and created_at >= $2 and ((${conds("text", 3)}) or (${conds("name", 3)}))
      order by created_at desc limit 40`, params).then((rows) => rows.map((r) => ({
      type: "document", id: r.id, conversationId: r.conversation_id, title: r.name, snippet: snippet(r.text, ws), at: r.created_at,
    }))));
  }
  const all = (await Promise.all(jobs)).flat();
  return all.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
}
