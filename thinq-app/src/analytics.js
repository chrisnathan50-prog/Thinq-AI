// Usage analytics for admins: who uses Thinq and how. Counts only - never anyone's messages, emails or files.
// Days are UTC calendar days. Sources: usage_daily (AI requests, kept even when chats are deleted),
// action_log (tools, voice notes, documents, sends), users, and the Google/WhatsApp connection tables.
import { query } from "./db.js";

const FEATURES = {
  "tool:search_inbox": "Searched inbox",
  "tool:read_email": "Read an email",
  "tool:list_events": "Checked calendar",
  "tool:find_free_time": "Found free time",
  "tool:draft_email": "Drafted an email",
  "tool:propose_event": "Prepared an invite",
  "tool:remember": "Saved a preference",
  "tool:read_document": "Read a document",
  "tool:create_image": "Created an image",
  voice_note: "Voice notes",
  document_added: "Documents attached",
  email_sent: "Emails sent (approved)",
  event_created: "Invites sent (approved)",
  declined: "Drafts discarded",
  bot_created: "Group bots built",
  routine_created: "Routines set up",
  routine_sent: "Routine messages sent",
  bot_answer: "Group bot answers",
  bot_reminder: "Group reminders posted",
};

const n = (v) => Number(v || 0);

export async function analytics(days = 30) {
  days = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const since = `current_date - ${days - 1}`;

  // Everyone who did something on a day: an AI request, or any logged action (tools, sign-ins, sends...).
  const activity = `(
    select user_id, day from usage_daily where requests > 0
    union select user_id, (created_at at time zone 'UTC')::date as day from action_log where user_id is not null
  )`;

  const [totals, daily, featureRows, channelRows, people, signups] = await Promise.all([
    query(`select
      (select count(*) from users) as users,
      (select count(*) from users where created_at >= ${since}) as new_users,
      (select count(distinct user_id) from ${activity} a where day = current_date) as active_today,
      (select count(distinct user_id) from ${activity} a where day >= current_date - 6) as active_7,
      (select count(distinct user_id) from ${activity} a where day >= ${since}) as active_period,
      (select coalesce(sum(requests), 0) from usage_daily where day >= ${since}) as requests,
      (select coalesce(sum(requests), 0) from usage_daily where day = current_date) as requests_today,
      (select count(*) from google_connections) as gmail,
      (select count(*) from whatsapp_links) as whatsapp,
      (select count(*) from testers where status = 'pending') as testers_pending,
      (select count(*) from testers where status = 'approved') as testers_approved`),
    query(`select d::date as day,
        (select count(distinct user_id) from ${activity} a where a.day = d::date) as active,
        (select coalesce(sum(requests), 0) from usage_daily u where u.day = d::date) as requests
      from generate_series(${since}, current_date, interval '1 day') d order by d`),
    query(`select case when kind = 'tool' then 'tool:' || (detail->>'tool') else kind end as feature, count(*) as n, count(distinct user_id) as people
      from action_log where created_at >= ${since} group by 1`),
    query(`select coalesce(detail->>'channel', 'app') as channel, count(*) as n from action_log
      where kind = 'turn' and created_at >= ${since} group by 1`),
    query(`select u.id, u.name, u.email, u.created_at, u.last_login_at,
        (select max(day) from ${activity} a where a.user_id = u.id) as last_active,
        (select coalesce(sum(requests), 0) from usage_daily x where x.user_id = u.id and x.day >= ${since}) as requests,
        (select coalesce(sum(requests), 0) from usage_daily x where x.user_id = u.id and x.day = current_date) as requests_today,
        (select count(distinct day) from ${activity} a where a.user_id = u.id and a.day >= ${since}) as active_days,
        (select count(*) from conversations c where c.user_id = u.id) as chats,
        (select count(*) from action_log l where l.user_id = u.id and l.kind in ('email_sent', 'event_created') and l.created_at >= ${since}) as sent,
        (select detail->>'tool' from action_log l where l.user_id = u.id and l.kind = 'tool' and l.created_at >= ${since}
           group by detail->>'tool' order by count(*) desc limit 1) as top_tool,
        exists (select 1 from google_connections g where g.user_id = u.id) as gmail,
        exists (select 1 from whatsapp_links w where w.user_id = u.id) as whatsapp
      from users u order by last_active desc nulls last, u.created_at desc limit 500`),
    query(`select (created_at at time zone 'UTC')::date as day, count(*) as n from users where created_at >= ${since} group by 1`),
  ]);

  const t = totals[0];
  const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  return {
    days,
    generatedAt: new Date().toISOString(),
    totals: {
      users: n(t.users), newUsers: n(t.new_users), activeToday: n(t.active_today), active7: n(t.active_7), activePeriod: n(t.active_period),
      requests: n(t.requests), requestsToday: n(t.requests_today), gmail: n(t.gmail), whatsapp: n(t.whatsapp),
      testersPending: n(t.testers_pending), testersApproved: n(t.testers_approved),
    },
    daily: daily.map((r) => ({ day: iso(r.day), active: n(r.active), requests: n(r.requests), signups: n(signups.find((s) => iso(s.day) === iso(r.day))?.n) })),
    features: featureRows
      .filter((r) => FEATURES[r.feature])
      .map((r) => ({ key: r.feature, label: FEATURES[r.feature], count: n(r.n), people: n(r.people) }))
      .sort((a, b) => b.count - a.count),
    channels: Object.fromEntries(channelRows.map((r) => [r.channel, n(r.n)])),
    people: people.map((p) => ({
      name: p.name, email: p.email, joined: p.created_at, lastActive: p.last_active ? iso(p.last_active) : null,
      requests: n(p.requests), requestsToday: n(p.requests_today), activeDays: n(p.active_days), chats: n(p.chats), sent: n(p.sent),
      topFeature: p.top_tool ? FEATURES[`tool:${p.top_tool}`] || p.top_tool : null, gmail: p.gmail, whatsapp: p.whatsapp,
    })),
  };
}
