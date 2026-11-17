import { createTour } from "/app/tour.js";
// Thinq app - browser side. Talks to the local server in server.js.
const $ = (s, r = document) => r.querySelector(s);
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let state = null;
let conversationId = null;
let sending = false;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (name, size = 14) => `<svg width="${size}" height="${size}"><use href="#${name}"/></svg>`;

// Light Markdown: paragraphs, headings, bullet/numbered lists, tables, **bold**, *italic*, `code`.
// Everything is escaped first, so model output can never inject HTML.
const inline = (s) => s
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
  .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
function md(text) {
  const lines = esc(text).split("\n").filter((l, i, a) => !(l.trim() === "" && /^\s*\|/.test(a[i - 1] || "") && /^\s*\|/.test(a[i + 1] || "")));
  let html = "", list = null, table = null;
  const close = () => {
    if (list) { html += `</${list}>`; list = null; }
    if (table) { html += `<div class="table"><table><thead><tr>${table.head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${table.rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`; table = null; }
  };
  for (const raw of lines) {
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) continue; // the |---|---| separator row
      if (!table) { close(); table = { head: cells(raw), rows: [] }; } else table.rows.push(cells(raw));
      continue;
    }
    if (table) close();
    const line = inline(raw);
    const heading = raw.match(/^\s*#{1,6}\s+(.*)/);
    if (heading) { close(); html += `<p><strong>${inline(heading[1])}</strong></p>`; continue; }
    const bullet = line.match(/^\s*[-•*]\s+(.*)/), num = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (bullet || num) {
      const tag = bullet ? "ul" : "ol";
      if (list !== tag) { close(); html += `<${tag}>`; list = tag; }
      html += `<li>${(bullet || num)[1]}</li>`;
    } else if (!line.trim()) { close(); }
    else { close(); html += `<p>${line}</p>`; }
  }
  close();
  return html;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 401) { location.href = "/login.html"; throw new Error("Please sign in again."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------- state ----------------
async function refresh() {
  state = await api("/api/state");
  $("#botsTabBtn").hidden = !state.telegram;
  api("/api/routines").then((r) => { routinesData = r.routines; const w = routinesData.filter((x) => x.status === "needs_ok").length; $("#rtBadge").hidden = !w; $("#rtBadge").textContent = w; if (!$("#tab-routines").hidden) renderRoutines(); }).catch(() => {});
  renderAccount(); renderConn(); renderWhatsApp(); renderWaSync(); renderMeetings(); renderNotify(); renderNotes(); renderConvos(); renderApprovals(); renderGreeting();
}

function renderGreeting() {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const first = (state.user?.name || state.profile?.name)?.split(" ")[0];
  $("#greeting").textContent = first ? `${part}, ${first}.` : `${part}.`;
}

function renderAccount() {
  const u = state.user || {};
  const initial = esc((u.name || u.email || "?").trim()[0].toUpperCase());
  $("#account").innerHTML = `
    ${u.picture ? `<img class="avatar" src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar">${initial}</span>`}
    <span class="who"><b>${esc(u.name || "You")}</b><small>${esc(u.email || "")}</small></span>
    <button class="icon-btn" id="acctBtn" aria-label="Account options" aria-haspopup="menu" aria-expanded="false">${icon("i-more", 16)}</button>
    <div class="acct-menu" id="acctMenu" role="menu" hidden>
      ${state.admin ? `<a role="menuitem" href="/app/admin">${icon("i-check", 14)}Admin dashboard${state.admin.pendingTesters ? `<span class="badge">${state.admin.pendingTesters}</span>` : ""}</a>` : ""}
      <button role="menuitem" id="takeTour">${icon("i-spark", 14)}Take the tour</button>
      <button role="menuitem" class="danger" id="deleteAll">${icon("i-trash", 14)}Delete all chats</button>
      <button role="menuitem" id="logout">${icon("i-logout", 14)}Log out</button>
    </div>`;
  const menu = $("#acctMenu"), btn = $("#acctBtn");
  const setMenu = (open) => { menu.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
  btn.addEventListener("click", (e) => { e.stopPropagation(); setMenu(menu.hidden); });
  $("#takeTour").addEventListener("click", () => { setMenu(false); tour.start(); });
  $("#logout").addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
  });
  $("#deleteAll").addEventListener("click", async () => {
    setMenu(false);
    const n = state.conversations.length;
    if (!n) return notice("You don't have any chats yet.", "ok");
    if (!confirm(`Delete all ${n} chat${n > 1 ? "s" : ""}? Their messages, attached documents and images will be removed for good. Drafts waiting in Approvals stay.`)) return;
    try {
      const r = await api("/api/conversations", { method: "DELETE" });
      await openConversation(null); await refresh();
      notice(`Deleted ${r.deleted} chat${r.deleted === 1 ? "" : "s"}.`, "ok");
    } catch (err) { notice(err.message); }
  });
}

// ---------------- connections: a compact list in the sidebar; details open in a dialog ----------------
// Each row: [icon] Name / one-word status, and a coloured dot. The cards with buttons, codes and
// explanations (renderConn, renderWaSync, renderWhatsApp) draw into panes inside #connDialog.
function connRows() {
  const rows = [];
  rows.push(state.mode === "google"
    ? { pane: "google", icon: "i-mail", name: "Gmail & Calendar", status: "Connected", dot: "live" }
    : { pane: "google", icon: "i-mail", name: "Gmail & Calendar", status: "Demo inbox", dot: "demo" });
  const s = state.whatsappSync || {};
  if (s.available) {
    const st = { connected: ["Synced", "live"], reconnecting: ["Reconnecting…", "demo"], starting: ["Linking…", "demo"], waiting: ["Waiting for scan", "demo"],
      logged_out: ["Unlinked", "off"], blocked: ["Blocked", "off"], expired: ["Not linked", null] }[s.status] || ["Not linked", null];
    rows.push({ pane: "wasync", icon: "i-wa", name: "WhatsApp chats", status: st[0], dot: st[1] });
  }
  const mt = state.meetings || {};
  if (mt.available) {
    const live = (mt.meetings || []).find((m) => ["joining", "waiting_room", "recording"].includes(m.status));
    const next = (mt.meetings || []).find((m) => m.status === "scheduled");
    rows.push({ pane: "meetings", icon: "i-video", name: "Meeting notes",
      status: mrec ? `Recording ${fmtDur(Date.now() - mrec.started)}` : live ? (live.status === "recording" ? "Taking notes now" : "Joining a call…") : mt.autoJoin ? "Auto-join on" : next ? "Next one scheduled" : mt.record ? "Record a meeting" : "Paste a link to start",
      dot: mrec ? "off" : live ? "live" : mt.autoJoin || next ? "live" : null });
  }
  const nt = state.notifications;
  if (nt && pushSupport() !== "none") {
    const n = nt.devices?.length || 0;
    rows.push({ pane: "notifications", icon: "i-bell", name: "Notifications",
      status: pushHere ? (nt.items?.length ? `On · ${nt.items.length} reminder${nt.items.length > 1 ? "s" : ""}` : "On") : n ? `On for ${n} other device${n > 1 ? "s" : ""}` : "Off",
      dot: pushHere ? "live" : n ? "demo" : null });
  }
  const wa = state.whatsapp || {};
  if (wa.available) rows.push({ pane: "wa", icon: "i-wa", name: "Thinq on WhatsApp", status: wa.linked ? "Connected" : waPending ? "Waiting for code" : "Not connected", dot: wa.linked ? "live" : waPending ? "demo" : null });
  return rows;
}

function renderLinks() {
  if (!state) return;
  const left = state.usage?.limit ? Math.max(0, state.usage.limit - state.usage.today) : null;
  const foot = !state.hasApiKey
    ? `<p class="links-foot warn"><span class="dot off"></span>AI not set up: the server needs <code>${esc(state.apiKeyName)}</code></p>`
    : `<p class="links-foot">${left !== null ? `${left} of ${state.usage.limit} requests left today` : ""}</p>`;
  $("#links").innerHTML = `<h3 class="links-head">Connections</h3>
    <ul>${connRows().map((r) => `<li><button type="button" class="link-row" data-pane="${r.pane}" aria-haspopup="dialog">
      <span class="link-ic">${icon(r.icon, 14)}</span>
      <span class="link-txt"><b>${esc(r.name)}</b><small>${esc(r.status)}</small></span>
      ${r.dot ? `<span class="dot ${r.dot}" aria-hidden="true"></span>` : `<span class="link-add" aria-hidden="true">${icon("i-plus", 12)}</span>`}
    </button></li>`).join("")}</ul>${foot}`;
}

const connTitles = { google: "Gmail & Calendar", wasync: "WhatsApp chats", wa: "Thinq on WhatsApp", meetings: "Meeting notes", notifications: "Notifications" };
function openConn(pane) {
  const dlg = $("#connDialog");
  $("#connDialogTitle").textContent = connTitles[pane] || "Connection";
  dlg.querySelectorAll("[data-pane]").forEach((el) => { el.hidden = el.dataset.pane !== pane; });
  if (!dlg.open) dlg.showModal();
}
$("#links").addEventListener("click", (e) => { const b = e.target.closest(".link-row"); if (b) openConn(b.dataset.pane); });
$("#connDialogClose").addEventListener("click", () => $("#connDialog").close());
$("#connDialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }); // click outside

function renderConn() {
  const c = $("#conn");
  let html = "";
  if (state.mode === "google") {
    html += `<div class="row"><span class="dot live"></span><b>Connected</b></div><p>${esc(state.profile?.email)}. Thinq can read and search your email and calendar, and drafts emails and invites for you to approve.</p><button class="btn ghost sm" id="disconnect">Disconnect</button>`;
  } else {
    html += `<div class="row"><span class="dot demo"></span><b>Demo mode</b></div><p>You're using a sample inbox and calendar. Nothing is really sent.</p>`;
    html += state.googleConfigured
      ? `<a class="btn sm" href="/auth/google/connect">Connect Gmail & Calendar</a>`
      : `<p>Connecting real accounts isn't set up on this server yet.</p>`;
  }
  c.innerHTML = html;
  renderLinks();
  $("#disconnect")?.addEventListener("click", async () => {
    if (!confirm("Disconnect your Google account? Thinq will lose access to your Gmail and Calendar and switch back to the demo inbox.")) return;
    await api("/auth/google/disconnect", { method: "POST" });
    $("#connDialog").close();
    await refresh(); loadAgenda();
  });
}

// ---------------- WhatsApp ----------------
let waPending = null; // { code, url, until } while waiting for the person to send the code
let waPoll = null;
function renderWhatsApp() {
  const box = $("#wa"), wa = state.whatsapp || {};
  renderLinks();
  if (!wa.available) return;
  if (wa.linked) {
    waPending = null; clearInterval(waPoll);
    box.innerHTML = `<div class="row"><span class="dot live"></span><b>WhatsApp connected</b></div>
      <p>${esc(wa.linked.number)}${wa.linked.name ? ` · ${esc(wa.linked.name)}` : ""}. Message Thinq there, send voice notes and files, or forward messages.</p>
      <div class="wa-actions">${wa.chatUrl ? `<a class="btn sm" href="${esc(wa.chatUrl)}" target="_blank" rel="noopener">${icon("i-wa", 14)}Open chat</a>` : ""}<button class="btn ghost sm" id="waUnlink">Unlink</button></div>`;
    $("#waUnlink").addEventListener("click", async () => {
      if (!confirm("Unlink WhatsApp? Thinq will stop answering messages from your number until you connect it again.")) return;
      await api("/api/whatsapp", { method: "DELETE" }); refresh();
    });
    return;
  }
  if (waPending && Date.now() < waPending.until) {
    const mins = Math.max(1, Math.ceil((waPending.until - Date.now()) / 60000));
    box.innerHTML = `<div class="row"><span class="dot demo"></span><b>Link your WhatsApp</b></div>
      <p>Send this code to Thinq on WhatsApp${wa.number ? ` (+${esc(wa.number)})` : ""}:</p>
      <div class="wa-code" aria-label="Link code">${esc(waPending.code.replace(/(\d{3})(\d{3})/, "$1 $2"))}</div>
      <div class="wa-actions">${waPending.url ? `<a class="btn sm" href="${esc(waPending.url)}" target="_blank" rel="noopener">${icon("i-wa", 14)}Open WhatsApp</a>` : ""}<button class="btn ghost sm" id="waCancel">Cancel</button></div>
      <p class="meta">Works for ${mins} more minute${mins > 1 ? "s" : ""}. This box updates once it's linked.</p>`;
    $("#waCancel").addEventListener("click", () => { waPending = null; clearInterval(waPoll); renderWhatsApp(); });
    return;
  }
  box.innerHTML = `<div class="row"><span class="dot none"></span><b>Not connected</b></div>
    <p>Chat with Thinq from WhatsApp: voice notes, files, forwarded messages and chat exports.</p>
    <button class="btn sm" id="waConnect">Connect WhatsApp</button>`;
  $("#waConnect").addEventListener("click", async () => {
    try {
      const r = await api("/api/whatsapp/code", { method: "POST", body: JSON.stringify({ timeZone }) });
      waPending = { code: r.code, url: r.url, until: Date.now() + r.expiresInMinutes * 60000 };
      renderWhatsApp();
      if (r.url) window.open(r.url, "_blank", "noopener");
      clearInterval(waPoll);
      waPoll = setInterval(async () => {
        if (!waPending || Date.now() > waPending.until) { clearInterval(waPoll); waPending = null; return renderWhatsApp(); }
        const s = await api("/api/state").catch(() => null);
        if (s?.whatsapp?.linked) { clearInterval(waPoll); waPending = null; state = s; renderWhatsApp(); renderConvos(); notice("WhatsApp is connected. Say hi to Thinq there!", "ok"); }
        else renderWhatsApp();
      }, 4000);
    } catch (err) { notice(err.message); }
  });
}

// ---------------- WhatsApp chat sync (Thinq reads your chats as a linked device) ----------------
let waSyncStep = null; // null | "warn" | "phone"
let waSyncPoll = null;
function waSyncWatch() {
  clearInterval(waSyncPoll);
  waSyncPoll = setInterval(async () => {
    const s = await api("/api/whatsapp-sync").catch(() => null);
    if (!s) return;
    const wasConnected = state.whatsappSync?.status === "connected";
    state.whatsappSync = s;
    if (!["starting", "waiting", "reconnecting"].includes(s.status) && !(s.status === "connected" && s.messages === 0)) clearInterval(waSyncPoll);
    if (s.status === "connected" && !wasConnected) notice("WhatsApp linked. Your recent chats are syncing - this can take a few minutes.", "ok");
    renderWaSync();
  }, 3000);
}
function renderWaSync() {
  const box = $("#wasync"), s = state.whatsappSync || {};
  renderLinks();
  if (!s.available) return;
  const head = (dot, title) => `<div class="row">${dot ? `<span class="dot ${dot}"></span>` : icon("i-wa", 15)}<b>${title}</b></div>`;

  if (s.status === "connected" || s.status === "reconnecting") {
    const last = s.lastMessageAt ? new Date(s.lastMessageAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
    box.innerHTML = `${head(s.status === "connected" ? "live" : "demo", s.status === "connected" ? "Synced" : "Reconnecting…")}
      <p>${s.phone ? `${esc(s.phone)} · ` : ""}${s.messages ? `${s.chats} chats, ${s.messages.toLocaleString()} messages${last ? `, latest ${esc(last)}` : ""}` : "Syncing your recent chats…"}. Ask things like “what did I miss on WhatsApp today?”</p>
      <p class="meta">Thinq only sends messages you approve. Messages older than ${s.keepDays} days are deleted.</p>
      <div class="wa-actions"><button class="btn ghost sm" id="waSyncOff">Disconnect & delete</button></div>`;
    $("#waSyncOff").addEventListener("click", async () => {
      if (!confirm("Disconnect WhatsApp chats? Thinq is logged out of your WhatsApp and every synced message is deleted from Thinq.")) return;
      try { await api("/api/whatsapp-sync", { method: "DELETE" }); await refresh(); notice("WhatsApp chats disconnected and deleted.", "ok"); } catch (err) { notice(err.message); }
    });
    if (s.messages === 0 || s.status === "reconnecting") waSyncWatch();
    return;
  }

  if (s.status === "starting" || s.status === "waiting") {
    box.innerHTML = `${head("demo", "Waiting for your phone")}
      ${s.pairingCode
        ? `<p>On your phone: WhatsApp → <b>Settings → Linked devices → Link a device → Link with phone number instead</b>, then enter:</p><div class="wa-code" aria-label="Pairing code">${esc(s.pairingCode.replace(/^(.{4})(.{4})$/, "$1-$2"))}</div>`
        : s.qr
          ? `<p>On your phone: WhatsApp → <b>Settings → Linked devices → Link a device</b>, then scan:</p><img class="wa-qr" src="${esc(s.qr)}" alt="WhatsApp link QR code" width="200" height="200">`
          : `<p>Getting a code from WhatsApp…</p>`}
      <div class="wa-actions"><button class="btn ghost sm" id="waSyncCancel">Cancel</button></div>
      <p class="meta">${s.pairingCode ? "" : "The code refreshes by itself. "}This box updates once it's linked.</p>`;
    $("#waSyncCancel").addEventListener("click", async () => {
      clearInterval(waSyncPoll);
      state.whatsappSync = await api("/api/whatsapp-sync/cancel", { method: "POST" }).catch(() => s);
      waSyncStep = null; renderWaSync();
    });
    waSyncWatch();
    return;
  }

  if (waSyncStep === "warn" || waSyncStep === "phone") {
    box.innerHTML = `${head("off", "Before you link")}
      <p>WhatsApp has no official way for apps to read your chats, so Thinq links as a device on your account, like WhatsApp Web. This isn't allowed by WhatsApp's terms: <b>WhatsApp could restrict or ban your number</b>, and it may stop working after a WhatsApp update.</p>
      <p>Thinq will store the text of your messages from the last ${s.keepDays} days so it can search them. It only sends a message when you tap Send on a draft. You can disconnect and delete everything at any time.</p>
      ${waSyncStep === "phone" ? `<label class="meta" for="waSyncPhone">Your WhatsApp number, with country code</label><input class="input" id="waSyncPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+44 7700 900123">` : ""}
      <div class="wa-actions">
        ${waSyncStep === "phone"
          ? `<button class="btn sm" id="waSyncGo" data-mode="phone">Get pairing code</button><button class="btn ghost sm" id="waSyncQr">Use a QR code</button>`
          : `<button class="btn sm" id="waSyncGo" data-mode="qr">I understand, show QR code</button><button class="btn ghost sm" id="waSyncPhoneBtn">I'm on my phone</button>`}
        <button class="btn ghost sm" id="waSyncBack">Not now</button>
      </div>`;
    $("#waSyncBack").addEventListener("click", () => { waSyncStep = null; renderWaSync(); });
    $("#waSyncPhoneBtn")?.addEventListener("click", () => { waSyncStep = "phone"; renderWaSync(); $("#waSyncPhone")?.focus(); });
    $("#waSyncQr")?.addEventListener("click", () => { waSyncStep = "warn"; renderWaSync(); });
    $("#waSyncGo").addEventListener("click", async (e) => {
      const phone = e.currentTarget.dataset.mode === "phone" ? $("#waSyncPhone").value.trim() : undefined;
      if (phone === "") return notice("Enter your WhatsApp number first.");
      e.currentTarget.disabled = true;
      try {
        state.whatsappSync = await api("/api/whatsapp-sync", { method: "POST", body: JSON.stringify({ accept: true, phone }) });
        waSyncStep = null; renderWaSync();
      } catch (err) { notice(err.message); e.currentTarget.disabled = false; }
    });
    return;
  }

  const why = { logged_out: "WhatsApp chats were unlinked from your phone.", blocked: "WhatsApp blocked the link. Your number may be restricted.", expired: "The code expired before it was scanned." }[s.status];
  box.innerHTML = `${head(why ? "off" : "none", why ? "Not linked" : "Not linked yet")}
    <p>${why ? `${esc(why)} ` : ""}Let Thinq read your own WhatsApp chats, so you can ask “what did I miss?” or “what did Sam say about Friday?”</p>
    <div class="wa-actions"><button class="btn sm" id="waSyncStart">${why ? "Link again" : "Link WhatsApp chats"}</button>${s.messages ? `<button class="btn ghost sm" id="waSyncDel">Delete synced messages</button>` : ""}</div>`;
  $("#waSyncStart").addEventListener("click", () => { waSyncStep = "warn"; renderWaSync(); });
  $("#waSyncDel")?.addEventListener("click", async () => {
    if (!confirm("Delete all synced WhatsApp messages from Thinq?")) return;
    await api("/api/whatsapp-sync", { method: "DELETE" }).catch((err) => notice(err.message)); refresh();
  });
}

// ---------------- meeting recorder (records mic + optionally a meeting tab, in 5-minute pieces) ----------------
// Each piece is a complete audio file, uploaded as soon as it's done and transcribed on the server, so long
// meetings work and nothing already sent is lost if the tab closes. Audio is mixed from the microphone and,
// on desktop Chrome/Edge, the shared tab's sound (so the other people in a Meet/Zoom/Teams tab are heard too).
const SEG_MS = 5 * 60 * 1000;
let mrec = null; // { id, title, started, ctx, dest, sources, recorder, n, queue, uploading, stopping, timer, wake }
const fmtDur = (ms) => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600); return `${h ? `${h}:` : ""}${String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0")}:${String(s % 60).padStart(2, "0")}`; };
const recMime = () => ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";

async function startMeetingRecording({ title, withTab }) {
  if (mrec) return notice("A recording is already running.");
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return notice("This browser can't record audio. Try Chrome, Edge or Safari.");
  let tab = null, mic = null;
  if (withTab) {
    try {
      tab = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, selfBrowserSurface: "exclude", systemAudio: "include", preferCurrentTab: false });
    } catch { return notice("Recording didn't start: no tab was shared. Untick “Also record a meeting tab” to record just your microphone."); }
    if (!tab.getAudioTracks().length) {
      tab.getTracks().forEach((t) => t.stop());
      return notice("That share had no sound. Choose the meeting's browser tab and keep “Share tab audio” switched on.");
    }
  }
  try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { if (!tab) return notice("Thinq couldn't use your microphone. Allow microphone access for this site and try again."); }

  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const sources = [mic, tab].filter(Boolean);
  for (const s of sources) if (s.getAudioTracks().length) ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks())).connect(dest);

  let r;
  try { r = await api("/api/recordings", { method: "POST", body: JSON.stringify({ title, withTab: Boolean(tab) }) }); }
  catch (err) { sources.forEach((s) => s.getTracks().forEach((t) => t.stop())); ctx.close(); return notice(err.message); }

  mrec = { id: r.id, title: r.title, started: Date.now(), ctx, dest, sources, n: 0, queue: [], uploading: false, stopping: false, tab: Boolean(tab), mic: Boolean(mic) };
  // If they stop sharing the tab from Chrome's own bar, keep recording the microphone.
  tab?.getVideoTracks()[0]?.addEventListener("ended", () => { if (mrec && !mrec.stopping) { mrec.tab = false; notice(mic ? "Tab sharing stopped - still recording your microphone." : "Tab sharing stopped."); if (!mic) stopMeetingRecording(); } });
  try { mrec.wake = await navigator.wakeLock?.request("screen"); } catch { /* not supported */ }
  nextPiece();
  mrec.timer = setInterval(renderRecBar, 1000);
  renderRecBar();
  $("#connDialog").close();
  state.meetings = await api("/api/meetings").catch(() => state.meetings);
  renderMeetings();
}

function nextPiece() {
  const type = recMime();
  const recorder = new MediaRecorder(mrec.dest.stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 32000 });
  const chunks = [], n = mrec.n++, offset = Date.now() - mrec.started;
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" });
    if (mrec && !mrec.cancelled && blob.size > 2000) { mrec.queue.push({ n, offset, blob }); uploadPieces(); }
  };
  recorder.start(10_000);
  mrec.recorder = recorder;
  mrec.rotate = setTimeout(() => { if (mrec && !mrec.stopping && recorder.state !== "inactive") { recorder.stop(); nextPiece(); } }, SEG_MS);
}

