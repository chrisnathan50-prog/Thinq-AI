// Admin page: usage analytics and the website's tester requests.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const dayLabel = (iso, opts = { month: "short", day: "numeric" }) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 401) { location.href = "/login.html"; throw new Error("Please sign in again."); }
  if (res.status === 403) { location.href = "/app"; throw new Error("Admins only."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------- views ----------------
function showView(v) {
  $$("[data-view]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === v)));
  $("#view-analytics").hidden = v !== "analytics";
  $("#view-testers").hidden = v !== "testers";
  history.replaceState(null, "", v === "testers" ? "#testers" : location.pathname);
  if (v === "analytics" && stats) renderCharts(); // sizes depend on the visible layout
}
$("#views").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) showView(b.dataset.view); });

// ================= ANALYTICS =================
let stats = null, days = 30, sortKey = "lastActive", sortDir = -1;

async function loadStats() {
  $("#updated").textContent = "Loading…";
  try {
    stats = await api(`/api/admin/analytics?days=${days}`);
    $("#updated").textContent = `Updated ${new Date(stats.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    renderKpis(); renderCharts(); renderFeatures(); renderChannels(); renderPeople();
  } catch (err) {
    $("#updated").textContent = err.message;
  }
}

$("#range").addEventListener("click", (e) => {
  const b = e.target.closest("[data-days]"); if (!b) return;
  days = Number(b.dataset.days);
  $$("[data-days]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  loadStats();
});
$("#refresh").addEventListener("click", loadStats);

function renderKpis() {
  const t = stats.totals;
  const tile = (label, value, sub) => `<div class="kpi"><span class="label">${label}</span><span class="value">${value}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</div>`;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}% of people` : "");
  $("#kpis").innerHTML = [
    tile("People", fmt(t.users), t.newUsers ? `+${fmt(t.newUsers)} new in ${stats.days} days` : `none new in ${stats.days} days`),
    tile("Active today", fmt(t.activeToday), pct(t.activeToday, t.users)),
    tile("Active last 7 days", fmt(t.active7), pct(t.active7, t.users)),
    tile(`AI requests · ${stats.days} days`, fmt(t.requests), `${fmt(t.requestsToday)} today`),
    tile("Gmail connected", fmt(t.gmail), pct(t.gmail, t.users)),
    tile("On WhatsApp", fmt(t.whatsapp), t.testersPending ? `${fmt(t.testersPending)} tester request${t.testersPending > 1 ? "s" : ""} waiting` : pct(t.whatsapp, t.users)),
  ].join("");
}

