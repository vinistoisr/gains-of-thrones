// Small server-rendered pages: sign-in, and the notice shown when the
// password secret was never set. Same look as the settings page.

const STYLE = `
@font-face{font-family:"Sora";src:url(/Sora.woff2) format("woff2");font-weight:100 800;font-display:swap}
@font-face{font-family:"DM Sans";src:url(/DMSans.woff2) format("woff2");font-weight:100 1000;font-display:swap}
:root{--page:#0c0d0f;--surface:#16171a;--ink:#f3f3f1;--muted:#9a9ca3;--border:#26282d;--accent:#d4f56a;--accent-ink:#0c0d0f;--crit:#ff6b6b;color-scheme:dark}
@media (prefers-color-scheme: light){:root{--page:#f4f4f1;--surface:#fff;--ink:#16171a;--muted:#6b6d74;--border:#e2e2dd;--accent:#4d7c0f;--accent-ink:#fff;--crit:#c62828;color-scheme:light}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--page);color:var(--ink);font:15px/1.5 "DM Sans",system-ui,sans-serif;padding:16px}
.card{width:100%;max-width:380px;background:var(--surface);border:1px solid var(--border);border-radius:18px;padding:24px}
h1{font:700 22px "Sora",system-ui,sans-serif;margin:0 0 6px}
p{color:var(--muted);margin:0 0 16px;font-size:14px}
code{font-size:13px}
input{width:100%;min-height:44px;padding:8px 12px;border-radius:10px;border:1px solid var(--border);background:var(--page);color:var(--ink);font:15px "DM Sans",system-ui,sans-serif;margin-bottom:12px}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{width:100%;min-height:44px;border-radius:999px;border:0;background:var(--accent);color:var(--accent-ink);font:700 14px "DM Sans",system-ui,sans-serif;cursor:pointer}
.err{color:var(--crit);font-size:14px;margin:0 0 12px}`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page(title, body, status = 200, headers = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="icon" href="/icon-192.png"><style>${STYLE}</style></head>
<body><main class="card">${body}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

/** Only same-site paths survive as a post-login destination. */
export function safeNext(next) {
  return typeof next === "string" && /^\/(?!\/)[\w\-./?=&%]*$/.test(next) ? next : "/";
}

export function loginPage({ next = "/", error = "", status = 200 } = {}) {
  return page("Sign in", `<h1>Health</h1><p>Enter the password set when this dashboard was deployed.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(safeNext(next))}">
<input type="password" name="password" placeholder="Password" autocomplete="current-password" required autofocus>
<button type="submit">Sign in</button>
</form>`, status);
}

export function noPasswordPage() {
  return page("Set a password", `<h1>Set a password first</h1>
<p>This dashboard has no password yet, so it shows nothing. In the Cloudflare dashboard open
Workers &amp; Pages, this Worker, Settings, Variables and Secrets, and add a secret named
<code>APP_PASSWORD</code>. Then reload this page.</p>`, 503);
}