async function uploadPieces() {
  const cur = mrec;
  if (!cur || cur.uploading) return;
  cur.uploading = true;
  while (cur.queue.length && !cur.cancelled) {
    const p = cur.queue[0];
    let ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      try {
        const res = await fetch(`/api/recordings/${cur.id}/segments?n=${p.n}&offset=${p.offset}`, { method: "POST", headers: { "Content-Type": p.blob.type }, body: p.blob });
        if (res.ok) ok = true;
        else if (res.status >= 400 && res.status < 500) { notice((await res.json().catch(() => ({}))).error || "Part of the recording couldn't be saved."); break; }
      } catch { /* offline - retry */ }
      if (!ok) await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
    if (!ok) notice("Part of the recording couldn't be uploaded. The notes may have a gap.");
    cur.queue.shift();
  }
  cur.uploading = false;
  cur.drained?.();
}

async function stopMeetingRecording({ cancel = false } = {}) {
  const cur = mrec;
  if (!cur || cur.stopping) return;
  cur.stopping = true; cur.cancelled = cancel;
  clearTimeout(cur.rotate); clearInterval(cur.timer);
  renderRecBar();
  await new Promise((resolve) => {
    if (cur.recorder?.state === "inactive") return resolve();
    cur.recorder.addEventListener("stop", () => setTimeout(resolve, 50), { once: true });
    cur.recorder.stop();
  });
  cur.sources.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  cur.ctx.close().catch(() => {});
  cur.wake?.release?.().catch(() => {});
  try {
    if (cancel) {
      await api(`/api/recordings/${cur.id}`, { method: "DELETE" });
    } else {
      if (cur.uploading || cur.queue.length) await new Promise((r) => { cur.drained = r; if (!cur.uploading) uploadPieces(); });
      await api(`/api/recordings/${cur.id}/finish`, { method: "POST" });
    }
  } catch (err) { notice(err.message); }
  mrec = null;
  renderRecBar();
  state.meetings = await api("/api/meetings").catch(() => state.meetings);
  renderMeetings();
  if (!cancel) notice(`Recording saved. Thinq is writing the notes for “${cur.title}” - they'll appear in Meeting notes in a minute or two.`, "ok");
}