// ---------- time-series charts (inline SVG, one series each, no second axis) ----------
const niceStep = (max, ticks = 4) => {
  const raw = Math.max(1, max) / ticks, mag = 10 ** Math.floor(Math.log10(raw)), r = raw / mag;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
};
const tip = $("#tip");
function showTip(x, y, html) {
  tip.innerHTML = html; tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2))}px`;
  tip.style.top = `${Math.max(8, y - h - 12)}px`;
}
const hideTip = () => { tip.hidden = true; };

function timeChart(el, rows, key, kind, noun) {
  const W = Math.max(280, el.clientWidth), H = 210, m = { t: 14, r: kind === "line" ? 34 : 10, b: 26, l: 34 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(0, ...rows.map((r) => r[key]));
  const step = niceStep(max), top = Math.max(step, Math.ceil(max / step) * step);
  const band = iw / rows.length;
  const x = (i) => m.l + band * i + band / 2;
  const y = (v) => m.t + ih - (v / top) * ih;
  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(noun)} per day, last ${rows.length} days">`;
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`;
  }
  const ticksAt = [0, Math.floor((rows.length - 1) / 2), rows.length - 1];
  ticksAt.forEach((i, k) => svg += `<text class="tick" x="${x(i)}" y="${H - 8}" text-anchor="${k === 0 ? "start" : k === 2 ? "end" : "middle"}" ${k === 0 ? `dx="${-band / 2}"` : k === 2 ? `dx="${band / 2}"` : ""}>${dayLabel(rows[i].day)}</text>`);
  if (kind === "columns") {
    const bw = Math.max(2, Math.min(24, band - 2));
    rows.forEach((r, i) => {
      if (!r[key]) return;
      const h = Math.max(2, ih - (y(r[key]) - m.t)), bx = x(i) - bw / 2, by = m.t + ih - h, rad = Math.min(4, bw / 2, h);
      svg += `<path class="bar" data-i="${i}" d="M${bx},${by + h}V${by + rad}Q${bx},${by} ${bx + rad},${by}H${bx + bw - rad}Q${bx + bw},${by} ${bx + bw},${by + rad}V${by + h}Z"/>`;
    });
  } else {
    const pts = rows.map((r, i) => [x(i), y(r[key])]);
    svg += `<path class="area" d="M${pts[0][0]},${m.t + ih}L${pts.map((p) => p.join(",")).join("L")}L${pts.at(-1)[0]},${m.t + ih}Z"/>`;
    svg += `<path class="line" d="M${pts.map((p) => p.join(",")).join("L")}"/>`;
    const last = pts.at(-1);
    svg += `<circle class="dot" cx="${last[0]}" cy="${last[1]}" r="4"/><text class="end" x="${last[0] + 8}" y="${last[1] + 4}">${fmt(rows.at(-1)[key])}</text>`;
    svg += `<line class="cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/><circle class="dot hover" r="4" visibility="hidden"/>`;
  }
  rows.forEach((r, i) => svg += `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>`);
  el.innerHTML = svg + "</svg>";

  const svgEl = el.querySelector("svg");
  svgEl.addEventListener("mousemove", (e) => {
    const hit = e.target.closest(".hit"); if (!hit) return;
    const i = Number(hit.dataset.i), r = rows[i];
    if (kind === "line") {
      const cross = svgEl.querySelector(".cross"), dot = svgEl.querySelector(".dot.hover");
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(r[key])); dot.setAttribute("visibility", "visible");
    } else {
      svgEl.querySelectorAll(".bar").forEach((b) => b.classList.toggle("dim", b.dataset.i !== String(i)));
    }
    showTip(e.clientX, e.clientY, `<b>${dayLabel(r.day, { weekday: "short", month: "short", day: "numeric" })}</b><span>${fmt(r[key])} ${esc(noun)}${r[key] === 1 ? "" : "s"}</span>${key === "active" && r.signups ? `<span class="muted">${r.signups} new sign-up${r.signups > 1 ? "s" : ""}</span>` : ""}`);
  });
  svgEl.addEventListener("mouseleave", () => {
    hideTip();
    svgEl.querySelectorAll(".bar").forEach((b) => b.classList.remove("dim"));
    svgEl.querySelectorAll(".cross, .dot.hover").forEach((n) => n.setAttribute("visibility", "hidden"));
  });
}

function dataTable(rows, key, heading) {
  return `<table class="mini-table"><thead><tr><th>Day</th><th>${heading}</th></tr></thead><tbody>${rows.slice().reverse().map((r) => `<tr><td>${dayLabel(r.day, { weekday: "short", month: "short", day: "numeric" })}</td><td>${fmt(r[key])}</td></tr>`).join("")}</tbody></table>`;
}

function renderCharts() {
  if ($("#view-analytics").hidden) return;
  timeChart($("#chartActive"), stats.daily, "active", "line", "active person");
  timeChart($("#chartRequests"), stats.daily, "requests", "columns", "AI request");
  $("#tableActive").innerHTML = dataTable(stats.daily, "active", "Active people");
  $("#tableRequests").innerHTML = dataTable(stats.daily, "requests", "AI requests");
}
let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => stats && renderCharts(), 150); });

// ---------- feature usage: one series, sorted, value at the bar tip ----------
function renderFeatures() {
  const f = stats.features;
  if (!f.length) { $("#features").innerHTML = `<p class="empty-note">No feature use in this period yet.</p>`; return; }
  const max = Math.max(...f.map((x) => x.count));
  $("#features").innerHTML = `<ul class="barlist">${f.map((x) => `
    <li title="${esc(x.label)}: ${fmt(x.count)} times by ${x.people} ${x.people === 1 ? "person" : "people"}">
      <span class="name">${esc(x.label)}</span>
      <span class="track"><span class="fill" style="width:${Math.max(1.5, (x.count / max) * 100)}%"></span><span class="val">${fmt(x.count)}</span></span>
      <span class="who">${x.people} ${x.people === 1 ? "person" : "people"}</span>
    </li>`).join("")}</ul>`;
}

