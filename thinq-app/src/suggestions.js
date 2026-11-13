// Starter questions for a new chat, based on what's actually going on for this person right now:
// their next meetings, who's waiting on a reply, what they asked Thinq to remember, and the time of day.
// Built from their inbox/calendar directly (no AI call), and cached for a few minutes per person.
import * as store from "./store.js";
import { providerFor } from "./providers/index.js";
import { imagesAvailable } from "./llm/images.js";

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // userId -> { at, tz, list }
export const forgetSuggestions = (userId) => cache.delete(userId);

const AUTOMATED = /no-?reply|notifications?|calendar|bot\b|mailer|newsletter|digest|updates?@|support@|team@|billing|receipts?/i;
const personName = (from = "") => {
  if (AUTOMATED.test(from)) return null;
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  const name = (m ? m[1] : from.split("@")[0]).trim();
  return name && !name.includes("@") ? name.split(/\s+/)[0] : null;
};
const short = (s, n = 32) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
const cleanSubject = (s = "") => s.replace(/^((re|fwd?|aw):\s*)+/i, "").trim();

function localParts(timeZone, date = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), weekday: p.weekday, ymd: `${p.year}-${p.month}-${p.day}` };
}
const timeIn = (iso, timeZone) => new Date(iso).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).replace(":00", "");

export async function suggestionsFor(user, timeZone) {
  const p = await providerFor(user);
  const key = `${timeZone}|${p.mode}`;
  const hit = cache.get(user.id);
  if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) return hit.list;

  const now = new Date();
  const { hour, weekday } = localParts(timeZone, now);
  const in36h = new Date(now.getTime() + 36 * 3600e3);
  const [unread, events, notes] = await Promise.all([
    p.searchEmails({ query: "in:inbox is:unread", maxResults: 15 }).catch(() => []),
    p.listEvents({ timeMin: now.toISOString(), timeMax: in36h.toISOString() }).catch(() => []),
    store.listNotes(user.id).catch(() => []),
  ]);

  const today = localParts(timeZone, now).ymd;
  const timed = events.filter((e) => !e.allDay);
  const todayEvents = timed.filter((e) => localParts(timeZone, new Date(e.start)).ymd === today);
  const tomorrowEvents = timed.filter((e) => localParts(timeZone, new Date(e.start)).ymd !== today);
  const people = unread.map((e) => ({ ...e, who: personName(e.from) })).filter((e) => e.who);

  const out = [];
  const add = (text, why) => { if (text && !out.some((s) => s.text === text) && out.length < 4) out.push({ text, why }); };

  // 1. The next meeting today (with other people)
  const next = todayEvents.find((e) => e.attendees?.length) || todayEvents[0];
  if (next) add(`Prep me for “${short(next.title, 28)}” at ${timeIn(next.start, timeZone)}`, "next meeting");

  // 2. A real person waiting on a reply
  if (people[0]) add(`Draft a reply to ${people[0].who} about “${short(cleanSubject(people[0].subject), 26)}”`, "unread from a person");

  // 3. Inbox triage
  if (unread.length >= 3) add(`Summarize my ${unread.length >= 15 ? "15+" : unread.length} unread emails`, "unread count");
  else if (unread.length) add("What needs a reply from me?", "a few unread");
  else add("Anything important in my inbox this week?", "inbox clear");

  // 4. Time of day / week
  if (weekday === "Fri" && hour >= 12) add("Recap my week and plan next week", "Friday afternoon");
  else if (hour < 11) add(todayEvents.length > 1 ? `Plan my day around my ${todayEvents.length} meetings` : "Plan my day", "morning");
  else if (hour >= 17) add(tomorrowEvents.length ? `What should I prepare for tomorrow’s ${tomorrowEvents.length} meeting${tomorrowEvents.length > 1 ? "s" : ""}?` : "What’s on my calendar tomorrow?", "evening");
  else add(todayEvents.length > 1 ? "What’s left on my calendar today?" : "Find a free hour for focus work this week", "afternoon");

  // 5. Someone they hear from - suggest finding time with them
  const other = people.find((e) => e.who !== people[0]?.who) || people[0];
  if (other) add(`Find 30 minutes with ${other.who} this week`, "frequent contact");

  // 6. Fillers that still fit the person
  if (!notes.length) add("Remember how I like to sign my emails", "no preferences yet");
  if (imagesAvailable()) add("Make an image for my next presentation", "images on");
  add("Draft replies to my unread emails", "default");
  add("Plan my day", "default");

  cache.set(user.id, { at: Date.now(), key, list: out });
  return out;
}
