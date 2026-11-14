#!/usr/bin/env python3
"""Build the Thinq AI site.

Each page body lives in src/pages/<name>.html. Its first line is a JSON comment:
  <!--{"title": "...", "desc": "...", "active": "products", "chrome": "full"}-->
chrome: "full" (menu + footer), "minimal" (menu only), "none" (no menu or footer).
Optional "preload": an Unsplash photo id to start downloading early.

This script wraps every page in the shared <head>, menu, icon set and footer and
writes the result to thinq-site/<name>.html.  Run:  python3 build.py
"""
import json, pathlib, re

ROOT = pathlib.Path(__file__).parent
SRC, OUT = ROOT / "src" / "pages", ROOT / "thinq-site"

def U(pid, w):
    return f"https://images.unsplash.com/photo-{pid}?auto=format&fit=crop&w={w}&q=80"

ICONS = """
<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <symbol id="mark" viewBox="0 0 24 24"><g fill="currentColor">
    <circle cx="12" cy="3" r="2"/><circle cx="12" cy="21" r="2"/><circle cx="3" cy="12" r="2"/><circle cx="21" cy="12" r="2"/>
    <circle cx="5.6" cy="5.6" r="1.7"/><circle cx="18.4" cy="5.6" r="1.7"/><circle cx="5.6" cy="18.4" r="1.7"/><circle cx="18.4" cy="18.4" r="1.7"/>
    <circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="7.5" r="1.5"/><circle cx="12" cy="16.5" r="1.5"/><circle cx="7.5" cy="12" r="1.5"/><circle cx="16.5" cy="12" r="1.5"/>
  </g></symbol>
  <symbol id="chev" viewBox="0 0 10 10"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol>
  <symbol id="l1" viewBox="0 0 24 24"><path d="M13 2 5 13h6l-1 9 8-11h-6z" fill="currentColor"/></symbol>
  <symbol id="l2" viewBox="0 0 24 24"><path d="M2 16c3-8 6-8 10 0s7 8 10 0M2 16c3 8 6 8 10 0s7-8 10 0" fill="none" stroke="currentColor" stroke-width="2"/></symbol>
  <symbol id="l3" viewBox="0 0 24 24"><path d="M6 3h14l-2 4H6zM5 10h12l-2 4H5zM4 17h14l-2 4H4z" fill="currentColor"/></symbol>
  <symbol id="l4" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="currentColor"/></symbol>
  <symbol id="l5" viewBox="0 0 24 24"><path d="M3 20 12 4l9 16z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></symbol>
  <symbol id="l6" viewBox="0 0 24 24"><rect x="3" y="3" width="8" height="8" rx="2" fill="currentColor"/><rect x="13" y="13" width="8" height="8" rx="2" fill="currentColor"/><rect x="13" y="3" width="8" height="8" rx="4" fill="none" stroke="currentColor" stroke-width="2"/></symbol>
  <g fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
    <symbol id="i-cal" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol>
    <symbol id="i-spark" viewBox="0 0 16 16"><path d="M8 1.5c.5 3.4 3.1 6 6.5 6.5-3.4.5-6 3.1-6.5 6.5-.5-3.4-3.1-6-6.5-6.5 3.4-.5 6-3.1 6.5-6.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>
    <symbol id="i-chart" viewBox="0 0 16 16"><path d="M2 13.5h12M4 11V8M8 11V4.5M12 11V6.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol>
    <symbol id="i-inbox" viewBox="0 0 16 16"><path d="M2 9.5 3.8 3h8.4L14 9.5V13H2zM2 9.5h3.5l1 1.5h3l1-1.5H14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>
    <symbol id="i-plug" viewBox="0 0 16 16"><path d="M6 1.5v3M10 1.5v3M4 4.5h8v3a4 4 0 0 1-8 0zM8 11.5v3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
    <symbol id="i-shield" viewBox="0 0 16 16"><path d="M8 1.5 13.5 3.5v4c0 3.3-2.3 5.9-5.5 7-3.2-1.1-5.5-3.7-5.5-7v-4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="m5.8 8 1.6 1.6L10.5 6.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
    <symbol id="i-bolt" viewBox="0 0 16 16"><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>
    <symbol id="i-users" viewBox="0 0 16 16"><circle cx="6" cy="5.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.5 14c.4-2.6 2.2-4 4.5-4s4.1 1.4 4.5 4M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12 10.2c1.4.5 2.3 1.8 2.5 3.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol>
    <symbol id="i-book" viewBox="0 0 16 16"><path d="M2.5 3c2-.8 3.8-.6 5.5.8v10c-1.7-1.4-3.5-1.6-5.5-.8zM13.5 3c-2-.8-3.8-.6-5.5.8v10c1.7-1.4 3.5-1.6 5.5-.8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>
    <symbol id="i-chat" viewBox="0 0 16 16"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>
    <symbol id="i-play" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.6 5.6v4.8L10.5 8z" fill="currentColor"/></symbol>
    <symbol id="i-mail" viewBox="0 0 16 16"><rect x="2" y="3.5" width="12" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m2.5 4.5 5.5 4 5.5-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>
    <symbol id="i-pin" viewBox="0 0 16 16"><path d="M8 14.5s4.5-4.2 4.5-8a4.5 4.5 0 0 0-9 0c0 3.8 4.5 8 4.5 8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="8" cy="6.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/></symbol>
    <symbol id="i-lock" viewBox="0 0 16 16"><rect x="3" y="7" width="10" height="7.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.4"/></symbol>
    <symbol id="i-heart" viewBox="0 0 16 16"><path d="M8 13.5S2 10 2 6a3 3 0 0 1 6-1 3 3 0 0 1 6 1c0 4-6 7.5-6 7.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>
    <symbol id="i-compass" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m10.5 5.5-1.6 3.4-3.4 1.6 1.6-3.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></symbol>
    <symbol id="i-refresh" viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></symbol>
    <symbol id="i-target" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r=".8" fill="currentColor"/></symbol>
    <symbol id="i-megaphone" viewBox="0 0 16 16"><path d="M2 6.5v3h2.5L11 13V3L4.5 6.5zM4.5 9.5l1 4h2l-1-3.3M13 6.3v3.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></symbol>
    <symbol id="i-rocket" viewBox="0 0 16 16"><path d="M14 2c-4 0-7 2.5-8.5 6.5l2 2C11.5 9 14 6 14 2zM5.5 8.5 3 8l2-3h3M7.5 10.5 8 13l3-2V8M4.5 11.5 2 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></symbol>
    <symbol id="i-user" viewBox="0 0 16 16"><circle cx="8" cy="5.5" r="2.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 14.5c.6-3 2.7-4.5 5.5-4.5s4.9 1.5 5.5 4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></symbol>
    <symbol id="i-doc" viewBox="0 0 16 16"><path d="M4 1.5h5.5L12.5 4.5v10H4zM9.5 1.5v3h3M6 8h4.5M6 10.5h4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></symbol>
    <symbol id="i-globe" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.8 8h12.4M8 1.8c1.8 1.9 2.6 4 2.6 6.2S9.8 12.3 8 14.2C6.2 12.3 5.4 10.2 5.4 8S6.2 3.7 8 1.8z" fill="none" stroke="currentColor" stroke-width="1.4"/></symbol>
  </g>
</svg>"""

