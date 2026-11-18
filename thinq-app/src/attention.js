// "Needs your attention" counts: drafts waiting in Approvals, routines waiting for Turn on, and chats with a
// result the person hasn't opened yet (routine results). Shown as a number on the app icon, in the tab title
// and on the side-panel tabs, and sent with every push notification so the icon updates while Thinq is closed.
import { query, one } from "./db.js";
import { countNeedingOk } from "./routines.js";

export async function attention(userId) {
  const [approvals, unread, routines] = await Promise.all([
    one(`select count(*)::int as n from approvals where user_id = $1 and status = 'pending'`, [userId]),
    query(`select id from conversations where user_id = $1 and unread`, [userId]),
    countNeedingOk(userId).catch(() => 0),
  ]);
  const unreadChats = unread.map((r) => r.id);
  return { approvals: approvals.n, routines, unreadChats, total: approvals.n + routines + unreadChats.length };
}

// A routine posted a result while the person wasn't looking.
export const markUnread = (conversationId) => query(`update conversations set unread = true where id = $1`, [conversationId]);
// They opened the chat.
export const markRead = (userId, conversationId) =>
  query(`update conversations set unread = false where id = $1 and user_id = $2 and unread`, [conversationId, userId]);