// ---------- app vs WhatsApp: one stacked bar, legend + direct labels ----------
function renderChannels() {
  const app = stats.channels.app || 0, wa = stats.channels.whatsapp || 0, total = app + wa;
  if (!total) { $("#channels").innerHTML = `<p class="empty-note">No conversations in this period yet. (Counting started with this update.)</p>`; return; }
  const pa = Math.round((app / total) * 100), pw = 100 - pa;
  $("#channels").innerHTML = `
    <div class="split-bar" role="img" aria-label="App ${pa}%, WhatsApp ${pw}%">
      ${app ? `<span class="seg s1" style="flex:${app}" title="App: ${fmt(app)} (${pa}%)"></span>` : ""}
      ${wa ? `<span class="seg s2" style="flex:${wa}" title="WhatsApp: ${fmt(wa)} (${pw}%)"></span>` : ""}
    </div>
    <ul class="legend">
      <li><span class="sw s1"></span><b>App</b><span>${fmt(app)} messages · ${pa}%</span></li>
      <li><span class="sw s2"></span><b>WhatsApp</b><span>${fmt(wa)} messages · ${pw}%</span></li>
    </ul>
    <p class="empty-note" style="text-align:left;padding:12px 0 0">${fmt(stats.totals.whatsapp)} ${stats.totals.whatsapp === 1 ? "person has" : "people have"} linked WhatsApp.</p>`;
}

// ---------- people table ----------
const COLS = [
  ["name", "Person"], ["joined", "Joined"], ["lastActive", "Last active"], ["activeDays", "Active days"],
  ["requests", "AI requests"], ["chats", "Chats"], ["sent", "Sent"], ["topFeature", "Uses most"], ["connected", "Connected"],
];
function renderPeople() {
  const val = (p, k) => (k === "connected" ? Number(p.gmail) + Number(p.whatsapp) : k === "name" ? (p.name || p.email).toLowerCase() : p[k] ?? "");
  const list = stats.people.slice().sort((a, b) => {
    const va = val(a, sortKey), vb = val(b, sortKey);
    return (va > vb ? 1 : va < vb ? -1 : 0) * sortDir;
  });
  const ago = (iso) => {
    if (!iso) return "—";
    const d = Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(iso)) / 864e5);
    return d <= 0 ? "Today" : d === 1 ? "Yesterday" : `${d} days ago`;
  };
  $("#people").innerHTML = `<thead><tr>${COLS.map(([k, label]) => `<th><button data-sort="${k}" aria-sort="${sortKey === k ? (sortDir > 0 ? "ascending" : "descending") : "none"}">${label}${sortKey === k ? (sortDir > 0 ? " ↑" : " ↓") : ""}</button></th>`).join("")}</tr></thead>
    <tbody>${list.map((p) => `<tr>
      <td><b>${esc(p.name || p.email.split("@")[0])}</b><small>${esc(p.email)}</small></td>
      <td>${new Date(p.joined).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
      <td>${ago(p.lastActive)}</td>
      <td class="num">${fmt(p.activeDays)}</td>
      <td class="num">${fmt(p.requests)}${p.requestsToday ? `<small>${fmt(p.requestsToday)} today</small>` : ""}</td>
      <td class="num">${fmt(p.chats)}</td>
      <td class="num">${fmt(p.sent)}</td>
      <td>${esc(p.topFeature || "—")}</td>
      <td>${p.gmail ? `<span class="tag">Gmail</span>` : ""}${p.whatsapp ? `<span class="tag">WhatsApp</span>` : ""}${!p.gmail && !p.whatsapp ? `<span class="muted">Demo only</span>` : ""}</td>
    </tr>`).join("")}</tbody>`;
}
$("#people").addEventListener("click", (e) => {
  const b = e.target.closest("[data-sort]"); if (!b) return;
  if (sortKey === b.dataset.sort) sortDir *= -1; else { sortKey = b.dataset.sort; sortDir = ["name", "topFeature"].includes(sortKey) ? 1 : -1; }
  renderPeople();
});

// ---------- AI services ----------
async function loadAi() {
  try {
    const r = await api("/api/admin/ai");
    $("#aiChain").innerHTML = r.providers.length ? r.providers.map((p) => `<li><span class="name">${esc(p.provider)}</span><span class="state">—</span></li>`).join("") : "<li>No AI service is set up.</li>";
  } catch {}
}
$("#aiCheck").addEventListener("click", async (e) => {
  const b = e.target; b.disabled = true; b.textContent = "Checking… (up to a minute)";
  try {
    const { results } = await api("/api/admin/ai/check", { method: "POST" });
    $("#aiChain").innerHTML = results.map((r) => `<li class="${r.ok ? "ok" : "bad"}"><span class="name">${esc(r.provider)}</span><span class="state">${r.ok
      ? `✓ working · ${(r.ms / 1000).toFixed(1)}s${r.toolCalling ? "" : " · didn't use the tool"}`
      : `✕ ${esc(r.error || "failed")}`}</span></li>`).join("");
  } catch (err) { flash(esc(err.message), "err"); }
  b.disabled = false; b.textContent = "Check them now";
});
loadAi();