// The bar is drawn once per state (recording / saving); each second only the timer text changes, so the
// buttons are never replaced under someone's cursor.
function renderRecBar() {
  const bar = $("#mrecBar");
  if (!mrec) { bar.hidden = true; bar.innerHTML = ""; bar.dataset.mode = ""; renderLinks(); return; }
  const mode = mrec.stopping ? (mrec.cancelled ? "discarding" : "saving") : `rec-${mrec.tab}-${mrec.mic}`;
  if (bar.dataset.mode !== mode) {
    bar.dataset.mode = mode; bar.hidden = false;
    bar.innerHTML = mrec.stopping
      ? `<span class="spin"></span><span class="mrec-txt"><b>${mrec.cancelled ? "Discarding…" : "Saving the recording…"}</b></span>`
      : `<span class="dot"></span><span class="mrec-txt"><b>Recording “${esc(mrec.title)}”</b><small><span id="mrecTime">0:00</span> · ${mrec.tab && mrec.mic ? "meeting tab + microphone" : mrec.tab ? "meeting tab" : "microphone"} · keep this tab open</small></span>
         <button class="btn sm" id="mrecStop">Stop & get notes</button><button class="btn ghost sm" id="mrecDiscard">Discard</button>`;
    $("#mrecStop")?.addEventListener("click", () => stopMeetingRecording());
    $("#mrecDiscard")?.addEventListener("click", () => { if (confirm("Discard this recording? Nothing will be saved.")) stopMeetingRecording({ cancel: true }); });
    renderLinks();
  }
  const elapsed = fmtDur(Date.now() - mrec.started);
  const t = $("#mrecTime"); if (t) t.textContent = elapsed;
  const t2 = document.querySelector(".meet-rectime"); if (t2) t2.textContent = elapsed;
  const row = document.querySelector('.link-row[data-pane="meetings"] small'); if (row && !mrec.stopping) row.textContent = `Recording ${elapsed}`;
}
window.addEventListener("beforeunload", (e) => { if (mrec && !mrec.stopping) { e.preventDefault(); e.returnValue = ""; } });

// ---------------- meeting notes (recordings, and the optional notetaker bot) ----------------
const MEET_STATUS = {
  creating: ["Starting…", "demo"], scheduled: ["Scheduled", "demo"], joining: ["Joining…", "demo"], waiting_room: ["Waiting to be let in", "demo"],
  recording: ["Taking notes", "live"], processing: ["Finishing up…", "demo"], transcribing: ["Transcribing…", "demo"], summarizing: ["Writing notes…", "demo"],
  done: ["Notes ready", "live"], no_notes: ["No notes", "off"], failed: ["Didn't join", "off"], cancelled: ["Cancelled", "none"],
};
const ACTIVE_MEET = ["creating", "scheduled", "joining", "waiting_room", "recording", "processing", "transcribing", "summarizing"];
let meetPoll = null, meetOpen = null; // meetOpen: id of the meeting whose notes are shown
function meetWatch() {
  clearInterval(meetPoll);
  if (!(state.meetings?.meetings || []).some((m) => ACTIVE_MEET.includes(m.status) && m.status !== "scheduled")) return;
  meetPoll = setInterval(async () => {
    const s = await api("/api/meetings").catch(() => null);
    if (!s) return;
    const before = Object.fromEntries((state.meetings?.meetings || []).map((m) => [m.id, m.status]));
    state.meetings = s; renderMeetings();
    const ready = s.meetings.find((m) => m.status === "done" && before[m.id] && before[m.id] !== "done");
    if (ready) notice(`Notes from “${ready.title}” are ready. Open Meeting notes to read them, or ask Thinq about it.`, "ok");
  }, 8000);
}
function renderMeetings() {
  const box = $("#meet"), s = state.meetings || {};
  renderLinks();
  if (!s.available) return;
  const list = s.meetings || [];
  const when = (m) => new Date(m.startedAt || m.joinAt || m.createdAt).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const item = (m) => {
    const [label, dot] = m.source === "recording" && m.status === "recording" ? ["Recording", "off"] : MEET_STATUS[m.status] || [m.status, "none"];
    const isRec = m.source === "recording";
    const canStop = !isRec && ["scheduled", "joining", "waiting_room", "recording"].includes(m.status);
    const canFinish = isRec && m.status === "recording" && mrec?.id !== m.id; // left open in another tab or device
    return `<li class="meet-item" data-id="${m.id}">
      <div class="meet-row">
        <span class="meet-txt"><b>${esc(m.title)}</b><small>${esc(when(m))} · ${esc(m.platform)}</small></span>
        <span class="meet-status"><span class="dot ${dot}"></span>${esc(label)}</span>
      </div>
      ${m.error ? `<p class="meet-err">${esc(m.error)}</p>` : ""}
      <div class="meet-actions">
        ${m.hasNotes || m.hasTranscript ? `<button class="btn ghost sm" data-meet="open">${meetOpen === m.id ? "Hide notes" : "View notes"}</button>` : ""}
        ${m.hasTranscript && !m.hasNotes && m.status === "done" ? `<button class="btn ghost sm" data-meet="summarize">Write notes again</button>` : ""}
        ${canStop ? `<button class="btn ghost sm" data-meet="stop">${m.status === "scheduled" ? "Cancel" : "Remove from call"}</button>` : ""}
        ${canFinish ? `<button class="btn ghost sm" data-meet="finish">Finish and get notes</button>` : ""}
        ${!canStop && !ACTIVE_MEET.includes(m.status) ? `<button class="btn ghost sm icon-only" data-meet="delete" aria-label="Delete this meeting's notes">${icon("i-trash", 13)}</button>` : ""}
      </div>
      ${meetOpen === m.id ? `<div class="meet-notes" id="meetNotes">Loading…</div>` : ""}
    </li>`;
  };
  const canTab = Boolean(navigator.mediaDevices?.getDisplayMedia) && !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  const recordBlock = !s.record ? "" : mrec
    ? `<div class="meet-recnow"><span class="dot off"></span><b>Recording “${esc(mrec.title)}”</b><span class="meet-rectime">${fmtDur(Date.now() - mrec.started)}</span></div>
       <p class="meta">Use the bar at the top of the chat to stop. Keep this tab open while you record.</p>`
    : `<form class="meet-rec" id="recForm">
        <input class="input" id="recTitle" type="text" maxlength="200" placeholder="Meeting name (optional)" aria-label="Meeting name">
        ${canTab ? `<label class="meet-check"><input type="checkbox" id="recTab" checked><span>Also record a meeting tab's sound <small>(Google Meet, Zoom or Teams in your browser). Chrome asks which tab: pick the meeting and keep “Share tab audio” on.</small></span></label>` : ""}
        <button class="btn sm" type="submit">${icon("i-mic", 13)}Record meeting</button>
      </form>`;
  const botBlock = !s.bot ? "" : `
    <h3 class="meet-sub">Send a notetaker into a call</h3>
    <form class="meet-form" id="meetForm">
      <input class="input" id="meetUrl" type="url" inputmode="url" placeholder="Paste a Google Meet, Zoom or Teams link" aria-label="Meeting link" required>
      <button class="btn sm" type="submit">Send notetaker</button>
    </form>
    ${state.mode === "google" ? `<label class="meet-toggle"><input type="checkbox" id="meetAuto" ${s.autoJoin ? "checked" : ""}><span><b>Join my calendar meetings automatically</b><small>Any meeting with a Meet, Zoom or Teams link. You can remove it from any call.</small></span></label>` : ""}`;
  box.innerHTML = `
    <p>${s.record ? "Record a meeting from this browser and Thinq writes the notes: summary, decisions and action items. You can also ask Thinq about it afterwards." : `Thinq joins your call as <b>“${esc((state.user?.name || "Your").split(" ")[0])}'s Thinq Notetaker”</b> and gives you notes afterwards.`}</p>
    ${recordBlock}
    ${botBlock}
    ${list.length ? `<h3 class="meet-sub">Your meetings</h3><ul class="meet-list">${list.map(item).join("")}</ul>` : `<p class="meta">No meetings yet.</p>`}
    <p class="meta">Only you can see your notes. Let people in the meeting know you're recording.</p>`;
  $("#recForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    startMeetingRecording({ title: $("#recTitle").value.trim(), withTab: Boolean($("#recTab")?.checked) });
  });

  $("#meetForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.currentTarget.querySelector("button"); btn.disabled = true; btn.textContent = "Sending…";
    try {
      await api("/api/meetings", { method: "POST", body: JSON.stringify({ meetingUrl: $("#meetUrl").value.trim() }) });
      state.meetings = await api("/api/meetings"); renderMeetings(); meetWatch();
      notice("The notetaker is on its way. If the meeting has a waiting room, let it in.", "ok");
    } catch (err) { notice(err.message); btn.disabled = false; btn.textContent = "Send notetaker"; }
  });
  $("#meetAuto")?.addEventListener("change", async (e) => {
    try { state.meetings = await api("/api/meetings/settings", { method: "PUT", body: JSON.stringify({ autoJoin: e.target.checked }) }); renderMeetings(); }
    catch (err) { notice(err.message); e.target.checked = !e.target.checked; }
  });
  if (meetOpen) loadMeetNotes(meetOpen);
  meetWatch();
}
async function loadMeetNotes(id) {
  try {
    const m = await api(`/api/meetings/${id}`);
    const el = $("#meetNotes"); if (!el) return;
    el.innerHTML = (m.summary ? md(m.summary) : `<p class="meta">${m.status === "summarizing" ? "Writing the notes…" : "No notes yet."}</p>`)
      + (m.transcript ? `<details class="meet-transcript"><summary>Full transcript</summary><pre>${esc(m.transcript)}</pre></details>` : "");
  } catch (err) { notice(err.message); }
}
$("#meet").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-meet]"); if (!b) return;
  const id = b.closest(".meet-item").dataset.id, act = b.dataset.meet;
  try {
    if (act === "open") { meetOpen = meetOpen === id ? null : id; return renderMeetings(); }
    if (act === "stop" && !confirm(b.textContent === "Cancel" ? "Cancel the notetaker for this meeting?" : "Remove the notetaker from the call? Notes for what was said so far will still be written.")) return;
    if (act === "delete" && !confirm("Delete this meeting's notes and transcript from Thinq?")) return;
    b.disabled = true;
    if (act === "stop") await api(`/api/meetings/${id}/stop`, { method: "POST" });
    if (act === "finish") await api(`/api/recordings/${id}/finish`, { method: "POST" });
    if (act === "summarize") await api(`/api/meetings/${id}/summarize`, { method: "POST" });
    if (act === "delete") { await api(`/api/meetings/${id}`, { method: "DELETE" }); if (meetOpen === id) meetOpen = null; }
    state.meetings = await api("/api/meetings"); renderMeetings();
  } catch (err) { notice(err.message); b.disabled = false; }
});

