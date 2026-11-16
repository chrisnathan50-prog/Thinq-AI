// The welcome tour: a short guided walk through Thinq for new people.
// It spotlights one part of the app at a time (Connections, Approvals, the message box) with a card that
// explains it, and lets people connect Gmail & Calendar, WhatsApp and notifications right from the tour.
// Shown once per person (the server remembers when they finish or skip); "Take the tour" in the account
// menu replays it. If a step leaves the page (connecting Google), the tour picks up where it left off.

const RESUME_KEY = "thinq_tour_resume";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ico = (id, size = 16) => `<svg width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"/></svg>`;
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

/**
 * ctx: { state(), openConn(pane), fillInput(text), turnOnPush(), pushSupport(), pushOn() }
 */
export function createTour(ctx) {
  let steps = [], i = 0, layer, ring, card, target = null, raf = 0;
  const narrow = () => matchMedia("(max-width:760px)").matches;
  const panelIsDrawer = () => matchMedia("(max-width:1100px)").matches;

  function buildSteps() {
    const s = ctx.state();
    const first = esc((s.user?.name || "").trim().split(/\s+/)[0] || "there");
    const google = s.mode === "google";
    const wa = s.whatsapp?.available, waSync = s.whatsappSync?.available;
    const meet = s.meetings?.available, notif = s.notifications && ctx.pushSupport() !== "none";
    const list = [];

    list.push({
      id: "welcome",
      title: `Welcome to Thinq, ${first} 👋`,
      body: `<p>Thinq is your personal assistant. Just tell it what you need in plain words, like you'd ask a person.</p>
        <ul class="tour-feats">
          <li>${ico("i-mail", 15)}<span><b>Email</b> Find, summarize and draft replies</span></li>
          <li>${ico("i-cal", 15)}<span><b>Calendar</b> Check your day, find free time, set up meetings</span></li>
          ${wa || waSync ? `<li>${ico("i-wa", 15)}<span><b>WhatsApp</b> Catch up on chats and draft replies</span></li>` : ""}
          ${meet ? `<li>${ico("i-video", 15)}<span><b>Meeting notes</b> Record a meeting, get the summary and to-dos</span></li>` : ""}
          ${notif ? `<li>${ico("i-bell", 15)}<span><b>Reminders</b> Get pinged on your phone at the right time</span></li>` : ""}
          <li>${ico("i-doc", 15)}<span><b>Documents${s.images?.available ? " & images" : ""}</b> Summarize files${s.images?.available ? ", create pictures" : ""}</span></li>
        </ul>
        <p class="tour-safe">${ico("i-check", 14)}Thinq never sends an email, message or invite without your OK.</p>`,
      next: "Show me around",
    });

    list.push({
      id: "google",
      target: '.link-row[data-pane="google"]',
      title: google ? "Gmail & Calendar: connected ✓" : "Step 1: Connect Gmail & Calendar",
      body: google
        ? `<p>Thinq can read and search your email and calendar${s.profile?.email ? ` (<b>${esc(s.profile.email)}</b>)` : ""}. You can manage this connection here any time.</p>`
        : `<p>Right now you're using a <b>sample inbox and calendar</b>, so nothing Thinq shows you is real yet.</p>
           <p>Connect your Google account so Thinq can work with <b>your</b> email and calendar. Google will ask for a few permissions: <b>tick every box</b>, or Thinq can't read your email or calendar.</p>
           <p class="tour-small">Thinq only reads your account to help you. It never sends or books anything until you tap Approve.</p>`,
      action: !google && s.googleConfigured ? { label: "Connect Gmail & Calendar", run: () => { store.set(RESUME_KEY, "whatsapp"); location.href = "/auth/google/connect"; } } : null,
      next: google ? "Next" : "Later",
    });

    if (wa || waSync) {
      const syncOn = s.whatsappSync?.status === "connected", botOn = s.whatsapp?.linked;
      list.push({
        id: "whatsapp",
        target: waSync ? '.link-row[data-pane="wasync"]' : '.link-row[data-pane="wa"]',
        title: "Step 2: Bring in WhatsApp",
        body: `<p>${waSync && wa ? "There are two ways to use WhatsApp with Thinq:" : "Here's how WhatsApp works with Thinq:"}</p>
          <ul class="tour-opts">
            ${waSync ? `<li><b>WhatsApp chats</b>${syncOn ? " ✓" : ""}<span>Link your WhatsApp the same way as WhatsApp Web, by scanning a code with your phone. Then ask things like <i>“what did the family group decide?”</i> or <i>“draft a reply to Sam”</i>.</span></li>` : ""}
            ${wa ? `<li><b>Thinq on WhatsApp</b>${botOn ? " ✓" : ""}<span>Chat with Thinq from WhatsApp, voice notes included, when you're away from the app.</span></li>` : ""}
          </ul>`,
        action: syncOn && (botOn || !wa) ? null : { label: "Set up WhatsApp", run: () => pauseFor(waSync && !syncOn ? "wasync" : "wa") },
        next: "Next",
      });
    }

    if (notif) {
      list.push({
        id: "notifications",
        target: '.link-row[data-pane="notifications"]',
        title: "Get reminders on your phone",
        body: ctx.pushOn()
          ? `<p>Notifications are on ✓. Ask <i>“remind me at 3pm to call Sam”</i> or <i>“tell me when Ada's email arrives”</i> and Thinq will ping you, even when the app is closed.</p>`
          : `<p>Turn on notifications so Thinq can remind you of things and tell you when an email you're waiting for arrives, even when the app is closed.</p>
             ${ctx.pushSupport() === "ok" && Notification.permission === "denied" ? `<p class="tour-small">Notifications are blocked for Thinq in this browser. Allow them in the site settings (the icon next to the address), then open Connections → Notifications.</p>` : ""}
             ${ctx.pushSupport() === "ios-install" ? `<p class="tour-small">On iPhone: tap Share → <b>Add to Home Screen</b>, open Thinq from there, then turn notifications on.</p>` : ""}`,
        action: ctx.pushOn() || ctx.pushSupport() !== "ok" || Notification.permission === "denied" ? null : { label: "Turn on notifications", run: async (btn) => {
          btn.disabled = true;
          try { await ctx.turnOnPush(); go(i + 1); }
          catch (err) { btn.disabled = false; showError(err.message); }
        } },
        next: ctx.pushOn() ? "Next" : "Later",
      });
    }

    if (meet) {
      list.push({
        id: "meetings",
        target: '.link-row[data-pane="meetings"]',
        title: "Meeting notes",
        body: `<p>Tap <b>Record meeting</b> here before a call or a chat in the room. Thinq turns it into notes: a summary, decisions, and who's doing what.</p>
          <p class="tour-small">Later, ask things like <i>“what did we agree in Monday's meeting?”</i></p>`,
        next: "Next",
      });
    }

    list.push({
      id: "approvals",
      target: () => (panelIsDrawer() ? "#openPanel" : "#panel"),
      title: "Approvals: you're always in control",
      body: `<p>When Thinq drafts an email, a WhatsApp reply or a calendar invite, it waits <b>here</b>. You can read it, edit it, and then <b>Send</b> or <b>Decline</b>.</p>
        <p class="tour-small">Nothing goes out until you approve it.</p>`,
      next: "Next",
    });

    const tries = google
      ? ["What's important in my inbox today?", "What's on my calendar this week?", "Find 30 minutes for a call with Sam on Thursday"]
      : ["What's in my inbox today?", "What's on my calendar this week?", "Draft a friendly follow-up to my last email"];
    list.push({
      id: "chat",
      target: "#composer",
      title: "Now just ask",
      body: `<p>Type here, or tap ${ico("i-mic", 13)} to speak and ${ico("i-clip", 13)} to attach a document. Try one of these:</p>
        <div class="tour-tries">${tries.map((t) => `<button type="button" class="chip" data-try="${esc(t)}">${esc(t)}</button>`).join("")}</div>
        <p class="tour-small">You can replay this tour from the ••• menu next to your name.</p>`,
      next: "Done",
    });
    return list;
  }

  // ---------- drawing ----------
  function mount() {
    layer = document.createElement("div");
    layer.className = "tour";
    layer.innerHTML = `<div class="tour-ring" aria-hidden="true"></div>
      <section class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tourTitle" tabindex="-1"></section>`;
    document.body.appendChild(layer);
    ring = layer.querySelector(".tour-ring"); card = layer.querySelector(".tour-card");
    card.addEventListener("click", onClick);
    layer.addEventListener("keydown", onKey);
    addEventListener("resize", place); addEventListener("scroll", place, true);
  }
  function unmount() {
    cancelAnimationFrame(raf);
    removeEventListener("resize", place); removeEventListener("scroll", place, true);
    layer?.remove(); layer = null;
    document.getElementById("sidebar")?.classList.remove("open");
    const scrim = document.getElementById("scrim"); if (scrim) scrim.hidden = true;
  }

  function resolveTarget(step) {
    const sel = typeof step.target === "function" ? step.target() : step.target;
    const el = sel ? document.querySelector(sel) : null;
    return el && el.getClientRects().length ? el : null;
  }

  function go(n) {
    if (n >= steps.length) return finish(steps[steps.length - 1]?.id);
    i = Math.max(0, n);
    const step = steps[i];
    // On phones the Connections list lives in the side drawer: slide it open for those steps.
    const inSidebar = typeof step.target === "string" && step.target.startsWith(".link-row");
    const side = document.getElementById("sidebar");
    const sliding = narrow() && inSidebar && !side?.classList.contains("open");
    if (narrow()) side?.classList.toggle("open", inSidebar);
    const dots = steps.map((_, k) => `<span class="${k === i ? "on" : ""}"></span>`).join("");
    card.innerHTML = `
      <div class="tour-top"><span class="tour-dots" aria-label="Step ${i + 1} of ${steps.length}">${dots}</span>
        <button type="button" class="tour-skip" data-tour="skip">Skip tour</button></div>
      <h2 id="tourTitle">${step.title}</h2>
      <div class="tour-body">${step.body}</div>
      <p class="tour-err" hidden></p>
      <div class="tour-actions">
        ${i > 0 ? `<button type="button" class="btn ghost sm" data-tour="back">Back</button>` : ""}
        <span class="tour-gap"></span>
        ${step.action ? `<button type="button" class="btn ghost sm" data-tour="next">${esc(step.next)}</button><button type="button" class="btn sm" data-tour="action">${esc(step.action.label)}</button>`
          : `<button type="button" class="btn sm" data-tour="next">${esc(step.next === "Later" ? "Next" : step.next)}</button>`}
      </div>`;
    layer.classList.toggle("centered", !step.target);
    target = null;
    // Wait for the drawer to slide in before measuring where things are.
    setTimeout(() => { target = step.target ? resolveTarget(step) : null; target?.scrollIntoView?.({ block: "nearest" }); place(); }, sliding ? 320 : 0);
    place();
    card.focus({ preventScroll: true });
  }

  function place() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (!layer) return;
      const vw = innerWidth, vh = innerHeight, gap = 14, pad = 12;
      if (!target) {
        ring.style.cssText = "opacity:0";
        card.style.cssText = "";
        return;
      }
      const r = target.getBoundingClientRect();
      const m = 6;
      ring.style.cssText = `opacity:1;left:${r.left - m}px;top:${r.top - m}px;width:${r.width + m * 2}px;height:${r.height + m * 2}px`;
      const cw = Math.min(360, vw - pad * 2), ch = card.offsetHeight;
      let left, top;
      if (vw <= 760) {
        // Phones: a sheet at the bottom, or at the top if the highlighted part is low on the screen.
        left = pad; top = r.top + r.height / 2 > vh / 2 ? pad : vh - ch - pad;
        card.style.cssText = `left:${left}px;top:${Math.max(pad, top)}px;width:${vw - pad * 2}px`;
        return;
      }
      if (r.right + gap + cw <= vw - pad) { left = r.right + gap; top = r.top + r.height / 2 - ch / 2; }        // right of it
      else if (r.left - gap - cw >= pad) { left = r.left - gap - cw; top = r.top + r.height / 2 - ch / 2; }     // left of it
      else if (r.top - gap - ch >= pad) { left = r.left + r.width / 2 - cw / 2; top = r.top - gap - ch; }       // above
      else { left = r.left + r.width / 2 - cw / 2; top = r.bottom + gap; }                                      // below
      left = Math.min(Math.max(pad, left), vw - cw - pad);
      top = Math.min(Math.max(pad, top), vh - ch - pad);
      card.style.cssText = `left:${left}px;top:${top}px;width:${cw}px`;
    });
  }

  function showError(msg) { const e = card.querySelector(".tour-err"); if (e) { e.textContent = msg; e.hidden = false; } }

  // Open a connection's setup on top of the tour; continue with the next step when it's closed.
  function pauseFor(pane) {
    layer.hidden = true;
    const dlg = document.getElementById("connDialog");
    ctx.openConn(pane);
    dlg.addEventListener("close", () => { if (!layer) return; layer.hidden = false; steps = buildSteps(); go(Math.min(i + 1, steps.length - 1)); }, { once: true });
  }

  async function onClick(e) {
    const t = e.target.closest("[data-try]");
    if (t) { finish("chat"); ctx.fillInput(t.dataset.try); return; }
    const b = e.target.closest("[data-tour]"); if (!b) return;
    const act = b.dataset.tour, step = steps[i];
    if (act === "skip") return finish(step.id, true);
    if (act === "back") return go(i - 1);
    if (act === "next") return go(i + 1);
    if (act === "action") return step.action.run(b);
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); finish(steps[i]?.id, true); }
    if (e.key === "ArrowRight" && !e.target.closest("input,textarea")) go(i + 1);
    if (e.key === "ArrowLeft" && !e.target.closest("input,textarea") && i > 0) go(i - 1);
  }

  function finish(stepId, skipped = false) {
    store.del(RESUME_KEY);
    unmount();
    fetch("/api/tour", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ done: true, step: skipped ? `skip:${stepId}` : stepId }) }).catch(() => {});
    const s = ctx.state(); if (s?.user) s.user.tourDone = true;
  }

  function start(fromId) {
    if (layer) unmount();
    steps = buildSteps();
    mount();
    const at = fromId ? steps.findIndex((s) => s.id === fromId) : 0;
    go(at < 0 ? 0 : at);
  }

  /** Start automatically for people who haven't seen it, or resume after connecting Google. */
  function maybeStart() {
    const resume = store.get(RESUME_KEY);
    if (resume) {
      // Coming back from Google: carry on from the step after it (if Google wasn't connected, show that step again).
      return start(ctx.state().mode === "google" ? resume : "google");
    }
    if (!ctx.state().user?.tourDone) start();
  }

  return { start, maybeStart };
}
