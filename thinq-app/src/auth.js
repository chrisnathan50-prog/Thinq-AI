// Accounts and sign-in.
//  1. "Continue with Google" on the website's login page -> /auth/google/login (basic profile only)
//     -> Google -> /auth/google/callback -> account created/updated, session cookie set -> /app
//  2. In the app, "Connect Gmail & Calendar" -> /auth/google/connect (adds Gmail + Calendar access)
//     -> Google -> /auth/google/callback -> tokens saved (encrypted) for that user -> /app
// Sessions: the cookie holds a random token; the database stores only its hash.
import crypto from "node:crypto";
import * as store from "./store.js";
import { googleConfigured, signInUrl, connectUrl, exchangeCode, revoke } from "./providers/google.js";

const SESSION_COOKIE = "thinq_session";
const STATE_COOKIE = "thinq_oauth";
const production = () => process.env.NODE_ENV === "production";

// ---------- cookies ----------
export function readCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim()).filter(Boolean).map((c) => {
    const i = c.indexOf("=");
    return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
  }));
}
function setCookie(res, name, value, { maxAgeMs, clear } = {}) {
  const parts = [`${name}=${clear ? "" : encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (production()) parts.push("Secure");
  if (clear) parts.push("Max-Age=0");
  else if (maxAgeMs) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  res.append("Set-Cookie", parts.join("; "));
}

// ---------- invite list ----------
// Who can sign in:
//   - ALLOWED_EMAILS: comma-separated emails and/or "@company.com" domains, or "*" for anyone;
//   - ADMIN_EMAILS: the people who run Thinq (they also see tester requests);
//   - testers an admin approved in the app (kept in the database, cached here).
// With none of these set: anyone can sign in locally, nobody in production (a fresh deploy is never open to the world).
const listFrom = (name) => (process.env[name] || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const approvedTesters = new Set();
export const setApprovedTesters = (emails) => { approvedTesters.clear(); emails.forEach((e) => approvedTesters.add(String(e).toLowerCase())); };
export const allowTester = (email) => approvedTesters.add(String(email).toLowerCase());
export const disallowTester = (email) => approvedTesters.delete(String(email).toLowerCase());
export const isAdmin = (email) => listFrom("ADMIN_EMAILS").includes(String(email || "").toLowerCase());

export function isAllowed(email) {
  const list = listFrom("ALLOWED_EMAILS");
  const e = String(email || "").toLowerCase();
  if (!list.length && !listFrom("ADMIN_EMAILS").length && !approvedTesters.size) return !production();
  return list.includes("*") || list.includes(e) || list.some((x) => x.startsWith("@") && e.endsWith(x)) || isAdmin(e) || approvedTesters.has(e);
}

// ---------- middleware ----------
export async function attachUser(req, res, next) {
  try {
    req.sessionToken = readCookies(req)[SESSION_COOKIE];
    req.user = await store.userForSession(req.sessionToken);
    // If someone was removed from the invite list, sign them out.
    if (req.user && !isAllowed(req.user.email)) { await store.deleteSession(req.sessionToken); req.user = null; setCookie(res, SESSION_COOKIE, "", { clear: true }); }
  } catch (err) {
    console.error(err);
    req.user = null;
  }
  next();
}
export function requireAdmin(req, res, next) {
  if (req.user && isAdmin(req.user.email)) return next();
  return res.status(403).json({ error: "Only Thinq's admins can see this." });
}
export function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.path.startsWith("/api/") || req.originalUrl.startsWith("/api/")) return res.status(401).json({ error: "Please sign in again.", signIn: "/login.html" });
  return res.redirect("/login.html");
}

// ---------- routes ----------
export function mountAuth(app) {
  const startOAuth = (res, purpose, url) => {
    const state = crypto.randomBytes(16).toString("hex");
    setCookie(res, STATE_COOKIE, JSON.stringify({ state, purpose }), { maxAgeMs: 10 * 60 * 1000 });
    res.redirect(url(state));
  };

  app.get("/auth/google/login", (req, res) => {
    if (!googleConfigured()) return res.redirect("/login.html?error=not_configured");
    if (req.user) return res.redirect("/app");
    startOAuth(res, "login", (state) => signInUrl(state));
  });

  app.get("/auth/google/connect", requireUser, (req, res) => {
    if (!googleConfigured()) return res.redirect("/app?google=not-configured");
    startOAuth(res, "connect", (state) => connectUrl(state, req.user.email));
  });

  app.get("/auth/google/callback", async (req, res) => {
    let saved = null;
    try { saved = JSON.parse(readCookies(req)[STATE_COOKIE] || "null"); } catch {}
    setCookie(res, STATE_COOKIE, "", { clear: true });
    const purpose = saved?.purpose === "connect" ? "connect" : "login";
    const fail = (code) => res.redirect(purpose === "connect" ? `/app?google=${code}` : `/login.html?error=${code}`);

    if (req.query.error) return fail(req.query.error === "access_denied" ? "access_denied" : "failed");
    if (!saved || !req.query.state || req.query.state !== saved.state) return fail("expired");

    try {
      const { tokens, profile, hasMailAccess } = await exchangeCode(String(req.query.code));
      if (purpose === "login") {
        if (!profile.verified) return fail("unverified");
        if (!isAllowed(profile.email)) return fail("not_invited");
        const user = await store.upsertGoogleUser(profile);
        const { token, maxAgeMs } = await store.createSession(user.id);
        setCookie(res, SESSION_COOKIE, token, { maxAgeMs });
        await store.logAction(user.id, "signed_in", {});
        // If they'd already granted Gmail access earlier, keep using it; otherwise the app offers to connect.
        return res.redirect("/app");
      }
      // connect
      if (!req.user) return res.redirect("/login.html?error=expired");
      if (!hasMailAccess) return fail("missing_permissions");
      if (!tokens.refresh_token) {
        // Google only sends a long-lived token on first consent; keep the one we already have if any.
        const existing = await store.getGoogle(req.user.id);
        if (existing?.tokens?.refresh_token) tokens.refresh_token = existing.tokens.refresh_token;
      }
      await store.setGoogle(req.user.id, { email: profile.email, tokens });
      await store.logAction(req.user.id, "google_connected", { email: profile.email });
      return res.redirect("/app?google=connected");
    } catch (err) {
      console.error("Google sign-in failed:", err.message);
      return fail("failed");
    }
  });

  app.post("/auth/google/disconnect", requireUser, async (req, res) => {
    await revoke(req.user.id);
    await store.deleteGoogle(req.user.id);
    await store.logAction(req.user.id, "google_disconnected", {});
    res.json({ ok: true });
  });

  app.post("/auth/logout", async (req, res) => {
    if (req.sessionToken) await store.deleteSession(req.sessionToken);
    setCookie(res, SESSION_COOKIE, "", { clear: true });
    res.json({ ok: true, redirect: "/" });
  });

  // Used by the website to swap "Log in" for "Open Thinq" when you're signed in.
  app.get("/api/session", (req, res) => {
    res.json(req.user ? { signedIn: true, user: { name: req.user.name, email: req.user.email, picture: req.user.picture } } : { signedIn: false, googleConfigured: googleConfigured() });
  });
}