// ---------------- welcome tour (see tour.js) ----------------
const tour = createTour({
  state: () => state,
  openConn: (pane) => openConn(pane),
  fillInput: (text) => { const t = $("#input"); t.value = text; autosize(); t.focus(); },
  turnOnPush: async (onWaiting) => { await turnOnPush(onWaiting); renderNotify(); },
  pushSupport: () => pushSupport(),
  pushOn: () => pushHere,
});

// ---------------- notifications (Web Push: reminders, email alerts, calendar heads-ups) ----------------
let swReg = null, pushHere = false;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
// "ok" | "ios-install" (iPhone: only works from the Home Screen) | "none"
function pushSupport() {
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "ok";
  if (isIOS && !standalone()) return "ios-install";
  return "none";
}
// The app lives at /app (no trailing slash), so the service worker's scope must be "/app" - with "/app/" it
// never controls the page and waiting for it hangs. The server allows this scope (Service-Worker-Allowed).
const SW_SCOPE = "/app";
const registerSW = () => navigator.serviceWorker.register("/app/sw.js", { scope: SW_SCOPE, updateViaCache: "none" });
// Wait until the worker is running (needed before subscribing), without hanging forever.
function swActive(reg, ms = 15000) {
  if (reg.active) return Promise.resolve(reg);
  return new Promise((resolve, reject) => {
    const w = reg.installing || reg.waiting;
    const timer = setTimeout(() => reject(new Error("Thinq's notification helper didn't start. Reload the page and try again.")), ms);
    w?.addEventListener("statechange", () => { if (reg.active) { clearTimeout(timer); resolve(reg); } });
    if (!w) navigator.serviceWorker.ready.then(() => { clearTimeout(timer); resolve(reg); });
  });
}
async function initPush() {
  if (!("serviceWorker" in navigator)) return;
  try {
    // Remove the earlier registration that used the wrong scope ("/app/").
    for (const r of await navigator.serviceWorker.getRegistrations()) if (new URL(r.scope).pathname === "/app/") await r.unregister().catch(() => {});
    swReg = await registerSW();
    const sub = await swReg.pushManager?.getSubscription();
    pushHere = Boolean(sub) && Notification.permission === "granted";
    // Re-send the subscription in case the server lost it (or the browser rotated it).
    if (pushHere) state.notifications = await api("/api/notifications/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON() }) });
  } catch (err) { console.warn("Notifications unavailable:", err.message); }
  renderNotify();
}
const b64ToBytes = (s) => { const b = atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
// Where the browser's "Allow notifications" question is when it doesn't pop up on its own.
const PERMISSION_HINT = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
  ? "Your browser is asking whether Thinq may send notifications. Tap Allow."
  : "Your browser is asking whether Thinq may send notifications. If you don't see a popup, click the bell icon (or the icon at the left end of the address bar) and choose Allow.";
// onWaiting() is called if the browser's question is still open after a moment - Chrome often shows only a
// small bell in the address bar instead of a popup, which looks like nothing happened.
async function turnOnPush(onWaiting) {
  // Ask straight away, while it still counts as the person's click (some browsers require that).
  const asking = Notification.requestPermission();
  const timer = onWaiting ? setTimeout(() => { if (Notification.permission === "default") onWaiting(PERMISSION_HINT); }, 1200) : null;
  let perm;
  try { perm = await asking; } finally { clearTimeout(timer); }
  if (perm !== "granted") throw new Error(perm === "denied"
    ? "Notifications are blocked for Thinq. Click the icon at the left end of the address bar, allow Notifications, then try again."
    : "Notifications weren't turned on. Tap the button again and choose Allow when your browser asks.");
  if (!swReg) swReg = await registerSW();
  await swActive(swReg);
  const sub = (await swReg.pushManager.getSubscription()) || await Promise.race([
    swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(state.notifications.publicKey) }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Your browser's notification service didn't answer. Check your internet connection and try again.")), 20000)),
  ]).catch((err) => { throw err?.name === "AbortError" || err?.name === "NotAllowedError" ? new Error("Your browser couldn't set up notifications for Thinq. If you use Brave, turn on “Use Google services for push messaging” in its settings; otherwise reload and try again.") : err; });
  state.notifications = await api("/api/notifications/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON() }) });
  pushHere = true;
}
// Did the service worker get a push since `since`? (It notes each one - see sw.js.)
async function pushArrived(since, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await (await caches.open("thinq-push-log")).match("/app/__push-log");
      const log = r && await r.json();
      if (log && Date.parse(log.at) >= since - 2000) return log;
    } catch { return null; }
    await new Promise((res) => setTimeout(res, 700));
  }
  return null;
}
async function turnOffPush() {
  const sub = await swReg?.pushManager.getSubscription();
  if (sub) {
    state.notifications = await api("/api/notifications/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) });
    await sub.unsubscribe().catch(() => {});
  }
  pushHere = false;
}
function renderNotify() {
  const box = $("#notif"), s = state.notifications;
  renderLinks();
  if (!box || !s) return;
  const support = pushSupport();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const when = (iso) => new Date(iso).toLocaleString([], { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const others = (s.devices || []).length - (pushHere ? 1 : 0);
  const blocked = support === "ok" && Notification.permission === "denied";
  const here = support === "ios-install"
    ? `<p class="notif-tip"><b>On iPhone, add Thinq to your Home Screen first.</b> Tap the Share button, choose “Add to Home Screen”, then open Thinq from your Home Screen and turn notifications on there.</p>`
    : support === "none" ? `<p class="notif-tip">This browser can't show notifications. Try Chrome, Edge, Firefox or Safari.</p>`
    : blocked ? `<p class="notif-tip"><b>Notifications are blocked for Thinq in this browser.</b> Allow them in the site settings (the icon next to the address), then reload.</p>`
    : pushHere
      ? `<div class="notif-on"><span class="dot live"></span><b>On for this device</b><button class="btn ghost sm" data-notif="test">Send a test</button><button class="btn ghost sm" data-notif="off">Turn off</button></div>`
      : `<button class="btn sm" data-notif="on">${icon("i-bell", 13)}Turn on notifications</button>`;
  const items = s.items || [];
  const item = (r) => `<li class="notif-item" data-id="${r.id}">
      <span class="notif-txt"><b>${esc(r.kind === "reminder" ? r.text : `Email ${r.from ? `from ${r.from}` : ""}${r.subject ? ` about “${r.subject}”` : ""}`)}</b>
      <small>${r.kind === "reminder" ? esc(when(r.dueAt)) : `Watching until ${esc(when(r.expiresAt))} · ${esc(r.text)}`}</small></span>
      <button class="btn ghost sm" data-notif="cancel">Cancel</button></li>`;
  const p = s.prefs || {};
  box.innerHTML = `
    <p>Thinq can remind you of things and tell you when an email you're waiting for arrives, even when Thinq is closed. Just ask, for example <i>“remind me at 3pm to call Sam”</i> or <i>“tell me when Sam's email arrives and what time the meeting is”</i>.</p>
    ${here}
    ${(s.devices || []).length ? `<p class="meta">Turned on for: ${esc([...new Set(s.devices)].join(", "))}${others > 0 && !pushHere ? " (not this one)" : ""}</p>` : ""}
    <h3 class="meet-sub">Also notify me about</h3>
    <label class="meet-toggle"><input type="checkbox" data-pref="calendar" ${p.calendar ? "checked" : ""}><span><b>Upcoming calendar events</b><small>${state.mode === "google" ? `A heads-up <select class="notif-mins" data-pref="calendarMinutes" aria-label="Minutes before">${[5, 10, 15, 30].map((m) => `<option value="${m}" ${p.calendarMinutes === m ? "selected" : ""}>${m} min</option>`).join("")}</select> before each one.` : "Needs Gmail & Calendar connected."}</small></span></label>
    <label class="meet-toggle"><input type="checkbox" data-pref="meetings" ${p.meetings ? "checked" : ""}><span><b>Meeting notes ready</b><small>When Thinq finishes the notes for a recording.</small></span></label>
    ${s.whatsappLinked ? `<label class="meet-toggle"><input type="checkbox" data-pref="whatsapp" ${p.whatsapp ? "checked" : ""}><span><b>Also send to WhatsApp</b><small>A copy of each reminder and alert in your Thinq WhatsApp chat (only works if you've messaged Thinq there in the last 24 hours).</small></span></label>` : ""}
    <h3 class="meet-sub">Reminders and email alerts</h3>
    ${items.length ? `<ul class="meet-list notif-list">${items.map(item).join("")}</ul>` : `<p class="meta">None set. Ask Thinq in the chat to set one.</p>`}`;
}
$("#notif").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-notif]"); if (!b) return;
  b.disabled = true;
  try {
    const act = b.dataset.notif;
    if (act === "on") {
      await turnOnPush((hint) => {
        b.innerHTML = `${icon("i-bell", 13)}Waiting for you to allow…`;
        let p = $("#notifHint");
        if (!p) { p = document.createElement("p"); p.id = "notifHint"; p.className = "notif-tip"; b.after(p); }
        p.textContent = hint;
      });
      notice("Notifications are on for this device.", "ok");
    }
    if (act === "off") { await turnOffPush(); notice("Notifications are off for this device.", "ok"); }
    if (act === "test") {
      const since = Date.now();
      await api("/api/notifications/test", { method: "POST" });
      b.textContent = "Sending…";
      const got = await pushArrived(since, 12000);
      notice(got?.ok ? "Test delivered. If no pop-up appeared, your computer is hiding notifications: check Do Not Disturb / Focus, and that notifications are allowed for your browser in your system settings."
        : got ? `Your browser got the test but couldn't show it (${got.error}).`
        : "The test was sent, but this browser hasn't received it yet. Some networks and VPNs block browser notifications; try another network, or wait a minute.", got?.ok ? "ok" : "err");
    }
    if (act === "cancel") state.notifications = await api(`/api/reminders/${b.closest(".notif-item").dataset.id}`, { method: "DELETE" });
    renderNotify();
  } catch (err) { renderNotify(); notice(err.message); }
});
$("#notif").addEventListener("change", async (e) => {
  const el = e.target.closest("[data-pref]"); if (!el) return;
  const val = el.type === "checkbox" ? el.checked : Number(el.value);
  try { state.notifications = await api("/api/notifications/settings", { method: "PUT", body: JSON.stringify({ [el.dataset.pref]: val }) }); renderNotify(); }
  catch (err) { notice(err.message); }
});

