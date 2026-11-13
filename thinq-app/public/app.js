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
  renderAccount(); renderConn(); renderNotes(); renderConvos(); renderApprovals(); renderGreeting();
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
    <button class="btn ghost sm" id="logout">Log out</button>`;
  $("#logout").addEventListener("click", async () => {
    await fetch("/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
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
    ? `<div class="label">Recent</div>` + list.map((c) => `<a href="#${c.id}" data-id="${c.id}" ${c.id === conversationId ? 'aria-current="true"' : ""}>${esc(c.title)}</a>`).join("")
    : "";
}

// ---------------- conversations ----------------
async function openConversation(id) {
  conversationId = id;
  $("#messages").querySelectorAll(".msg").forEach((m) => m.remove());
  if (!id) {
    $("#empty").hidden = false; $("#title").textContent = "New conversation";
    history.replaceState(null, "", location.pathname); renderConvos(); return;
  }
  try {
    const c = await api(`/api/conversations/${id}`);
    $("#title").textContent = c.title;
    $("#empty").hidden = c.messages.length > 0;
    c.messages.forEach((m) => addMessage(m.role, m.text));
    history.replaceState(null, "", `#${id}`);
  } catch { conversationId = null; $("#empty").hidden = false; }
  renderConvos();
  closeDrawers();
}

function addMessage(role, text, extra = "") {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  wrap.innerHTML = role === "user"
    ? `<div class="body">${esc(text)}</div>`
    : `<div class="av" aria-hidden="true">${icon("mark", 15)}</div><div class="body">${md(text)}${extra}</div>`;
  $("#messages").appendChild(wrap);
  scrollDown();
  return wrap;
}

const scrollDown = () => { const m = $("#messages"); m.scrollTop = m.scrollHeight; };

async function send(text) {
  if (sending || !text.trim()) return;
  sending = true; $("#sendBtn").disabled = true;
  $("#empty").hidden = true;
  if (!conversationId) {
    const c = await api("/api/conversations", { method: "POST" });
    conversationId = c.id; history.replaceState(null, "", `#${c.id}`);
  }
  addMessage("user", text);
  const status = addMessage("assistant", "");
  status.querySelector(".body").innerHTML = `<div class="status"><span class="spin"></span><span>Thinking</span></div>`;

  try {
    const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId, text, timeZone }) });
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
    body.innerHTML = md(ev.text) + (chips ? `<div class="queued">${chips}</div>` : "");
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

// ---------------- drawers (narrow screens) ----------------
const narrow = () => matchMedia("(max-width:1100px)").matches;
function openPanel(force = true) { if (!narrow() && force !== true) return; if (narrow()) { $("#panel").classList.add("open"); $("#scrim").hidden = false; } }
function closeDrawers() { $("#panel").classList.remove("open"); $("#sidebar").classList.remove("open"); $("#scrim").hidden = true; }

// ---------------- wiring ----------------
$("#composer").addEventListener("submit", (e) => { e.preventDefault(); const t = $("#input").value; $("#input").value = ""; autosize(); send(t); });
$("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); } });
const autosize = () => { const t = $("#input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 200) + "px"; };
$("#input").addEventListener("input", autosize);
$("#suggestions").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) send(b.textContent); });
$("#newChat").addEventListener("click", () => openConversation(null));
$("#convos").addEventListener("click", (e) => { const a = e.target.closest("a[data-id]"); if (a) { e.preventDefault(); openConversation(a.dataset.id); } });
$("#notes").addEventListener("click", async (e) => { const b = e.target.closest("[data-note]"); if (b) { await api(`/api/notes/${b.dataset.note}`, { method: "DELETE" }); refresh(); } });
$("#messages").addEventListener("click", (e) => { const c = e.target.closest("[data-approval]"); if (!c) return; showTab("approvals"); openPanel(true); const el = document.querySelector(`.apv[data-id="${c.dataset.approval}"]`); el?.scrollIntoView({ block: "center", behavior: "smooth" }); el?.classList.add("flash"); setTimeout(() => el?.classList.remove("flash"), 1500); });
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
$("#openPanel").addEventListener("click", () => openPanel(true));
$("#closePanel").addEventListener("click", closeDrawers);
$("#openSide").addEventListener("click", () => { $("#sidebar").classList.add("open"); $("#scrim").hidden = false; });
$("#scrim").addEventListener("click", closeDrawers);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawers(); });

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
await openConversation(location.hash.slice(1) || null);
loadAgenda();