// ================= TESTERS =================
let testers = [], filter = "pending";
const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const LABEL = { pending: "Waiting", approved: "Approved", declined: "Declined" };

function renderTesters() {
  const pending = testers.filter((t) => t.status === "pending").length;
  for (const id of ["#nPending", "#nPendingTop"]) { $(id).hidden = !pending; $(id).textContent = pending; }
  const list = filter === "all" ? testers : testers.filter((t) => t.status === filter);
  $("#list").innerHTML = list.length ? list.map((t) => `
    <article class="tester ${t.status}" data-id="${esc(t.id)}">
      <div class="who">
        <b>${esc(t.name || t.email.split("@")[0])}</b>
        <span class="email">${esc(t.email)} <button class="mini" data-copy="${esc(t.email)}" title="Copy email" aria-label="Copy ${esc(t.email)}"><svg width="13" height="13"><use href="#i-copy"/></svg></button></span>
        <small>Asked ${when(t.createdAt)}${t.decidedAt ? ` · ${LABEL[t.status].toLowerCase()} ${when(t.decidedAt)}` : ""}</small>
      </div>
      ${t.useCase ? `<p class="use">“${esc(t.useCase)}”</p>` : ""}
      <div class="actions">
        <span class="status">${LABEL[t.status] || esc(t.status)}</span>
        ${t.status !== "approved" ? `<button class="btn sm" data-act="approve">Approve</button>` : ""}
        ${t.status === "pending" ? `<button class="btn ghost sm" data-act="decline">Decline</button>` : ""}
        ${t.status === "approved" ? `<button class="btn ghost sm" data-act="decline">Remove access</button>` : ""}
        ${t.status !== "pending" ? `<button class="btn ghost sm" data-act="delete">Delete</button>` : ""}
      </div>
    </article>`).join("")
    : `<p class="none">${filter === "pending" ? "No one is waiting right now. Share your website's Help Us Test page to find testers." : "Nothing here yet."}</p>`;
}

function flash(html, kind = "ok") {
  const f = $("#flash"); f.className = `banner ${kind}`; f.innerHTML = html; f.hidden = false;
  f.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function loadTesters() {
  const r = await api("/api/admin/testers");
  testers = r.testers;
  if (r.googleConsole) $("#googleLink").href = r.googleConsole;
  renderTesters();
}

$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]"); if (!b) return;
  filter = b.dataset.filter;
  $$("[data-filter]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  renderTesters();
});

$("#list").addEventListener("click", async (e) => {
  const copy = e.target.closest("[data-copy]");
  if (copy) { await navigator.clipboard?.writeText(copy.dataset.copy).catch(() => {}); copy.classList.add("done"); setTimeout(() => copy.classList.remove("done"), 1200); return; }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const card = b.closest("[data-id]"), id = card.dataset.id, t = testers.find((x) => x.id === id);
  try {
    if (b.dataset.act === "approve") {
      b.disabled = true;
      const r = await api(`/api/admin/testers/${id}/approve`, { method: "POST" });
      flash(`<b>${esc(t.email)} can now log in to Thinq.</b> ${r.drafted ? "A welcome email is waiting in your <a class=\"link\" href=\"/app\">Approvals panel</a> — review and send it when you're ready." : "Connect your Gmail in Thinq to have welcome emails drafted for you next time."}<br>Don't forget to add them to Google's <a class="link" href="${esc($("#googleLink").href)}" target="_blank" rel="noopener">Test users</a> list <button class="mini" data-copy-flash="${esc(t.email)}">Copy email</button>`);
    } else if (b.dataset.act === "decline") {
      if (t.status === "approved" && !confirm(`Remove ${t.email}'s access? They'll be signed out of Thinq.`)) return;
      await api(`/api/admin/testers/${id}/decline`, { method: "POST" });
      flash(t.status === "approved" ? `${esc(t.email)} no longer has access.` : `Declined ${esc(t.email)}.`, "");
    } else if (b.dataset.act === "delete") {
      if (!confirm(`Delete ${t.email}'s request from the list?`)) return;
      await api(`/api/admin/testers/${id}`, { method: "DELETE" });
    }
    await loadTesters();
  } catch (err) {
    b.disabled = false;
    flash(esc(err.message), "err");
  }
});
$("#flash").addEventListener("click", async (e) => {
  const c = e.target.closest("[data-copy-flash]"); if (!c) return;
  await navigator.clipboard?.writeText(c.dataset.copyFlash).catch(() => {});
  c.textContent = "Copied";
});

// ---------------- start ----------------
showView(location.hash === "#testers" ? "testers" : "analytics");
loadStats();
loadTesters().catch((err) => flash(esc(err.message), "err"));