function renderNotes() {
  const notes = state.notes;
  $("#noteCount").textContent = notes.length ? notes.length : "";
  $("#notes").innerHTML = notes.length
    ? notes.map((n) => `<li><span>${esc(n.text)}</span><button data-note="${n.id}" aria-label="Forget this">${icon("i-x", 12)}</button></li>`).join("")
    : `<li class="none">Tell Thinq things like “sign my emails as Alex” and it will remember.</li>`;
}

function renderConvos() {
  const list = state.conversations;
  $("#convos").innerHTML = list.length
    ? `<div class="label">Recent</div>` + list.map((c) => `<div class="convo"${c.id === conversationId ? ' data-current' : ""}><a href="#${c.id}" data-id="${c.id}" ${c.id === conversationId ? 'aria-current="true"' : ""} title="${esc(c.title)}">${esc(c.title)}</a><button class="del" data-del="${c.id}" aria-label="Delete “${esc(c.title)}”" title="Delete chat">${icon("i-trash", 14)}</button></div>`).join("")
    : `<p class="none">Your chats will appear here.</p>`;
}

// ---------------- starter suggestions (personal: from your inbox, calendar and memory) ----------------
const FALLBACK = ["Plan my day", "What needs a reply from me?", "Draft replies to my unread emails", "What's on my calendar tomorrow?"];
let suggestionsReq = 0;
async function loadSuggestions() {
  const box = $("#suggestions"), mine = ++suggestionsReq;
  if (!box.querySelector("button")) { box.classList.add("loading"); box.setAttribute("aria-busy", "true"); }
  let list = [];
  try { list = (await api(`/api/suggestions?tz=${encodeURIComponent(timeZone)}`)).suggestions.map((s) => s.text); } catch {}
  if (mine !== suggestionsReq) return;
  if (!list.length) list = FALLBACK;
  box.classList.remove("loading"); box.removeAttribute("aria-busy");
  box.innerHTML = list.map((t) => `<button>${esc(t)}</button>`).join("");
}

// ---------------- conversations ----------------
async function openConversation(id) {
  conversationId = id;
  $("#messages").querySelectorAll(".msg").forEach((m) => m.remove());
  if (!id) {
    $("#empty").hidden = false; $("#title").textContent = "New conversation";
    loadSuggestions();
    history.replaceState(null, "", location.pathname); renderConvos(); return;
  }
  try {
    const c = await api(`/api/conversations/${id}`);
    $("#title").textContent = c.title;
    $("#empty").hidden = c.messages.length > 0;
    c.messages.forEach((m) => addMessage(m.role, m.text, "", m.attachments || []));
    history.replaceState(null, "", `#${id}`);
  } catch { conversationId = null; $("#empty").hidden = false; }
  renderConvos();
  closeDrawers();
}

const fileMeta = (d) => d.pages ? `${d.pages} page${d.pages === 1 ? "" : "s"}` : `${Math.max(1, Math.round((d.chars || 0) / 1000))}k characters`;
const fileChip = (d) => `<span class="att">${icon("i-doc", 13)}<span class="nm" title="${esc(d.name)}">${esc(d.name)}</span><span class="meta">${fileMeta(d)}</span></span>`;
const gallery = (imgs) => imgs?.length ? `<div class="gallery${imgs.length > 1 ? " multi" : ""}">${imgs.map((i) => `<figure class="gen"><a href="/api/images/${esc(i.id)}" target="_blank" rel="noopener" aria-label="Open image full size"><img src="/api/images/${esc(i.id)}" alt="${esc(i.prompt)}" loading="lazy"></a><figcaption><span title="${esc(i.prompt)}">${esc(i.prompt)}</span><a class="dl" href="/api/images/${esc(i.id)}?download=1" download>${icon("i-download", 12)}Download</a></figcaption></figure>`).join("")}</div>` : "";
const toolsRow = () => `<div class="tools"><button type="button" data-speak>${icon("i-speaker", 13)}<span>Read aloud</span></button></div>`;

function addMessage(role, text, extra = "", files = []) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  wrap.innerHTML = role === "user"
    ? `<div class="stack">${files.length ? `<div class="files">${files.map(fileChip).join("")}</div>` : ""}<div class="body">${esc(text)}</div></div>`
    : `<div class="av" aria-hidden="true">${icon("mark", 15)}</div><div class="body">${md(text)}${gallery(files.filter((f) => f.type === "image"))}${extra}${text && canRead() ? toolsRow() : ""}</div>`;
  $("#messages").appendChild(wrap);
  scrollDown();
  return wrap;
}

const scrollDown = () => { const m = $("#messages"); m.scrollTop = m.scrollHeight; };

async function send(text) {
  if (sending) return;
  if (pending.some((a) => a.status === "uploading")) return notice("Wait a moment — your document is still uploading.");
  const files = pending.filter((a) => a.status === "ready");
  if (!text.trim()) {
    if (!files.length) return;
    text = files.length === 1 ? "Please read the attached document and give me a short summary." : "Please read the attached documents and give me a short summary of each.";
  }
  pending = []; renderPending();
  sending = true; $("#sendBtn").disabled = true;
  $("#empty").hidden = true;
  if (!conversationId) {
    const c = await api("/api/conversations", { method: "POST" });
    conversationId = c.id; history.replaceState(null, "", `#${c.id}`);
  }
  addMessage("user", text, "", files);
  const status = addMessage("assistant", "");
  status.querySelector(".body").innerHTML = `<div class="status"><span class="spin"></span><span>Thinking</span></div>`;

  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, text, timeZone, attachments: files.map((f) => f.id) }) });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || "Request failed");
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!chunk.startsWith("data: ")) continue;
        handleEvent(JSON.parse(chunk.slice(6)), status);
      }
    }
  } catch (err) {
    status.classList.add("error");
    status.querySelector(".body").innerHTML = md(err.message);
  } finally {
    sending = false; $("#sendBtn").disabled = false;
    await refresh();
    $("#title").textContent = state.conversations.find((c) => c.id === conversationId)?.title || "Conversation";
  }
}

function handleEvent(ev, node) {
  const body = node.querySelector(".body");
  if (ev.type === "status") {
    body.innerHTML = `<div class="status"><span class="spin"></span><span>${esc(ev.text)}…</span></div>`;
  } else if (ev.type === "reply") {
    const chipFor = { email: ["i-mail", "Draft ready to review"], event: ["i-cal", "Invite ready to review"], whatsapp: ["i-wa", "WhatsApp message ready to review"], notetaker: ["i-video", "Notetaker ready to send"] };
    const chips = (ev.approvals || []).filter(Boolean).map((a) => { const [ic, label] = chipFor[a.kind] || chipFor.event; return `<button class="chip" data-approval="${a.id}">${icon(ic, 12)}${esc(label)}</button>`; }).join("");
    body.innerHTML = md(ev.text) + gallery(ev.images) + (chips ? `<div class="queued">${chips}</div>` : "") + (canRead() ? toolsRow() : "");
    if (ev.approvals?.length) { showTab("approvals"); openPanel(false); }
  } else if (ev.type === "error") {
    node.classList.add("error");
    body.innerHTML = md(ev.text);
  }
  scrollDown();
}

// ---------------- approvals ----------------
const editing = new Set();

