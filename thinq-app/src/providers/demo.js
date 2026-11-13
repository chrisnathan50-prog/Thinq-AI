// Demo mode: a realistic sample inbox and calendar so you can try Thinq before connecting Google.
// "Sending" and "booking" here only update this sample data - nothing leaves your machine.

const dayOffset = (days, hour = 9, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d;
};

// Each user gets their own copy of the sample data, addressed to them.
export function createDemo(user) {
const ME = { name: user?.name || "Alex Rivera", email: user?.email || "alex@example.com" };
const first = ME.name.split(" ")[0];

const emails = [
  {
    id: "demo-1", threadId: "t1", unread: true, date: dayOffset(0, 8, 12),
    from: "Priya Shah <priya@northwind.example>", to: ME.email,
    subject: "Q3 report — can we review Thursday?",
    body: `Hi ${first},\n\nThe Q3 numbers are in. Could we go through the draft report together on Thursday? Any time after 1pm works for me. I'd like to send it to the board on Friday.\n\nThanks,\nPriya`,
  },
  {
    id: "demo-2", threadId: "t2", unread: true, date: dayOffset(0, 7, 40),
    from: "Marcus Hale <marcus@magnolia.example>", to: ME.email,
    subject: "Pricing question before we sign",
    body: `Hey ${first},\n\nWe're ready to move forward with the Team plan for 12 seats. Two quick questions: is there a discount for paying yearly, and can we add seats mid-contract?\n\nBest,\nMarcus`,
  },
  {
    id: "demo-3", threadId: "t3", unread: false, date: dayOffset(-1, 16, 5),
    from: "Elena Costa <elena@epicurious.example>", to: ME.email,
    subject: "Campaign brief attached",
    body: `${first} — here's the brief for the spring campaign. Main points: launch April 2, three emails and a landing page, budget $18k. I need your feedback by Wednesday so design can start.\n\nElena`,
  },
  {
    id: "demo-4", threadId: "t4", unread: true, date: dayOffset(-1, 11, 30),
    from: "Calendar Bot <noreply@tools.example>", to: ME.email,
    subject: "Your weekly digest",
    body: "You have 14 unread notifications across 3 projects. Visit the dashboard to review them.\n\n(This is an automated message.)",
  },
  {
    id: "demo-5", threadId: "t5", unread: false, date: dayOffset(-2, 9, 15),
    from: "Jordan Ellis <jordan@halcyon.example>", to: ME.email,
    subject: "Following up on the API access",
    body: `Hi ${first}, just checking whether you had a chance to look at our API access request from last week? We'd love to start testing before the end of the month.\n\nCheers,\nJordan`,
  },
  {
    id: "demo-6", threadId: "t6", unread: false, date: dayOffset(-3, 14, 0),
    from: "Sofia Lind <sofia@thinq.example>", to: ME.email,
    subject: "Team offsite — please vote on dates",
    body: "Hi all, please reply with which week works for the offsite: the 8th, 15th or 22nd. Majority wins!\n\nSofia",
  },
];

const events = [
  { id: "ev-1", title: "Team standup", start: dayOffset(0, 9, 30), end: dayOffset(0, 9, 45), attendees: ["team@thinq.example"], location: "Zoom" },
  { id: "ev-2", title: "1:1 with Priya", start: dayOffset(0, 11, 0), end: dayOffset(0, 11, 30), attendees: ["priya@northwind.example"], location: "" },
  { id: "ev-3", title: "Lunch", start: dayOffset(0, 12, 30), end: dayOffset(0, 13, 30), attendees: [], location: "" },
  { id: "ev-4", title: "Design review", start: dayOffset(0, 15, 0), end: dayOffset(0, 16, 0), attendees: ["elena@epicurious.example"], location: "Room 2" },
  { id: "ev-5", title: "Team standup", start: dayOffset(1, 9, 30), end: dayOffset(1, 9, 45), attendees: ["team@thinq.example"], location: "Zoom" },
  { id: "ev-6", title: "Sales pipeline review", start: dayOffset(1, 14, 0), end: dayOffset(1, 15, 0), attendees: ["marcus@magnolia.example"], location: "" },
  { id: "ev-7", title: "Investor update prep", start: dayOffset(2, 10, 0), end: dayOffset(2, 11, 30), attendees: [], location: "" },
];

const fmt = (e) => ({ ...e, date: e.date.toISOString() });
const fmtEv = (e) => ({ ...e, start: e.start.toISOString(), end: e.end.toISOString() });

return {
  mode: "demo",

  async profile() {
    return ME;
  },

  async searchEmails({ query = "", maxResults = 10 }) {
    let list = [...emails].sort((a, b) => b.date - a.date);
    const q = query.toLowerCase().trim();
    if (q.includes("is:unread")) list = list.filter((e) => e.unread);
    const words = q.replace("is:unread", "").replace(/in:inbox/g, "").trim().split(/\s+/).filter(Boolean);
    if (words.length) {
      list = list.filter((e) => {
        const hay = `${e.from} ${e.subject} ${e.body}`.toLowerCase();
        return words.every((w) => hay.includes(w.replace(/^from:/, "")));
      });
    }
    return list.slice(0, maxResults).map((e) => ({
      id: e.id, from: e.from, to: e.to, subject: e.subject, date: e.date.toISOString(),
      snippet: e.body.slice(0, 140).replace(/\s+/g, " "), unread: e.unread,
    }));
  },

  async getEmail(emailId) {
    const e = emails.find((x) => x.id === emailId);
    if (!e) throw new Error(`No email with id ${emailId}`);
    e.unread = false;
    return fmt({ ...e });
  },

  async listEvents({ timeMin, timeMax }) {
    const a = new Date(timeMin), b = new Date(timeMax);
    return events.filter((e) => e.end > a && e.start < b).sort((x, y) => x.start - y.start).map(fmtEv);
  },

  async sendEmail({ to, cc, subject, body, replyToId }) {
    const sent = { id: `demo-sent-${Date.now()}`, threadId: replyToId ? emails.find((e) => e.id === replyToId)?.threadId : undefined };
    return { ...sent, note: "Demo mode: the email was not actually sent.", to, cc, subject, bodyLength: body.length };
  },

  async createEvent({ title, start, end, attendees = [], description = "" }) {
    const ev = { id: `ev-${Date.now()}`, title, start: new Date(start), end: new Date(end), attendees, location: "", description };
    events.push(ev);
    return { id: ev.id, note: "Demo mode: added to the sample calendar only." };
  },
};
}