def icon(name, cls="ico"):
    return f'<span class="{cls}"><svg><use href="#{name}"/></svg></span>'

PRODUCT_MENU = [
    ("products.html#features", "i-spark", "Features", "Everything Thinq can do for you"),
    ("products.html#integrations", "i-plug", "Integrations", "Works with the tools you already use"),
    ("pricing.html", "i-target", "Pricing", "Free to start, simple plans as you grow"),
    ("resources.html#updates", "i-refresh", "What's new", "The latest releases and improvements"),
]
USECASE_MENU = [
    ("use-cases.html#ops", "i-cal", "Operations", "Keep projects and handoffs moving"),
    ("use-cases.html#sales", "i-chart", "Sales", "Follow up on every lead, on time"),
    ("use-cases.html#marketing", "i-megaphone", "Marketing", "Plan, draft and report on campaigns"),
    ("use-cases.html#founders", "i-rocket", "Founders", "Run the business, not your inbox"),
]

def dropdown(label, items, key, active):
    cur = ' data-current' if key == active else ''
    links = "".join(
        f'<a href="{h}" role="menuitem">{icon(i)}<span><b>{t}</b><small>{d}</small></span></a>'
        for h, i, t, d in items)
    return (f'<div class="dd"><button class="dd-btn" aria-expanded="false" aria-haspopup="true"{cur}>{label} '
            f'<svg class="chev"><use href="#chev"/></svg></button>'
            f'<div class="dd-menu glass" role="menu">{links}</div></div>')

def nav(active):
    def a(href, label, key):
        cur = ' aria-current="page"' if key == active else ''
        return f'<a href="{href}"{cur}>{label}</a>'
    msub = lambda items: '<div class="sub">' + "".join(f'<a href="{h}">{t}</a>' for h, _, t, _ in items) + '</div>'
    return f"""
<nav class="top" aria-label="Main">
  <div class="wrap">
    <a href="index.html" class="logo" aria-label="Thinq AI home"><svg><use href="#mark"/></svg>Thinq AI</a>
    <div class="links">
      {dropdown("Products", PRODUCT_MENU, "products", active)}
      {dropdown("Use Cases", USECASE_MENU, "use-cases", active)}
      {a("company.html", "Company", "company")}
      {a("resources.html", "Resources", "resources")}
    </div>
    <div class="nav-right">
      <a href="login.html" class="login">Login</a>
      <a href="login.html#signup" class="btn sm">Get started free</a>
      <button class="burger" aria-label="Open menu" aria-expanded="false" aria-controls="mnav"><span></span></button>
    </div>
  </div>
</nav>
<div class="mnav" id="mnav">
  <a href="products.html">Products</a>{msub(PRODUCT_MENU)}
  <a href="use-cases.html">Use Cases</a>{msub(USECASE_MENU)}
  <a href="company.html">Company</a>
  <a href="resources.html">Resources</a>
  <a href="pricing.html">Pricing</a>
  <div class="btns"><a href="login.html" class="btn ghost">Login</a><a href="login.html#signup" class="btn">Get started free</a></div>
</div>"""