function renderApprovals() {
  const all = state.approvals;
  const pending = all.filter((a) => a.status === "pending" || a.status === "sending");
  const past = all.filter((a) => a.status === "done" || a.status === "declined").slice(0, 8);
  for (const id of ["#badge", "#badgeTop"]) { $(id).hidden = !pending.length; $(id).textContent = pending.length; }
  const body = $("#tab-approvals");
  if (!all.length) { body.innerHTML = `<p class="none">When Thinq drafts an email, a WhatsApp message or a meeting invite, it waits here for you. Nothing is sent until you approve it.</p>`; return; }
  body.innerHTML =
    (pending.length ? pending.map(card).join("") : `<p class="none">You're all caught up.</p>`) +
    (past.length ? `<h3>Recent</h3>` + past.map(card).join("") : "");
}

function fmtWhen(iso, tz = timeZone) {
  return new Date(iso).toLocaleString([], { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function card(a) {
  const p = a.payload, isEmail = a.kind === "email", isWa = a.kind === "whatsapp", isNote = a.kind === "notetaker", open = a.status === "pending" || a.status === "sending";
  const editable = isEmail || isWa;
  const kindIcon = isEmail ? "i-mail" : isWa ? "i-wa" : isNote ? "i-video" : "i-cal";
  const kindName = isEmail ? (p.replyToId ? "Reply" : "New email") : isWa ? "WhatsApp message" : isNote ? "Meeting notetaker" : "Calendar invite";
  const head = `<div class="kind">${icon(kindIcon)}${kindName}${!open ? ` · ${a.status === "done" ? (editable || isNote ? "Sent" : "Added") : "Declined"}` : ""}</div>`;
  let main;
  if (isNote) {
    main = `<dl><dt>Meeting</dt><dd>${esc(p.title)}</dd><dt>Joins</dt><dd>${p.joinAt ? esc(fmtWhen(p.joinAt)) : "Right away"}</dd><dt>Link</dt><dd>${esc(p.meetingUrl.replace(/^https:\/\//, "").slice(0, 48))}</dd></dl>`;
  } else if (isWa) {
    main = `<dl><dt>To</dt><dd>${esc(p.chat)}${p.group ? " (group)" : ""}</dd></dl>${editing.has(a.id) ? `<textarea data-field="text">${esc(p.text)}</textarea>` : `<div class="text">${esc(p.text)}</div>`}`;
  } else if (isEmail && editing.has(a.id)) {
    main = `<label>To<input data-field="to" value="${esc(p.to.join(", "))}"></label>
      <label>Subject<input data-field="subject" value="${esc(p.subject)}"></label>
      <textarea data-field="body">${esc(p.body)}</textarea>`;
  } else if (isEmail) {
    main = `<dl><dt>To</dt><dd>${esc(p.to.join(", "))}</dd>${p.cc?.length ? `<dt>Cc</dt><dd>${esc(p.cc.join(", "))}</dd>` : ""}<dt>Subject</dt><dd>${esc(p.subject)}</dd></dl><div class="text">${esc(p.body)}</div>`;
  } else {
    main = `<dl><dt>What</dt><dd>${esc(p.title)}</dd><dt>When</dt><dd>${esc(fmtWhen(p.start, p.timeZone))} – ${esc(new Date(p.end).toLocaleTimeString([], { timeZone: p.timeZone, hour: "numeric", minute: "2-digit" }))}</dd>${p.attendees?.length ? `<dt>Guests</dt><dd>${esc(p.attendees.join(", "))}</dd>` : ""}</dl>${p.description ? `<div class="text">${esc(p.description)}</div>` : ""}`;
  }
  let actions = "";
  if (open && editing.has(a.id)) actions = `<button class="btn sm" data-act="save">Save changes</button><button class="btn ghost sm" data-act="cancel">Cancel</button>`;
  else if (open) actions = `<button class="btn sm" data-act="approve" ${a.status === "sending" ? "disabled" : ""}>${a.status === "sending" ? "Sending…" : editable ? "Send" : isNote ? "Send notetaker" : "Add to calendar"}</button>${editable ? `<button class="btn ghost sm" data-act="edit">Edit</button>` : ""}<button class="btn ghost sm" data-act="decline">Decline</button>`;
  const result = a.status === "done" && a.result?.note ? `<p class="result">${esc(a.result.note)}</p>` : a.status === "done" && a.result?.link ? `<p class="result"><a class="link" href="${esc(a.result.link)}" target="_blank" rel="noopener">Open in Google Calendar</a></p>` : "";
  return `<article class="apv ${open ? "" : "done"}" data-id="${a.id}">${head}${main}${a.error && open ? `<p class="err">Last attempt failed: ${esc(a.error)}</p>` : ""}${result}${actions ? `<div class="actions">${actions}</div>` : ""}</article>`;
}

$("#tab-approvals").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]"); if (!btn) return;
  const cardEl = btn.closest(".apv"); const id = cardEl.dataset.id; const act = btn.dataset.act;
  try {
    if (act === "edit") { editing.add(id); renderApprovals(); return; }
    if (act === "cancel") { editing.delete(id); renderApprovals(); return; }
    if (act === "save") {
      const val = (f) => cardEl.querySelector(`[data-field="${f}"]`).value;
      const edits = cardEl.querySelector('[data-field="text"]')
        ? { text: val("text") }
        : { to: val("to").split(",").map((s) => s.trim()).filter(Boolean), subject: val("subject"), body: val("body") };
      await api(`/api/approvals/${id}`, { method: "PATCH", body: JSON.stringify(edits) });
      editing.delete(id);
    }
    if (act === "approve") { btn.disabled = true; btn.textContent = "Sending…"; await api(`/api/approvals/${id}/approve`, { method: "POST" }); loadAgenda(); }
    if (act === "decline") await api(`/api/approvals/${id}/decline`, { method: "POST" });
  } catch (err) { alert(err.message); }
  await refresh();
});

