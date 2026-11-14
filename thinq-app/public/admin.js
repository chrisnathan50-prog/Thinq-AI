// Admin page: review the website's tester requests.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let testers = [], filter = "pending";

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 401) { location.href = "/login.html"; throw new Error("Please sign in again."); }
  if (res.status === 403) { location.href = "/app"; throw new Error("Admins only."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const when = (iso) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const LABEL = { pending: "Waiting", approved: "Approved", declined: "Declined" };

function render() {
  const pending = testers.filter((t) => t.status === "pending").length;
  $("#nPending").hidden = !pending; $("#nPending").textContent = pending;
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

async function load() {
  const r = await api("/api/admin/testers");
  testers = r.testers;
  if (r.googleConsole) $("#googleLink").href = r.googleConsole;
  render();
}

$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]"); if (!b) return;
  filter = b.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  render();
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
    await load();
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

load().catch((err) => flash(esc(err.message), "err"));