FOOTER = """
<footer class="site">
  <div class="wrap">
    <div class="foot">
      <div class="brand">
        <a href="index.html" class="logo"><svg><use href="#mark"/></svg>Thinq AI</a>
        <div class="sub-title">Subscribe</div>
        <p class="sub-copy">Join our newsletter to stay up to date on features and releases.</p>
        <form class="subscribe">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.5 4.5 5.5 4 5.5-4"/></svg>
          <input type="email" placeholder="Enter your email" aria-label="Email address" required>
          <button class="btn sm" type="submit">Subscribe</button>
        </form>
        <p class="fine">By subscribing you agree to our <a href="legal.html#privacy">Privacy Policy</a>.</p>
      </div>
      <div><h4>Quick Links</h4><ul><li><a href="index.html">Home</a></li><li><a href="company.html">About</a></li><li><a href="use-cases.html">Services</a></li><li><a href="contact.html">Contact</a></li><li><a href="testers.html">Become a Tester</a></li></ul></div>
      <div><h4>Product</h4><ul><li><a href="products.html#features">Features</a></li><li><a href="products.html#integrations">Integrations</a></li><li><a href="pricing.html">Pricing</a></li><li><a href="resources.html#updates">Updates</a></li></ul></div>
      <div><h4>Resources</h4><ul><li><a href="resources.html#help">Help Center</a></li><li><a href="resources.html#docs">Documentation</a></li><li><a href="resources.html#community">Community</a></li><li><a href="resources.html#tutorials">Tutorials</a></li></ul></div>
    </div>
    <div class="legal-bar">
      <span>© 2026 Thinq AI. All rights reserved. Photography from <a href="https://unsplash.com/?utm_source=thinq&amp;utm_medium=referral" class="link">Unsplash</a>.</span>
      <nav aria-label="Legal"><a href="legal.html#terms">Terms of Service</a><a href="legal.html#privacy">Privacy Policy</a><a href="legal.html#compliance">Compliance</a></nav>
    </div>
  </div>
  <div class="wordmark" aria-hidden="true">Thinq</div>
</footer>"""

def page(meta, body):
    preload = ""
    if meta.get("preload"):
        p = meta["preload"]
        srcset = ", ".join(f"{U(p, w)} {w}w" for w in (900, 1600, 2400))
        preload = (f'<link rel="preload" as="image" href="{U(p, 1600)}" imagesrcset="{srcset}" '
                   f'imagesizes="(max-width: 1100px) 100vw, 1040px" fetchpriority="high">\n')
    chrome = meta.get("chrome", "full")
    title = meta["title"] if meta.get("exact_title") else f'{meta["title"]} — Thinq AI'
    head = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{meta['desc']}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{meta['desc']}">
<meta name="theme-color" content="#ffffff">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cg fill='%230b0b0c'%3E%3Ccircle cx='12' cy='3' r='2'/%3E%3Ccircle cx='12' cy='21' r='2'/%3E%3Ccircle cx='3' cy='12' r='2'/%3E%3Ccircle cx='21' cy='12' r='2'/%3E%3Ccircle cx='12' cy='12' r='3.2'/%3E%3Ccircle cx='5.6' cy='5.6' r='1.7'/%3E%3Ccircle cx='18.4' cy='5.6' r='1.7'/%3E%3Ccircle cx='5.6' cy='18.4' r='1.7'/%3E%3Ccircle cx='18.4' cy='18.4' r='1.7'/%3E%3C/g%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://images.unsplash.com">
{preload}<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300..600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/styles.css">
</head>
<body>
{ICONS}"""
    parts = [head]
    if chrome in ("full", "minimal"):
        parts.append(nav(meta.get("active", "")))
    parts.append(f"<main>\n{body}\n</main>")
    if chrome == "full":
        parts.append(FOOTER)
    parts.append('<script src="assets/site.js" defer></script>\n</body>\n</html>\n')
    return "\n".join(parts)

def main():
    for src in sorted(SRC.glob("*.html")):
        text = src.read_text()
        m = re.match(r"\s*<!--(\{.*?\})-->\s*\n", text, re.S)
        if not m:
            raise SystemExit(f"{src.name}: first line must be a <!--{{json}}--> header")
        meta, body = json.loads(m.group(1)), text[m.end():]
        body = re.sub(r"\{\{icon:([\w-]+)(?::([\w ]+))?\}\}", lambda x: icon(x.group(1), x.group(2) or "ico"), body)
        html = page(meta, body.strip())
        # Root-relative links and assets, so pages (and the 404) work at any URL depth.
        html = re.sub(r'(href|src)="(?!https?:|mailto:|#|/|data:)([\w-]+\.html|assets/)', r'\1="/\2', html)
        (OUT / src.name).write_text(html)
        print("built", src.name)

if __name__ == "__main__":
    main()
