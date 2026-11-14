// "Help us test Thinq": the website's tester form, and the admin page where requests are approved.
// Approving someone lets them sign in (no need to edit ALLOWED_EMAILS) and, if the admin has Gmail connected,
// puts a ready-to-send "You're in" email in the admin's Approvals panel - nothing is sent automatically.
import express from "express";
import * as store from "./store.js";
import { requireUser, requireAdmin, isAdmin, allowTester, disallowTester, setApprovedTesters } from "./auth.js";
import { providerFor } from "./providers/index.js";
import { publicUrl } from "./providers/google.js";

const EMAIL = /^[^\s@<>()",;:]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const contactEmail = () => (process.env.CONTACT_EMAIL || "").trim() || null;
const adminEmails = () => (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// Simple per-visitor limit so the public form can't be used to flood the list.
const recent = new Map(); // ip -> [timestamps]
function tooMany(ip) {
  const now = Date.now(), hour = 3600e3;
  const list = (recent.get(ip) || []).filter((t) => now - t < hour);
  list.push(now); recent.set(ip, list);
  if (recent.size > 5000) for (const [k, v] of recent) if (now - v.at(-1) > hour) recent.delete(k);
  return list.length > 5;
}

export async function loadApprovedTesters() {
  setApprovedTesters(await store.approvedTesterEmails());
}

// Heads-up to each admin, sent from their own connected Gmail to themselves.
async function notifyAdmins(t) {
  for (const email of adminEmails()) {
    try {
      const admin = await store.findUserByEmail(email);
      if (!admin) continue;
      const p = await providerFor(admin);
      if (p.mode !== "google") continue;
      await p.sendEmail({
        to: [admin.email], cc: [], replyToId: null,
        subject: `New Thinq tester request: ${t.name || t.email}`,
        body: `${t.name || "Someone"} (${t.email}) asked to test Thinq.\n\n${t.useCase ? `What they'd use it for:\n${t.useCase}\n\n` : ""}Approve or decline: ${publicUrl()}/app/admin\n\n- Thinq`,
      });
    } catch (err) {
      console.warn(`[testers] couldn't notify an admin: ${err.message}`);
    }
  }
}

export function mountTesters(app) {
  // ---- public (the website) ----
  app.get("/public/config", (req, res) => res.json({ contactEmail: contactEmail() }));

  app.post("/public/testers", async (req, res) => {
    const b = req.body || {};
    if (b.website) return res.json({ ok: true }); // hidden field only bots fill in
    const email = String(b.email || "").trim().toLowerCase();
    const name = String(b.name || "").trim().slice(0, 100) || null;
    const useCase = String(b.useCase || "").trim().slice(0, 1000) || null;
    if (!EMAIL.test(email) || email.length > 254) return res.status(400).json({ error: "Please enter a valid email address." });
    if (tooMany(req.ip)) return res.status(429).json({ error: "Too many requests from this device. Try again in an hour." });
    try {
      const { tester, existed } = await store.addTesterRequest({ email, name, useCase });
      if (existed) {
        return res.json({ ok: true, status: tester.status, message: tester.status === "approved"
          ? "You already have access. Log in with Google using this email."
          : "You're already on the list. We'll email you when your spot opens." });
      }
      notifyAdmins(tester); // don't make the visitor wait for this
      res.json({ ok: true, status: "pending", message: "Thanks! You're on the list. We'll email you when your spot opens." });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  });

  // ---- admin (signed-in admins only) ----
  const admin = express.Router();
  admin.use(requireUser, requireAdmin);

  admin.get("/testers", async (req, res) => res.json({ testers: await store.listTesters(), googleConsole: "https://console.cloud.google.com/auth/audience" }));

  admin.post("/testers/:id/approve", async (req, res) => {
    const t = await store.setTesterStatus(req.params.id, "approved", req.user.email);
    if (!t) return res.status(404).json({ error: "Not found" });
    allowTester(t.email);
    await store.logAction(req.user.id, "tester_approved", { email: t.email });
    // Queue (not send) a welcome email in the admin's Approvals panel.
    let drafted = false;
    try {
      const p = await providerFor(req.user);
      if (p.mode === "google") {
        await store.addApproval(req.user.id, "email", {
          to: [t.email], cc: [], replyToId: null,
          subject: "You're in - welcome to the Thinq test",
          body: `Hi${t.name ? ` ${t.name.split(" ")[0]}` : ""},\n\nThanks for offering to help test Thinq - your spot is ready.\n\n1. Go to ${publicUrl()}/login.html\n2. Click "Log in with Google" and use this email address (${t.email}).\n3. Try it on the sample inbox first, then connect your Gmail and Calendar when you're ready.\n\nThinq never sends or books anything without your approval. If anything feels off or confusing, just reply to this email - that feedback is exactly what we need.\n\nThanks!\n${(req.user.name || "").split(" ")[0] || "The Thinq team"}`,
        }, `Welcome email to ${t.email}`, null);
        drafted = true;
      }
    } catch (err) {
      console.warn(`[testers] couldn't draft the welcome email: ${err.message}`);
    }
    res.json({ tester: t, drafted });
  });

  admin.post("/testers/:id/decline", async (req, res) => {
    const t = await store.setTesterStatus(req.params.id, "declined", req.user.email);
    if (!t) return res.status(404).json({ error: "Not found" });
    disallowTester(t.email);
    await store.logAction(req.user.id, "tester_declined", { email: t.email });
    res.json({ tester: t });
  });

  admin.delete("/testers/:id", async (req, res) => {
    const t = (await store.listTesters()).find((x) => x.id === req.params.id);
    if (t) disallowTester(t.email);
    await store.deleteTester(req.params.id);
    res.json({ ok: true });
  });

  app.use("/api/admin", admin);
}

export { isAdmin };
