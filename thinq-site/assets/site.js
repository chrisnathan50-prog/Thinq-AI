/* =========================================================
   Thinq AI — shared behaviour. Every block checks that its
   elements exist, so one file serves every page.
   ========================================================= */
(() => {
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const U = (id, w, extra = "") => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=80${extra}`;

/* ---------- Photos: tiny blurred placeholder, then fade in the sharp image ---------- */
$$("[data-photo]").forEach(el => {
  const id = el.dataset.photo;
  el.style.backgroundImage = `url("${U(id, 48, "&blur=40")}")`;
  const img = new Image();
  img.className = "bg"; img.alt = ""; img.decoding = "async";
  if (el.hasAttribute("data-eager")) img.fetchPriority = "high"; else img.loading = "lazy";
  img.sizes = el.dataset.sizes || (el.hasAttribute("data-full") ? "100vw" : "(max-width: 1100px) 100vw, 1040px");
  img.srcset = [600, 900, 1200, 1600, 2400].map(w => `${U(id, w)} ${w}w`).join(", ");
  img.src = U(id, 1600);
  const done = () => img.classList.add("loaded");
  img.addEventListener("load", done, { once: true });
  el.prepend(img);
  if (img.complete && img.naturalWidth) done();
});

/* ---------- Nav: hairline once scrolled, dropdowns, mobile menu ---------- */
const nav = $("nav.top");
const heroImg = $(".hero-shot .bg");
let ticking = false;
function onScroll() {
  nav && nav.classList.toggle("scrolled", scrollY > 8);
  if (!reduce && heroImg && heroImg.classList.contains("loaded")) {
    const r = heroImg.parentElement.getBoundingClientRect();
    const p = Math.min(Math.max(1 - (r.bottom / (innerHeight + r.height)), 0), 1);
    heroImg.style.transform = `scale(${1.08 - p * 0.08}) translateY(${p * 18}px)`;
  }
  ticking = false;
}
addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
heroImg && heroImg.addEventListener("load", () => { heroImg.style.transition = "opacity .9s var(--ease)"; onScroll(); });
onScroll();

const dds = $$(".dd");
const closeAll = except => dds.forEach(d => { if (d !== except) { d.classList.remove("open"); $(".dd-btn", d).setAttribute("aria-expanded", "false"); } });
dds.forEach(dd => {
  const btn = $(".dd-btn", dd);
  let t;
  const open = () => { clearTimeout(t); closeAll(dd); dd.classList.add("open"); btn.setAttribute("aria-expanded", "true"); };
  const close = () => { t = setTimeout(() => { dd.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); }, 120); };
  if (matchMedia("(hover: hover)").matches) { dd.addEventListener("mouseenter", open); dd.addEventListener("mouseleave", close); }
  btn.addEventListener("click", () => dd.classList.contains("open") ? (dd.classList.remove("open"), btn.setAttribute("aria-expanded", "false")) : open());
  dd.addEventListener("focusout", e => { if (!dd.contains(e.relatedTarget)) close(); });
});
document.addEventListener("click", e => { if (!e.target.closest(".dd")) closeAll(); });
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  const openDd = $(".dd.open"); closeAll();
  openDd && $(".dd-btn", openDd).focus();
  if (document.body.classList.contains("menu-open")) toggleMenu(false);
});

const burger = $(".burger");
function toggleMenu(force) {
  const on = force ?? !document.body.classList.contains("menu-open");
  document.body.classList.toggle("menu-open", on);
  burger.setAttribute("aria-expanded", on);
  burger.setAttribute("aria-label", on ? "Close menu" : "Open menu");
}
burger && burger.addEventListener("click", () => toggleMenu());
$$(".mnav a").forEach(a => a.addEventListener("click", () => toggleMenu(false)));

/* ---------- Homepage: typing prompt + tabs ---------- */
const typed = $("#typed");
if (typed) {
  let timer;
  const typeText = t => {
    clearInterval(timer);
    if (reduce) { typed.textContent = t; return; }
    typed.textContent = ""; let i = 0;
    timer = setInterval(() => { typed.textContent = t.slice(0, ++i); if (i >= t.length) clearInterval(timer); }, 32);
  };
  const tabs = $$(".hero [role='tab']");
  tabs.forEach(b => b.addEventListener("click", () => { tabs.forEach(t => t.setAttribute("aria-selected", t === b)); typeText(b.dataset.prompt); }));
  setTimeout(() => typeText(tabs[0].dataset.prompt), 700);
}

/* ---------- Homepage: workspace setup steps ---------- */
const steps = $$("#steps li");
if (steps.length) {
  let idx = 1;
  const render = () => {
    steps.forEach((li, i) => { li.className = i < idx ? "done" : i === idx ? "active" : ""; $(".dot", li).textContent = i < idx ? "✓" : i + 1; });
    const pct = Math.round(idx / steps.length * 100);
    $("#bar").style.width = pct + "%"; $("#pct").textContent = pct + "%";
  };
  steps.forEach((li, i) => { li.style.cursor = "pointer"; li.addEventListener("click", () => { idx = Math.min(i + 1, steps.length); render(); }); });
  render();
}

/* ---------- Homepage: live counter ---------- */
const countEl = $("#count");
if (countEl) {
  const target = 26900789, fmt = n => n.toLocaleString("en-US");
  new IntersectionObserver((entries, obs) => {
    if (!entries[0].isIntersecting) return; obs.disconnect();
    if (reduce) return;
    const start = performance.now(), from = target - 480000, dur = 1800;
    (function step(now) {
      const k = Math.min((now - start) / dur, 1), e = 1 - Math.pow(1 - k, 3);
      countEl.textContent = fmt(Math.round(from + (target - from) * e));
      if (k < 1) requestAnimationFrame(step);
      else { let v = target; setInterval(() => { v += Math.ceil(Math.random() * 3); countEl.textContent = fmt(v); }, 1400); }
    })(start);
  }, { threshold: .5 }).observe(countEl);
}

/* ---------- Use cases: team filter (also reads #ops etc. from the URL) ---------- */
const filterBtns = $$("[data-filter]");
if (filterBtns.length) {
  const cases = $$(".case");
  const apply = key => {
    filterBtns.forEach(b => b.setAttribute("aria-selected", b.dataset.filter === key));
    cases.forEach(c => { c.hidden = key !== "all" && c.dataset.team !== key; });
  };
  filterBtns.forEach(b => b.addEventListener("click", () => { apply(b.dataset.filter); history.replaceState(null, "", b.dataset.filter === "all" ? location.pathname : "#" + b.dataset.filter); }));
  const fromHash = () => { const h = location.hash.slice(1); if (filterBtns.some(b => b.dataset.filter === h)) apply(h); };
  addEventListener("hashchange", fromHash); fromHash();
}

/* ---------- Pricing: monthly / yearly ---------- */
const billing = $$("[data-billing]");
if (billing.length) {
  const set = mode => {
    billing.forEach(b => b.setAttribute("aria-pressed", b.dataset.billing === mode));
    $$("[data-monthly]").forEach(el => { el.textContent = mode === "yearly" ? el.dataset.yearly : el.dataset.monthly; });
    $$("[data-per-monthly]").forEach(el => { el.textContent = mode === "yearly" ? el.dataset.perYearly : el.dataset.perMonthly; });
  };
  billing.forEach(b => b.addEventListener("click", () => set(b.dataset.billing)));
}

/* ---------- Demo forms: show a confirmation instead of sending anywhere ---------- */
$$("form[data-demo]").forEach(form => form.addEventListener("submit", e => {
  e.preventDefault();
  const note = $(".form-note", form);
  if (note) { note.hidden = false; note.focus?.(); }
  const btn = $("button[type=submit]", form);
  if (btn && btn.dataset.done) btn.textContent = btn.dataset.done;
  form.reset?.();
}));

/* ---------- Auth: sign in / create account ---------- */
const auth = $("[data-mode]");
if (auth) {
  const setMode = m => {
    auth.dataset.mode = m;
    $$("[data-set-mode]").forEach(b => b.setAttribute("aria-selected", b.dataset.setMode === m));
    document.title = (m === "signup" ? "Create your account" : "Log in") + " — Thinq AI";
  };
  $$("[data-set-mode]").forEach(b => b.addEventListener("click", e => { e.preventDefault(); setMode(b.dataset.setMode); history.replaceState(null, "", b.dataset.setMode === "signup" ? "#signup" : location.pathname); }));
  setMode(location.hash === "#signup" ? "signup" : "signin");
}

/* ---------- Legal: highlight the section in view ---------- */
const tocLinks = $$(".toc a");
if (tocLinks.length) {
  const map = new Map(tocLinks.map(a => [a.getAttribute("href").slice(1), a]));
  const io = new IntersectionObserver(entries => entries.forEach(en => {
    if (!en.isIntersecting) return;
    tocLinks.forEach(a => a.classList.remove("on"));
    map.get(en.target.id)?.classList.add("on");
  }), { rootMargin: "-30% 0px -60% 0px" });
  map.forEach((_, id) => { const s = document.getElementById(id); s && io.observe(s); });
}

/* ---------- Footer newsletter ---------- */
$$(".subscribe").forEach(f => f.addEventListener("submit", e => { e.preventDefault(); $("button", f).textContent = "Subscribed"; f.reset(); }));
})();

/* ---------- Live sign-in: login page messages + "Open Thinq" in the menu when signed in ---------- */
(() => {
  const alertEl = document.getElementById("authAlert");
  const err = new URLSearchParams(location.search).get("error");
  if (alertEl && err) {
    const msgs = {
      not_invited: ["err", "Thinq is invite-only for now, and this Google account isn't on the list yet. Ask us for an invite, or try another account."],
      not_configured: ["", "Sign-in isn't set up on this server yet."],
      access_denied: ["", "Sign-in was cancelled. You can try again whenever you're ready."],
      expired: ["", "That sign-in took too long. Please try again."],
      unverified: ["err", "Please verify your Google account's email address first, then try again."],
      failed: ["err", "Something went wrong signing in with Google. Please try again."],
    };
    const [cls, text] = msgs[err] || msgs.failed;
    alertEl.className = `auth-alert ${cls}`; alertEl.textContent = text; alertEl.hidden = false;
    history.replaceState(null, "", location.pathname + location.hash);
  }

  // Only works when the site is served by the Thinq server (it fails quietly on a plain static host).
  fetch("/api/session", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((s) => {
    if (!s?.signedIn) return;
    document.querySelectorAll('a[href="/login.html"].login, .mnav .btns a[href="/login.html"]').forEach((a) => { a.hidden = true; });
    document.querySelectorAll('a[href="/login.html#signup"]').forEach((a) => {
      a.href = "/app";
      if (a.closest(".nav-right") || a.closest(".mnav")) { a.textContent = "Open Thinq"; a.classList.add("app-open"); }
    });
  }).catch(() => {});
})();
