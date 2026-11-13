// Google: sign-in (who you are) and Gmail + Calendar access (what Thinq can read/send), via OAuth.
// The user approves access on Google's own page. Tokens are stored encrypted, per user (see store.js).
import { google } from "googleapis";
import * as store from "../store.js";

// Step 1 - signing in to Thinq needs only basic profile access.
export const SIGNIN_SCOPES = ["openid", "email", "profile"];
// Step 2 - connecting the inbox asks for Gmail and Calendar (added on top of step 1).
export const MAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly", // read and search mail
  "https://www.googleapis.com/auth/gmail.send", // send mail (only after you approve)
  "https://www.googleapis.com/auth/calendar.events", // read events and create invites (only after you approve)
];

export const googleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export function publicUrl() {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
}
export const redirectUri = () => process.env.GOOGLE_REDIRECT_URI || `${publicUrl()}/auth/google/callback`;

function oauthClient() {
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri());
}

export function signInUrl(state) {
  return oauthClient().generateAuthUrl({ scope: SIGNIN_SCOPES, state, prompt: "select_account" });
}

export function connectUrl(state, loginHint) {
  return oauthClient().generateAuthUrl({
    access_type: "offline", prompt: "consent", include_granted_scopes: true,
    scope: [...SIGNIN_SCOPES, ...MAIL_SCOPES], state, login_hint: loginHint,
  });
}

// Trade the one-time code from Google for tokens and the user's profile.
export async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const { data } = await google.oauth2({ version: "v2", auth: client }).userinfo.get();
  const granted = (tokens.scope || "").split(" ");
  return {
    tokens,
    profile: { sub: data.id, email: data.email, name: data.name || data.email, picture: data.picture || null, verified: data.verified_email !== false },
    hasMailAccess: MAIL_SCOPES.every((s) => granted.includes(s)),
  };
}

export async function revoke(userId) {
  const conn = await store.getGoogle(userId);
  if (!conn) return;
  try { await oauthClient().revokeToken(conn.tokens.refresh_token || conn.tokens.access_token); } catch { /* already revoked */ }
}

async function authed(userId) {
  const saved = await store.getGoogle(userId);
  if (!saved) throw new Error("Google is not connected");
  const client = oauthClient();
  client.setCredentials(saved.tokens);
  // Google refreshes the access token automatically; keep the newest copy.
  client.on("tokens", (t) => { store.updateGoogleTokens(userId, t).catch(() => {}); });
  return client;
}

const header = (headers, name) => headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

function decode(data) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function extractBody(payload) {
  // Prefer plain text; fall back to HTML with tags stripped.
  const parts = [];
  const walk = (p) => { if (!p) return; parts.push(p); (p.parts || []).forEach(walk); };
  walk(payload);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return decode(plain.body.data);
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  if (html) return decode(html.body.data).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ");
  return "";
}

const MAX_BODY = 12000;

function encodeHeader(value) {
  // RFC 2047 so non-ASCII subjects survive.
  return /[^\x20-\x7e]/.test(value) ? `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=` : value;
}

function toBase64Url(str) {
  return Buffer.from(str, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createGoogleProvider(userId, user) {
  return {
  mode: "google",

  async profile() {
    const g = await store.getGoogle(userId);
    return { name: user?.name, email: g?.email || user?.email };
  },

  async searchEmails({ query = "in:inbox", maxResults = 10 }) {
    const gmail = google.gmail({ version: "v1", auth: await authed(userId) });
    const { data } = await gmail.users.messages.list({ userId: "me", q: query || "in:inbox", maxResults });
    const ids = (data.messages || []).map((m) => m.id);
    const metas = await Promise.all(ids.map((mid) =>
      gmail.users.messages.get({ userId: "me", id: mid, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] })));
    return metas.map(({ data: m }) => ({
      id: m.id,
      from: header(m.payload.headers, "From"),
      to: header(m.payload.headers, "To"),
      subject: header(m.payload.headers, "Subject"),
      date: new Date(Number(m.internalDate)).toISOString(),
      snippet: m.snippet,
      unread: (m.labelIds || []).includes("UNREAD"),
    }));
  },

  async getEmail(emailId) {
    const gmail = google.gmail({ version: "v1", auth: await authed(userId) });
    const { data: m } = await gmail.users.messages.get({ userId: "me", id: emailId, format: "full" });
    let body = extractBody(m.payload);
    const truncated = body.length > MAX_BODY;
    if (truncated) body = body.slice(0, MAX_BODY);
    return {
      id: m.id,
      threadId: m.threadId,
      from: header(m.payload.headers, "From"),
      to: header(m.payload.headers, "To"),
      cc: header(m.payload.headers, "Cc"),
      subject: header(m.payload.headers, "Subject"),
      date: new Date(Number(m.internalDate)).toISOString(),
      body,
      truncated,
    };
  },

  async listEvents({ timeMin, timeMax }) {
    const calendar = google.calendar({ version: "v3", auth: await authed(userId) });
    const { data } = await calendar.events.list({
      calendarId: "primary", timeMin, timeMax, singleEvents: true, orderBy: "startTime", maxResults: 100,
    });
    return (data.items || []).filter((e) => e.status !== "cancelled").map((e) => ({
      id: e.id,
      title: e.summary || "(no title)",
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
      allDay: Boolean(e.start.date),
      attendees: (e.attendees || []).map((a) => a.email),
      location: e.location || "",
    }));
  },

  async sendEmail({ to, cc, subject, body, replyToId }) {
    const gmail = google.gmail({ version: "v1", auth: await authed(userId) });
    const headers = [`To: ${to.join(", ")}`];
    if (cc?.length) headers.push(`Cc: ${cc.join(", ")}`);
    let threadId;
    if (replyToId) {
      const { data: orig } = await gmail.users.messages.get({ userId: "me", id: replyToId, format: "metadata", metadataHeaders: ["Message-ID", "References"] });
      threadId = orig.threadId;
      const msgId = header(orig.payload.headers, "Message-ID");
      if (msgId) {
        headers.push(`In-Reply-To: ${msgId}`);
        headers.push(`References: ${[header(orig.payload.headers, "References"), msgId].filter(Boolean).join(" ")}`);
      }
    }
    headers.push(`Subject: ${encodeHeader(subject)}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: 8bit");
    const raw = toBase64Url(`${headers.join("\r\n")}\r\n\r\n${body}`);
    const { data } = await gmail.users.messages.send({ userId: "me", requestBody: { raw, threadId } });
    return { id: data.id, threadId: data.threadId };
  },

  async createEvent({ title, start, end, attendees = [], description = "", timeZone }) {
    const calendar = google.calendar({ version: "v3", auth: await authed(userId) });
    const { data } = await calendar.events.insert({
      calendarId: "primary",
      sendUpdates: attendees.length ? "all" : "none",
      requestBody: {
        summary: title,
        description,
        start: { dateTime: start, timeZone },
        end: { dateTime: end, timeZone },
        attendees: attendees.map((email) => ({ email })),
      },
    });
    return { id: data.id, link: data.htmlLink };
  },
};
}