// ---------------- agenda ----------------
async function loadAgenda() {
  const body = $("#tab-agenda");
  try {
    const { events } = await api(`/api/agenda?timeZone=${encodeURIComponent(timeZone)}`);
    if (!events.length) { body.innerHTML = `<p class="none">Nothing on your calendar for the next three days.</p>`; return; }
    const byDay = {};
    for (const e of events) { const k = new Date(e.allDay ? `${e.start}T00:00` : e.start).toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }); (byDay[k] ||= []).push(e); }
    body.innerHTML = Object.entries(byDay).map(([day, evs]) => `<h3>${esc(day)}</h3>` + evs.map((e) => `<div class="event"><time>${e.allDay ? "All day" : esc(new Date(e.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</time><div><b>${esc(e.title)}</b><span>${esc([e.location, e.attendees?.length ? `${e.attendees.length} guest${e.attendees.length > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · "))}</span></div></div>`).join("")).join("");
  } catch (err) { body.innerHTML = `<p class="none">${esc(err.message)}</p>`; }
}

// ---------------- routines (tasks on a schedule) ----------------
let routinesData = [];
const ROUTINE_EXAMPLES = [
  "Every weekday at 8am, summarise my unread emails and tell me what needs a reply",
  "Every Sunday at 6pm, preview my calendar for the coming week",
  "Every day at 9pm, send Mum a goodnight message on WhatsApp",
];
const RT_STATUS = { active: "On", needs_ok: "Needs your OK", paused: "Paused", done: "Finished" };
async function loadRoutines() {
  try { routinesData = (await api("/api/routines")).routines; } catch (err) { $("#tab-routines").innerHTML = `<p class="none">${esc(err.message)}</p>`; return; }
  renderRoutines();
}
function renderRoutines() {
  const body = $("#tab-routines"), list = routinesData;
  const waiting = list.filter((r) => r.status === "needs_ok").length;
  $("#rtBadge").hidden = !waiting; $("#rtBadge").textContent = waiting;
  const when = (iso, tz) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
  const intro = `<p class="bots-intro">Routines are tasks Thinq does on a schedule without being asked again. Ask in chat to add one.</p>`;
  if (!list.length) {
    body.innerHTML = intro + `<div class="none">No routines yet. Try asking:${ROUTINE_EXAMPLES.map((t, i) => `<button class="btn ghost sm" data-rtexample="${i}">“${esc(t)}”</button>`).join("")}</div>`;
    return;
  }
  body.innerHTML = intro + list.map((r) => {
    const what = r.kind === "report"
      ? `<p class="purpose">${esc(r.instruction)}</p><small class="rt-deliver">Result: notification + “Routine: ${esc(r.title)}” chat${r.emailMe ? " + email to you" : ""}</small>`
      : `<p class="purpose">${r.writeFresh ? `Thinq writes: ${esc(r.instruction)}` : `“${esc(r.messageText)}”`}</p><small class="rt-deliver">To <b>${esc(r.recipientName)}</b> by ${r.channel === "whatsapp" ? "WhatsApp (from your number)" : "email (from your Gmail)"}${r.writeFresh ? (r.autoSend ? " · sent without asking" : " · each one waits in Approvals") : ""}</small>`;
    const okBox = r.status === "needs_ok" ? `<div class="rt-ok">
        <b>Turn this on?</b> Thinq will send ${r.writeFresh ? "a message it writes" : "this message"} to ${esc(r.recipientName)} ${esc(r.schedule)}.
        ${r.writeFresh ? `<label class="check-row"><input type="checkbox" data-autosend> Send without asking me each time</label>` : ""}
        <button class="btn sm" data-rton>Turn on</button>
      </div>` : "";
    return `<article class="bot rt ${r.status}" data-rt="${esc(r.id)}">
      <header><b>${esc(r.title)}</b><span class="pill-status">${RT_STATUS[r.status] || esc(r.status)}</span></header>
      ${what}
      <small class="rt-when">${esc(r.schedule)}${r.status === "active" ? ` · next ${when(r.nextRunAt, r.timeZone)}` : ""}</small>
      ${r.lastResult ? `<small class="rt-last">Last run${r.lastRunAt ? ` ${when(r.lastRunAt, r.timeZone)}` : ""}: ${esc(r.lastResult)}</small>` : ""}
      ${okBox}
      <div class="bot-actions">
        ${r.status === "active" ? `<button class="btn ghost sm" data-rtrun>Run now</button><button class="btn ghost sm" data-rtpause>Pause</button>` : ""}
        ${r.status === "paused" ? `<button class="btn ghost sm" data-rtresume>Resume</button>` : ""}
        ${r.kind === "report" && r.conversationId ? `<a class="btn ghost sm" href="#${esc(r.conversationId)}" data-rtopen>Results</a>` : ""}
        <button class="btn ghost sm danger-text" data-rtdel>Delete</button>
      </div>
    </article>`;
  }).join("") + `<p class="bots-foot">To change a routine, just ask Thinq — e.g. “move my email summary to 7:30”.</p>`;
}
$("#tab-routines").addEventListener("click", async (e) => {
  const ex = e.target.closest("[data-rtexample]");
  if (ex) { const i = $("#input"); i.value = ROUTINE_EXAMPLES[ex.dataset.rtexample]; autosize(); i.focus(); closeDrawers(); return; }
  const card = e.target.closest("[data-rt]"); if (!card) return;
  const id = card.dataset.rt, r = routinesData.find((x) => x.id === id);
  try {
    if (e.target.closest("[data-rton]")) {
      await api(`/api/routines/${id}/on`, { method: "POST", body: JSON.stringify({ autoSend: Boolean(card.querySelector("[data-autosend]")?.checked) }) });
      notice(`“${r.title}” is on.`, "ok");
    } else if (e.target.closest("[data-rtrun]")) {
      const b = e.target.closest("[data-rtrun]"); b.disabled = true; b.textContent = "Running…";
      const out = await api(`/api/routines/${id}/run`, { method: "POST" });
      notice(out.result, "ok"); refresh();
    } else if (e.target.closest("[data-rtpause]") || e.target.closest("[data-rtresume]")) {
      await api(`/api/routines/${id}`, { method: "PATCH", body: JSON.stringify({ paused: Boolean(e.target.closest("[data-rtpause]")) }) });
    } else if (e.target.closest("[data-rtdel]")) {
      if (!confirm(`Delete “${r.title}”?`)) return;
      await api(`/api/routines/${id}`, { method: "DELETE" });
    } else if (e.target.closest("[data-rtopen]")) {
      e.preventDefault(); await openConversation(r.conversationId); closeDrawers(); return;
    } else return;
    loadRoutines();
  } catch (err) { notice(err.message); loadRoutines(); }
});

// ---------------- group bots (Telegram) ----------------
let botsData = null;
const BOT_EXAMPLE = "Build a bot for my running club's Telegram group. It should answer questions about our runs (we meet Saturdays 7am at the park gates, 5k and 10k groups, bring water) and remind everyone every Friday at 6pm about Saturday's run.";
async function loadBots() {
  const body = $("#tab-bots");
  try { botsData = await api("/api/bots"); } catch (err) { body.innerHTML = `<p class="none">${esc(err.message)}</p>`; return; }
  renderBots();
}
function renderBots() {
  const body = $("#tab-bots"), list = botsData?.bots || [], handle = botsData?.telegram?.username;
  const when = (iso, tz) => iso ? new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
  const intro = `<p class="bots-intro">Bots answer questions and post reminders in your Telegram groups. They only know what you tell them — never your email or calendar.</p>`;
  if (!list.length) {
    body.innerHTML = intro + `<div class="none">No bots yet.<br>Ask Thinq to build one, for example:<button class="btn ghost sm" id="botExample">“Build a bot for my running club…”</button></div>`;
    $("#botExample").addEventListener("click", () => { const i = $("#input"); i.value = BOT_EXAMPLE; autosize(); i.focus(); closeDrawers(); });
    return;
  }
  body.innerHTML = intro + list.map((b) => `
    <article class="bot ${b.status}" data-bot="${esc(b.id)}">
      <header><b>${esc(b.name)}</b><span class="pill-status">${b.status === "active" ? "Active" : "Paused"}</span></header>
      ${b.purpose ? `<p class="purpose">${esc(b.purpose)}</p>` : ""}
      <h4>Groups</h4>
      ${b.groups.length ? `<ul class="bot-groups">${b.groups.map((g) => `<li><span>${esc(g.title || "Telegram group")}${g.paused ? " · paused" : ""}</span><button class="mini" data-unlink="${esc(g.chatId)}">Remove</button></li>`).join("")}</ul>` : `<p class="muted">Not in a group yet.</p>`}
      <div class="link-box" hidden></div>
      <h4>Reminders</h4>
      ${b.reminders.length ? `<ul class="bot-rems">${b.reminders.map((r) => `<li class="${r.active ? "" : "done"}"><div><span>${esc(r.message)}</span><small>${esc(r.schedule)}${r.active ? ` · next ${when(r.nextRunAt, b.timeZone)}` : " · finished"}</small></div><button class="mini" data-delrem="${esc(r.id)}" aria-label="Delete reminder">${icon("i-x", 11)}</button></li>`).join("")}</ul>` : `<p class="muted">No reminders. Ask Thinq to add some.</p>`}
      <div class="bot-actions">
        <button class="btn sm" data-link>Link a group</button>
        <button class="btn ghost sm" data-toggle>${b.status === "active" ? "Pause" : "Resume"}</button>
        <button class="btn ghost sm danger-text" data-delbot>Delete</button>
      </div>
    </article>`).join("") + `<p class="bots-foot">To change a bot's facts or reminders, just ask Thinq — e.g. “move the Friday reminder to 7pm”.${handle ? ` Bot: <a class="link" href="https://t.me/${esc(handle)}" target="_blank" rel="noopener">@${esc(handle)}</a>` : ""}</p>`;
}
$("#tab-bots").addEventListener("click", async (e) => {
  const card = e.target.closest("[data-bot]"); if (!card) return;
  const id = card.dataset.bot, bot = botsData.bots.find((b) => b.id === id), handle = botsData.telegram?.username;
  try {
    if (e.target.closest("[data-link]")) {
      const r = await api(`/api/bots/${id}/link-code`, { method: "POST" });
      const box = card.querySelector(".link-box");
      box.hidden = false;
      box.innerHTML = `<ol>
          <li>${handle ? `<a class="link" href="https://t.me/${esc(handle)}?startgroup=thinq" target="_blank" rel="noopener">Add @${esc(handle)} to your group</a>` : "Add the Thinq bot to your group"}</li>
          <li>A group admin sends this in the group:</li>
        </ol>
        <div class="link-code"><code>/link ${esc(r.code)}</code><button class="mini" data-copycode="/link ${esc(r.code)}">Copy</button></div>
        <small>Works for ${r.expiresInMinutes} minutes.</small>`;
    } else if (e.target.closest("[data-copycode]")) {
      const b = e.target.closest("[data-copycode]");
      await navigator.clipboard?.writeText(b.dataset.copycode).catch(() => {});
      b.textContent = "Copied";
    } else if (e.target.closest("[data-toggle]")) {
      await api(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify({ paused: bot.status === "active" }) });
      loadBots();
    } else if (e.target.closest("[data-delbot]")) {
      if (!confirm(`Delete ${bot.name}? It will stop answering and posting reminders in ${bot.groups.length || "its"} group${bot.groups.length === 1 ? "" : "s"}.`)) return;
      await api(`/api/bots/${id}`, { method: "DELETE" }); loadBots();
    } else if (e.target.closest("[data-delrem]")) {
      await api(`/api/bots/${id}/reminders/${e.target.closest("[data-delrem]").dataset.delrem}`, { method: "DELETE" }); loadBots();
    } else if (e.target.closest("[data-unlink]")) {
      if (!confirm("Remove the bot from this group? It will stop answering and posting reminders there.")) return;
      await api(`/api/bots/${id}/groups/${encodeURIComponent(e.target.closest("[data-unlink]").dataset.unlink)}`, { method: "DELETE" }); loadBots();
    }
  } catch (err) { notice(err.message); }
});

function showTab(tab) {
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab));
  $("#tab-approvals").hidden = tab !== "approvals"; $("#tab-agenda").hidden = tab !== "agenda"; $("#tab-bots").hidden = tab !== "bots"; $("#tab-routines").hidden = tab !== "routines";
  if (tab === "agenda") loadAgenda();
  if (tab === "bots") loadBots();
  if (tab === "routines") loadRoutines();
}

// ---------------- documents ----------------
const MAX_DOC_BYTES = 10 * 1024 * 1024;
let pending = []; // documents attached to the message being written

function renderPending() {
  const box = $("#atts");
  box.hidden = pending.length === 0;
  box.innerHTML = pending.map((a) => `<span class="att${a.status === "error" ? " err" : ""}">${a.status === "uploading" ? `<span class="spin"></span>` : icon("i-doc", 13)}<span class="nm" title="${esc(a.name)}">${esc(a.name)}</span><span class="meta">${a.status === "uploading" ? "Reading…" : a.status === "error" ? esc(a.error) : fileMeta(a)}</span><button type="button" data-remove="${a.key}" aria-label="Remove ${esc(a.name)}">${icon("i-x", 11)}</button></span>`).join("");
}

async function addFiles(fileList) {
  for (const file of fileList) {
    if (pending.length >= 5) { notice("You can attach up to 5 documents to one message."); break; }
    const item = { key: crypto.randomUUID(), name: file.name, status: "uploading" };
    pending.push(item);
    renderPending();
    if (file.size > MAX_DOC_BYTES) { Object.assign(item, { status: "error", error: "Over 10 MB" }); renderPending(); continue; }
    try {
      const res = await fetch("/api/documents", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(file.name) }, body: file });
      if (res.status === 401) { location.href = "/login.html"; return; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't read that file");
      Object.assign(item, data, { status: "ready" });
      if (data.truncated) notice(`“${file.name}” is very long, so Thinq kept the first part of it (about 100,000 words).`);
    } catch (err) {
      Object.assign(item, { status: "error", error: err.message });
    }
    if (!pending.includes(item) && item.id) fetch(`/api/documents/${item.id}`, { method: "DELETE" }).catch(() => {});
    renderPending();
  }
  $("#input").focus();
}

$("#attachBtn").addEventListener("click", () => $("#fileInput").click());
$("#fileInput").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });
$("#atts").addEventListener("click", (e) => {
  const b = e.target.closest("[data-remove]"); if (!b) return;
  const item = pending.find((a) => a.key === b.dataset.remove);
  pending = pending.filter((a) => a !== item);
  if (item?.id) fetch(`/api/documents/${item.id}`, { method: "DELETE" }).catch(() => {});
  renderPending();
});
const composer = $("#composer");
let dragDepth = 0;
composer.addEventListener("dragenter", (e) => { if (!e.dataTransfer?.types.includes("Files")) return; e.preventDefault(); dragDepth++; composer.classList.add("dragging"); });
composer.addEventListener("dragover", (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
composer.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; composer.classList.remove("dragging"); } });
composer.addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; composer.classList.remove("dragging"); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
$("#input").addEventListener("paste", (e) => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); addFiles(f); } });

// ---------------- voice notes ----------------
// Records in the browser, sends the audio once to be turned into text, and puts the text in the box so you can check it before sending.
const MAX_REC_SECONDS = 120;
let rec = null; // { recorder, stream, chunks, started, timer, cancelled }

