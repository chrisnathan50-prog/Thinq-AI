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
  renderAccount(); renderConn(); renderWhatsApp(); renderNotes(); renderConvos(); renderApprovals(); renderGreeting();
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
      ${state.admin ? `<a role="menuitem" href="/app/admin">${icon("i-check", 14)}Tester requests${state.admin.pendingTesters ? `<span class="badge">${state.admin.pendingTesters}</span>` : ""}</a>` : ""}
      <button role="menuitem" class="danger" id="deleteAll">${icon("i-trash", 14)}Delete all chats</button>
      <button role="menuitem" id="logout">${icon("i-logout", 14)}Log out</button>
    </div>`;
  const menu = $("#acctMenu"), btn = $("#acctBtn");
  const setMenu = (open) => { menu.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
  btn.addEventListener("click", (e) => { e.stopPropagation(); setMenu(menu.hidden); });
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

function renderConn() {
  const c = $("#conn");
  let html = "";
  if (state.mode === "google") {
    html += `<div class="row"><span class="dot live"></span><b>Gmail & Calendar connected</b></div><p>${esc(state.profile?.email)}</p><button class="btn ghost sm" id="disconnect">Disconnect</button>`;
  } else {
    html += `<div class="row"><span class="dot demo"></span><b>Demo mode</b></div><p>You're using a sample inbox and calendar. Nothing is really sent.</p>`;
    html += state.googleConfigured
      ? `<a class="btn sm" href="/auth/google/connect">Connect Gmail & Calendar</a>`
      : `<p>Connecting real accounts isn't set up on this server yet.</p>`;
  }
  if (!state.hasApiKey) {
    html += `<div class="row"><span class="dot off"></span><b>AI not set up yet</b></div><p>The server needs <code>${esc(state.apiKeyName)}</code>. See the README.</p>`;
  } else {
    const left = state.usage?.limit ? Math.max(0, state.usage.limit - state.usage.today) : null;
    html += `<p class="meta">AI: ${state.aiProvider === "groq" ? "Groq (free tier)" : "Claude"}${left !== null ? ` · ${left} of ${state.usage.limit} requests left today` : ""}</p>`;
  }
  c.innerHTML = html;
  $("#disconnect")?.addEventListener("click", async () => {
    if (!confirm("Disconnect your Google account? Thinq will lose access to your Gmail and Calendar and switch back to the demo inbox.")) return;
    await api("/auth/google/disconnect", { method: "POST" });
    await refresh(); loadAgenda();
  });
}

// ---------------- WhatsApp ----------------
let waPending = null; // { code, url, until } while waiting for the person to send the code
let waPoll = null;
function renderWhatsApp() {
  const box = $("#wa"), wa = state.whatsapp || {};
  box.hidden = !wa.available;
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
  box.innerHTML = `<div class="row">${icon("i-wa", 15)}<b>WhatsApp</b></div>
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
    const chips = (ev.approvals || []).filter(Boolean).map((a) => `<button class="chip" data-approval="${a.id}">${icon(a.kind === "email" ? "i-mail" : "i-cal", 12)}${esc(a.kind === "email" ? "Draft ready to review" : "Invite ready to review")}</button>`).join("");
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
  if (!all.length) { body.innerHTML = `<p class="none">When Thinq drafts an email or a meeting invite, it waits here for you. Nothing is sent until you approve it.</p>`; return; }
  body.innerHTML =
    (pending.length ? pending.map(card).join("") : `<p class="none">You're all caught up.</p>`) +
    (past.length ? `<h3>Recent</h3>` + past.map(card).join("") : "");
}

function fmtWhen(iso, tz = timeZone) {
  return new Date(iso).toLocaleString([], { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function card(a) {
  const p = a.payload, isEmail = a.kind === "email", open = a.status === "pending" || a.status === "sending";
  const head = `<div class="kind">${icon(isEmail ? "i-mail" : "i-cal")}${isEmail ? (p.replyToId ? "Reply" : "New email") : "Calendar invite"}${!open ? ` · ${a.status === "done" ? (isEmail ? "Sent" : "Added") : "Declined"}` : ""}</div>`;
  let main;
  if (isEmail && editing.has(a.id)) {
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
  else if (open) actions = `<button class="btn sm" data-act="approve" ${a.status === "sending" ? "disabled" : ""}>${a.status === "sending" ? "Sending…" : isEmail ? "Send" : "Add to calendar"}</button>${isEmail ? `<button class="btn ghost sm" data-act="edit">Edit</button>` : ""}<button class="btn ghost sm" data-act="decline">Decline</button>`;
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
      await api(`/api/approvals/${id}`, { method: "PATCH", body: JSON.stringify({ to: val("to").split(",").map((s) => s.trim()).filter(Boolean), subject: val("subject"), body: val("body") }) });
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

function showTab(tab) {
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab));
  $("#tab-approvals").hidden = tab !== "approvals"; $("#tab-agenda").hidden = tab !== "agenda";
  if (tab === "agenda") loadAgenda();
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