const canRecord = () => Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
function setRecUI(mode) { // "off" | "recording" | "busy"
  const on = mode !== "off";
  $("#rec").hidden = !on; $("#input").hidden = on; $("#attachBtn").hidden = on;
  $("#rec").classList.toggle("busy", mode === "busy");
  $("#recCancel").hidden = mode === "busy";
  $("#recLabel").textContent = mode === "busy" ? "Turning your voice note into text…" : "Recording";
  $("#recTime").hidden = mode === "busy";
  const mic = $("#micBtn");
  mic.classList.toggle("on", mode === "recording");
  mic.disabled = mode === "busy";
  mic.innerHTML = icon(mode === "recording" ? "i-stop" : "i-mic", mode === "recording" ? 15 : 17);
  mic.setAttribute("aria-label", mode === "recording" ? "Stop recording" : "Record a voice note");
  $("#sendBtn").disabled = on || sending;
}

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    return notice(err.name === "NotAllowedError" ? "Thinq needs microphone access for voice notes. Allow it in your browser's address bar and try again." : "Couldn't find a microphone.");
  }
  const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported?.(t));
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  rec = { recorder, stream, chunks: [], started: Date.now(), cancelled: false };
  recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
  recorder.onstop = finishRecording;
  recorder.start(1000);
  rec.timer = setInterval(() => {
    const s = Math.floor((Date.now() - rec.started) / 1000);
    $("#recTime").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} / 2:00`;
    if (s >= MAX_REC_SECONDS) stopRecording();
  }, 250);
  $("#recTime").textContent = "0:00 / 2:00";
  setRecUI("recording");
}
function stopRecording(cancel = false) {
  if (!rec) return;
  rec.cancelled = cancel;
  clearInterval(rec.timer);
  if (rec.recorder.state !== "inactive") rec.recorder.stop();
}
async function finishRecording() {
  const { stream, chunks, recorder, cancelled, started } = rec;
  rec = null;
  stream.getTracks().forEach((t) => t.stop());
  if (cancelled) return setRecUI("off");
  if (Date.now() - started < 800) { setRecUI("off"); return notice("That was very short — hold the recording a little longer."); }
  setRecUI("busy");
  try {
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    const res = await fetch("/api/transcribe", { method: "POST", headers: { "Content-Type": blob.type }, body: blob });
    if (res.status === 401) { location.href = "/login.html"; return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Couldn't turn that recording into text.");
    const box = $("#input");
    box.value = box.value.trim() ? `${box.value.trim()} ${data.text}` : data.text;
    setRecUI("off");
    autosize(); box.focus(); box.setSelectionRange(box.value.length, box.value.length);
  } catch (err) {
    setRecUI("off");
    notice(err.message);
  }
}
$("#micBtn").addEventListener("click", () => (rec ? stopRecording() : startRecording()));
$("#recCancel").addEventListener("click", () => stopRecording(true));

// ---------------- read aloud ----------------
// Uses the server's voices when they're set up (state.speechAvailable): ElevenLabs, or Cloudflare's free voice when
// ElevenLabs is out of credits. Falls back to the browser's built-in voice whenever the server can't make audio.
const canSpeak = "speechSynthesis" in window;
const canRead = () => canSpeak || Boolean(state?.speechAvailable);
const SILENT = "data:audio/wav;base64,UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";
const player = new Audio();
const voiceCache = new Map(); // text -> audio URL, so replaying a message doesn't use credits again
let naturalOff = false; // set after the natural voice runs out of credits, for the rest of this visit
let speakingBtn = null, speakAbort = null;

function setSpeakLabel(b, label) { b.querySelector("span").textContent = label; }
function stopSpeaking() {
  speakAbort?.abort(); speakAbort = null;
  player.onended = player.onerror = null; player.pause();
  if (canSpeak) speechSynthesis.cancel();
  if (speakingBtn) { speakingBtn.classList.remove("speaking"); setSpeakLabel(speakingBtn, "Read aloud"); }
  speakingBtn = null;
}
function speakWithBrowser(b, text) {
  if (!canSpeak) { stopSpeaking(); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.03;
  u.onend = u.onerror = () => { if (speakingBtn === b) stopSpeaking(); };
  setSpeakLabel(b, "Stop reading");
  speechSynthesis.speak(u);
}
async function naturalVoiceUrl(text, signal) {
  if (voiceCache.has(text)) return voiceCache.get(text);
  const res = await fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal });
  if (res.status === 401) { location.href = "/login.html"; throw new Error("Please sign in again."); }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (data.quota) naturalOff = true;
    throw Object.assign(new Error(data.error || `Read aloud failed (${res.status})`), { quota: data.quota });
  }
  const url = URL.createObjectURL(await res.blob());
  if (voiceCache.size >= 20) { const [k, v] = voiceCache.entries().next().value; URL.revokeObjectURL(v); voiceCache.delete(k); }
  voiceCache.set(text, url);
  return url;
}
$("#messages").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-speak]"); if (!b) return;
  const was = speakingBtn === b;
  stopSpeaking();
  if (was) return;
  const body = b.closest(".body").cloneNode(true);
  body.querySelectorAll(".tools,.queued").forEach((n) => n.remove());
  body.querySelectorAll("p,li,tr").forEach((n) => n.append(". "));
  const text = body.textContent.replace(/\s*\.\s*\.\s*/g, ". ").replace(/\s+/g, " ").trim();
  speakingBtn = b; b.classList.add("speaking");
  if (!state?.speechAvailable || naturalOff) return speakWithBrowser(b, text);

  // Start playback inside the click so phones (iOS Safari) allow the audio once it arrives.
  player.src = SILENT; player.play().catch(() => {});
  const ctrl = new AbortController(); speakAbort = ctrl;
  setSpeakLabel(b, voiceCache.has(text) ? "Stop reading" : "Loading voice…");
  try {
    const url = await naturalVoiceUrl(text, ctrl.signal);
    if (speakingBtn !== b) return; // stopped or switched while loading
    speakAbort = null;
    player.onended = () => { if (speakingBtn === b) stopSpeaking(); };
    player.onerror = () => { if (speakingBtn === b) speakWithBrowser(b, text); };
    player.src = url;
    setSpeakLabel(b, "Stop reading");
    await player.play();
  } catch (err) {
    if (err.name === "AbortError" || speakingBtn !== b) return;
    if (err.quota) notice("Thinq's voices are used up for today, so it's using your device's voice instead.", "info");
    else console.warn("Read aloud:", err.message);
    player.onended = player.onerror = null;
    speakWithBrowser(b, text);
  }
});

// Small message at the top of the chat for problems with uploads or recording.
let noticeTimer;
function notice(text, kind = "err") {
  // While a connection dialog is open, show the message inside it (the page banner is hidden behind it).
  const dlg = $("#connDialog");
  if (dlg?.open) {
    let msg = dlg.querySelector(".dlg-msg");
    if (!msg) { msg = document.createElement("p"); dlg.querySelector(".conn-dialog-head").after(msg); }
    msg.className = `dlg-msg banner ${kind}`; msg.textContent = text; msg.hidden = false;
    clearTimeout(msg._t); msg._t = setTimeout(() => { msg.hidden = true; }, 7000);
    return;
  }
  const banner = $("#banner");
  banner.hidden = false; banner.className = `banner ${kind}`; banner.textContent = text;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { banner.hidden = true; }, 7000);
}

// ---------------- drawers (narrow screens) ----------------
const narrow = () => matchMedia("(max-width:1100px)").matches;
function openPanel(force = true) { if (!narrow() && force !== true) return; if (narrow()) { $("#panel").classList.add("open"); $("#scrim").hidden = false; } }
function closeDrawers() { $("#panel").classList.remove("open"); $("#sidebar").classList.remove("open"); $("#scrim").hidden = true; }

// ---------------- wiring ----------------
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (rec) return;
  if (pending.some((a) => a.status === "uploading")) return notice("Wait a moment — your document is still uploading.");
  const t = $("#input").value; $("#input").value = ""; autosize(); send(t);
});
$("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); } });
const autosize = () => { const t = $("#input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 200) + "px"; };
$("#input").addEventListener("input", autosize);
addEventListener("resize", autosize);
$("#messages").addEventListener("load", (e) => { if (e.target.tagName === "IMG") e.target.dataset.loaded = ""; }, true);
$("#suggestions").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) send(b.textContent); });
$("#newChat").addEventListener("click", () => openConversation(null));
$("#convos").addEventListener("click", async (e) => {
  const d = e.target.closest("[data-del]");
  if (!d) return;
  e.preventDefault(); e.stopPropagation();
  const c = state.conversations.find((x) => x.id === d.dataset.del);
  if (!confirm(`Delete “${c?.title || "this chat"}”? Its messages, attached documents and images will be removed for good.`)) return;
  try {
    await api(`/api/conversations/${d.dataset.del}`, { method: "DELETE" });
    if (d.dataset.del === conversationId) await openConversation(null);
    await refresh();
  } catch (err) { notice(err.message); }
});
$("#convos").addEventListener("click", (e) => { if (e.target.closest("[data-del]")) return; const a = e.target.closest("a[data-id]"); if (a) { e.preventDefault(); openConversation(a.dataset.id); } });
$("#notes").addEventListener("click", async (e) => { const b = e.target.closest("[data-note]"); if (b) { await api(`/api/notes/${b.dataset.note}`, { method: "DELETE" }); refresh(); } });
$("#messages").addEventListener("click", (e) => { const c = e.target.closest("[data-approval]"); if (!c) return; showTab("approvals"); openPanel(true); const el = document.querySelector(`.apv[data-id="${c.dataset.approval}"]`); el?.scrollIntoView({ block: "center", behavior: "smooth" }); el?.classList.add("flash"); setTimeout(() => el?.classList.remove("flash"), 1500); });
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$("#openPanel").addEventListener("click", () => openPanel(true));
$("#closePanel").addEventListener("click", closeDrawers);
$("#openSide").addEventListener("click", () => { $("#sidebar").classList.add("open"); $("#scrim").hidden = false; });
$("#scrim").addEventListener("click", closeDrawers);
const closeAcctMenu = () => { const m = $("#acctMenu"); if (m && !m.hidden) { m.hidden = true; $("#acctBtn")?.setAttribute("aria-expanded", "false"); } };
document.addEventListener("click", (e) => { if (!e.target.closest("#acctMenu, #acctBtn")) closeAcctMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawers(); closeAcctMenu(); } });

// Google sign-in result banner
const g = new URLSearchParams(location.search).get("google");
if (g) {
  const banner = $("#banner"); banner.hidden = false;
  const msgs = {
    connected: ["ok", "Gmail & Calendar connected. Thinq can now read your email and calendar — and still asks before sending anything."],
    "not-configured": ["", "Connecting Gmail isn't set up on this server yet."],
    access_denied: ["", "Google access wasn't granted, so Thinq is still using the demo inbox."],
    missing_permissions: ["", "Thinq needs all three permissions (read email, send email when you approve, and calendar). Click “Connect Gmail & Calendar” again and tick every box."],
    expired: ["", "That sign-in took too long. Please try connecting again."],
  };
  const [cls, text] = msgs[g] || ["err", "Couldn't connect Google. Please try again."];
  banner.className = `banner ${cls}`; banner.textContent = text;
  history.replaceState(null, "", location.pathname + location.hash);
}

await refresh();
$("#fileInput").accept = state.documentTypes || "";
$("#micBtn").hidden = !(state.voiceAvailable && canRecord());
if (state.images?.available) $("#input").placeholder = "Ask Thinq anything, attach a document, or ask for an image…";
await openConversation(location.hash.slice(1) || null);
loadAgenda();
await initPush();
tour.maybeStart();
// Tapping a notification while Thinq is open switches to that chat.
addEventListener("hashchange", () => { const id = location.hash.slice(1); if (id && id !== conversationId) openConversation(id); });
