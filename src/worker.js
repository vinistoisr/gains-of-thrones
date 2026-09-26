/**
 * The Worker: serves the dashboard from R2, runs the refresh pipeline and
 * sends the daily Web Push brief.
 *
 * The pipeline (src/pipeline/refresh.js) runs inside this Worker: on the cron
 * slots in REFRESH_SLOTS and on POST /refresh it fetches Ultrahuman and the
 * workout log (Liftoff or Hevy), writes dashboard.html, brief.json and
 * status.json to the bucket, and this Worker serves them. People, credentials
 * and the time zone come from the settings page (config.js, settings.js).
 *
 * Sign-in (auth.js): a password with a session cookie by default, or
 * Cloudflare Access when ACCESS_TEAM and ACCESS_AUD are set. Static files
 * (icons, fonts, the 3D model) are Workers static assets from public/ and hold
 * no personal data; everything else goes through identify().
 *
 * Push: RFC 8291 (aes128gcm) + RFC 8292 (VAPID) with WebCrypto only. The cron
 * trigger (every 15 min) sends the morning push at 07:00 local time when brief.json
 * carries one (a rule fired in pipeline/brief.js; most days it is null) and the
 * bedtime nudge at the minute brief.json asks for, at most PUSH_CAP notifications
 * per person in any CAP_DAYS days (pipeline/pushlog.js, state/push-log.json).
 */

import { runRefresh } from "./pipeline/refresh.js";
import { maySend, recordSend, recordOpened } from "./pipeline/pushlog.js";
import { localParts, setTimeZone } from "./pipeline/util.js";
import { authMode, identify, tryPassword, makeSession, sessionCookie } from "./auth.js";
import { loadSettings, rememberOrigin, vapidKeys, vapidSubject } from "./config.js";
import { settingsApi } from "./settings.js";
import { loginPage, noPasswordPage, safeNext } from "./pages.js";
import SETTINGS_HTML from "./settings.html";

const MORNING_MIN = 7 * 60;          // 07:00 local
const WINDOW_MIN = 90;               // send if within this many minutes after the target (cron may lag)
const te = new TextEncoder();

// ---------------------------------------------------------------- helpers
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function b64uDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function b64uEncode(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...arrs) {
  const n = arrs.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

async function sha256hex(s) {
  const h = await crypto.subtle.digest("SHA-256", te.encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getJSON(env, key) {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  try { return await obj.json(); } catch { return null; }
}
const putJSON = (env, key, obj) => env.BUCKET.put(key, JSON.stringify(obj), { httpMetadata: { contentType: "application/json" } });
const PUSH_LOG = "state/push-log.json";

/** Local date and minutes since midnight in the deployment's time zone (setTimeZone first). */
function localNow() {
  const p = localParts(Date.now());
  return { date: p.date, minutes: p.h * 60 + p.min };
}

/** Access mode: the person a login email belongs to (EMAIL_USERS var). */
function userFor(email, env) {
  if (!email) return null;
  try {
    const map = JSON.parse(env.EMAIL_USERS || "{}");
    return map[email.toLowerCase()] || null;
  } catch { return null; }
}

/** The person a request acts for: the login email's, else `asked` if it is a configured person, else the first one. */
function personFor(who, env, settings, asked) {
  const ids = settings.people.map((p) => p.id);
  const mapped = userFor(who.email, env);
  if (mapped) return mapped;
  if (asked && ids.includes(asked)) return asked;
  return ids[0] || null;
}

function wantsHtml(req) {
  return req.method === "GET" && (req.headers.get("Accept") || "").includes("text/html");
}

function htmlPage(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

// ---------------------------------------------------------------- Web Push
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

/** RFC 8291 aes128gcm content encryption of `plaintext` for one subscription. */
async function encryptForSubscription(sub, plaintext) {
  const uaPub = b64uDecode(sub.keys.p256dh);      // 65-byte uncompressed P-256 point
  const auth = b64uDecode(sub.keys.auth);          // 16-byte auth secret
  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const padded = concat(te.encode(plaintext), new Uint8Array([2]));   // 0x02 = last record delimiter
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));
  const rs = new Uint8Array([0, 0, 0x10, 0]);                            // record size 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

/** RFC 8292 VAPID Authorization header for the push service at `endpoint`. */
async function vapidAuth(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const [{ publicKey, privateJwk }, settings] = await Promise.all([vapidKeys(env), loadSettings(env)]);
  const header = b64uEncode(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = b64uEncode(te.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapidSubject(env, settings),
  })));
  const key = await crypto.subtle.importKey("jwk", privateJwk,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${header}.${payload}`));
  return `vapid t=${header}.${payload}.${b64uEncode(sig)}, k=${publicKey}`;
}

async function sendPush(env, sub, data, subKey) {
  const body = await encryptForSubscription(sub, JSON.stringify(data));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(sub.endpoint, env),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "43200",
      Urgency: data.urgency || "normal",
    },
    body,
  });
  if ((res.status === 404 || res.status === 410) && subKey) await env.BUCKET.delete(subKey);   // subscription gone
  return res.status;
}

async function listSubs(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.BUCKET.list({ prefix: "push/subs/", cursor });
    for (const o of page.objects) {
      const s = await getJSON(env, o.key);
      if (s && s.endpoint) out.push({ key: o.key, sub: s });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function sendBriefs(env, kind, force = false) {
  const brief = await getJSON(env, "brief.json");
  if (!brief || !brief.users) return { sent: 0, reason: "no brief" };
  const { date, minutes } = localNow();
  // brief.generated is a local stamp (util.js localStamp); if no refresh has
  // run today, say so instead of presenting yesterday's numbers as this morning's
  const gen = String(brief.generated || "").slice(0, 10);
  const stale = gen && gen < date;
  const subs = await listSubs(env);
  let log = (await getJSON(env, PUSH_LOG)) || {};
  let logDirty = false;
  const allowed = {};   // uid -> cap decision, made once per run so every device a person has gets the same answer
  let sent = 0, skipped = 0, capped = 0;
  for (const { key, sub } of subs) {
    const u = brief.users[sub.user];
    if (!u || !u.push) { skipped++; continue; }
    let msg = u.push[kind];
    if (stale && kind === "morning") {
      // the pipeline did not run today: that is worth a push even on a day no rule fired
      msg = { title: `No fresh data (last brief ${gen})`, body: `No fresh data since ${gen}. Open the dashboard and press Refresh now.`, tag: "morning-stale" };
    } else if (stale && msg) {
      msg = { ...msg, body: `${msg.body} (data through ${gen})`.slice(0, 240) };
    }
    if (!msg) { skipped++; continue; }      // no rule fired (morning) or the bedtime habit is holding (evening)
    const at = kind === "morning" ? MORNING_MIN : (msg.atMinutes ?? 22 * 60);
    if (!force && !(minutes >= at && minutes < at + WINDOW_MIN)) { skipped++; continue; }
    const marker = `push/sent/${date}-${kind}-${sub.user}-${key.slice(-20)}`;
    if (!force && await env.BUCKET.head(marker)) { skipped++; continue; }
    if (!force) {
      allowed[sub.user] ??= maySend(log, sub.user, Date.now());
      if (!allowed[sub.user]) { skipped++; capped++; continue; }
    }
    const status = await sendPush(env, sub, { title: msg.title, body: msg.body, tag: msg.tag || kind, url: "/" }, key);
    if (status >= 200 && status < 300) {
      sent++;
      await env.BUCKET.put(marker, String(status), { httpMetadata: { contentType: "text/plain" } });
      log = recordSend(log, sub.user, { kind, tag: msg.tag || kind, nid: `${date}-${kind}` });
      logDirty = true;
    }
  }
  if (logDirty) await putJSON(env, PUSH_LOG, log);
  return { sent, skipped, capped, date, minutes };
}

// ---------------------------------------------------------------- refresh scheduling
// The pipeline runs in this Worker (see pipeline/refresh.js). Cron slots below
// are local minutes; WINDOW_MIN catches a late or skipped cron tick.
const REFRESH_SLOTS = [6 * 60 + 20, 12 * 60 + 20, 18 * 60 + 20, 0 * 60 + 20];

async function scheduledRefresh(env) {
  const { date, minutes } = localNow();
  for (const slot of REFRESH_SLOTS) {
    if (!(minutes >= slot && minutes < slot + WINDOW_MIN)) continue;
    const marker = `state/refresh-${date}-${String(slot).padStart(4, "0")}`;
    if (await env.BUCKET.head(marker)) continue;
    await env.BUCKET.put(marker, "1");
    return runRefresh(env, { reason: `cron slot ${slot}` });
  }
  if (await env.BUCKET.head("refresh.flag")) {
    const st = await getJSON(env, "status.json");
    if (!(st && st.running && Date.now() / 1000 - (st.startedAt || 0) < 600)) {
      return runRefresh(env, { reason: "refresh.flag" });
    }
  }
  return null;
}

// ---------------------------------------------------------------- handlers
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // state changes only from this site's own pages
    const origin = req.headers.get("Origin");
    if (req.method !== "GET" && req.method !== "HEAD" && origin && origin !== url.origin) {
      return new Response("Cross-site request refused", { status: 403 });
    }

    // ---- password sign-in (the default mode; Access mode never sees these routes)
    if (authMode(env) === "password") {
      if (!env.APP_PASSWORD) return noPasswordPage();
      if (url.pathname === "/login") {
        if (req.method === "GET") return loginPage({ next: url.searchParams.get("next") || "/" });
        if (req.method === "POST") {
          let form;
          try { form = await req.formData(); } catch { form = new FormData(); }
          const next = safeNext(form.get("next"));
          const result = await tryPassword(env, req, String(form.get("password") || ""));
          if (result === "throttled") return loginPage({ next, error: "Too many attempts. Wait 15 minutes and try again.", status: 429 });
          if (result !== "ok") return loginPage({ next, error: "Wrong password.", status: 401 });
          return new Response(null, { status: 303, headers: {
            Location: next, "Set-Cookie": sessionCookie(await makeSession(env), url.protocol === "https:"), "Cache-Control": "no-store" } });
        }
      }
      if (url.pathname === "/logout") {
        return new Response(null, { status: 303, headers: { Location: "/login", "Set-Cookie": sessionCookie("", url.protocol === "https:") } });
      }
    }

    let who;
    try {
      who = await identify(req, env);
    } catch (e) {
      return new Response("Access verification unavailable", { status: 503 });
    }
    if (!who) {
      if (authMode(env) === "password") {
        if (wantsHtml(req)) return new Response(null, { status: 303, headers: { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` } });
        return json({ error: "sign in first" }, 401);
      }
      return new Response("Forbidden", { status: 403 });
    }
    // an API token or a non-admin Access service token only reads the coach snapshot and the status
    if (who.limited && !(req.method === "GET" && (url.pathname === "/coach" || url.pathname === "/status"))) {
      return new Response("Forbidden", { status: 403 });
    }

    const settings = await loadSettings(env);
    setTimeZone(settings.tz);
    if (who.admin && url.protocol === "https:" && settings.origin !== url.origin) ctx.waitUntil(rememberOrigin(env, url.origin).catch(() => {}));

    if (req.method === "GET" && url.pathname === "/settings") return htmlPage(SETTINGS_HTML);
    if (url.pathname.startsWith("/api/")) {
      const res = await settingsApi(req, env, url);
      if (res) return res;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard.html")) {
      const obj = await env.BUCKET.get("dashboard.html");
      if (!obj) {
        if (!settings.people.length) return new Response(null, { status: 303, headers: { Location: "/settings" } });
        return htmlPage(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Health</title>
<body style="font:16px system-ui,sans-serif;background:#0c0d0f;color:#f3f3f1;padding:24px;max-width:560px;margin:auto">
<h1 style="font-size:22px">Not built yet</h1><p>The dashboard appears after the first refresh finishes. Start one, or check for errors, on the
<a style="color:#d4f56a" href="/settings">settings page</a>.</p></body>`, 503);
      }
      return new Response(obj.body, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, private",
          "Last-Modified": obj.uploaded.toUTCString(),
          "X-Robots-Tag": "noindex",
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      const [st, flag] = await Promise.all([env.BUCKET.get("status.json"), env.BUCKET.head("refresh.flag")]);
      let s = { last: 0, running: false };
      if (st) { try { s = await st.json(); } catch {} }
      if (flag) s.running = true;
      s.queued = !!flag;
      return json(s);
    }

    // the coach snapshot (pipeline/coach.js): ?user=<uid>, else the caller's own, else the first user
    if (req.method === "GET" && url.pathname === "/coach") {
      const uid = url.searchParams.get("user") || personFor(who, env, settings, null);
      if (!uid) return new Response("No people set up yet.", { status: 404 });
      if (!/^[a-z0-9_-]{1,32}$/.test(uid)) return new Response("Bad user", { status: 400 });
      const obj = await env.BUCKET.get(`coach/${uid}.md`);
      if (!obj) return new Response("No snapshot yet. The next refresh writes it.", { status: 404 });
      return new Response(obj.body, {
        headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store", "Last-Modified": obj.uploaded.toUTCString() },
      });
    }

    if (req.method === "GET" && url.pathname === "/brief") {
      const brief = await getJSON(env, "brief.json");
      return json(brief || {});
    }

    if (req.method === "POST" && url.pathname === "/refresh") {
      const st = await getJSON(env, "status.json");
      if (st && st.running && Date.now() / 1000 - (st.startedAt || 0) < 600) return json({ started: false, running: true });
      await env.BUCKET.put("refresh.flag", JSON.stringify({ at: Date.now() / 1000, by: who.email || null }),
        { httpMetadata: { contentType: "application/json" } });
      ctx.waitUntil(runRefresh(env, { reason: `refresh by ${who.email || "signed-in user"}` }));
      return json({ started: true, running: true });
    }
    // admin: full rebuild of ring.json from raw files, or force the weekly narrative
    if (req.method === "POST" && url.pathname === "/admin/rebuild") {
      const summary = await runRefresh(env, { reason: "admin rebuild", full: true, narrative: url.searchParams.get("narrative") || "auto" });
      return json(summary);
    }
    if (req.method === "POST" && url.pathname === "/admin/narrative") {
      const summary = await runRefresh(env, { reason: "admin narrative", narrative: "force" });
      return json(summary);
    }
    if (req.method === "GET" && url.pathname === "/admin/last-refresh") {
      return json((await getJSON(env, "state/last-refresh.json")) || {});
    }

    // ---- push subscriptions (one per browser/device)
    if (req.method === "POST" && url.pathname === "/push/subscribe") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const sub = body && body.subscription;
      if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ error: "bad subscription" }, 400);
      const user = personFor(who, env, settings, body.user);
      if (!user) return json({ error: "no person set up yet" }, 403);
      const key = `push/subs/${await sha256hex(sub.endpoint)}.json`;
      const rec = { endpoint: sub.endpoint, keys: sub.keys, user, email: who.email, ua: req.headers.get("User-Agent") || "", created: new Date().toISOString() };
      await env.BUCKET.put(key, JSON.stringify(rec), { httpMetadata: { contentType: "application/json" } });
      let test = null;
      try {
        test = await sendPush(env, rec, { title: "Notifications are on", body: "A 07:00 push on days a rule fires, and a bedtime nudge on nights the habit slips. This is the test.", tag: "test", url: "/" }, key);
      } catch (e) { test = "error: " + (e && e.message); }
      return json({ ok: true, user, test });
    }
    if (req.method === "POST" && url.pathname === "/push/unsubscribe") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      if (body && body.endpoint) await env.BUCKET.delete(`push/subs/${await sha256hex(body.endpoint)}.json`);
      return json({ ok: true });
    }
    if (req.method === "POST" && url.pathname === "/push/test") {
      // send the caller's current brief (morning or evening) to their own device now
      let body;
      try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const kind = body && body.kind === "evening" ? "evening" : "morning";
      const key = body && body.endpoint ? `push/subs/${await sha256hex(body.endpoint)}.json` : null;
      const sub = key && await getJSON(env, key);
      if (!sub) return json({ error: "not subscribed" }, 404);
      const brief = await getJSON(env, "brief.json");
      const push = brief && brief.users && brief.users[sub.user] && brief.users[sub.user].push;
      if (!push) return json({ error: "no brief for user" }, 404);
      // a null slot is a real state (no rule fired / the bedtime habit is holding): say so
      const msg = push[kind] || (kind === "morning"
        ? { title: "No morning push today", body: "No rule fired: no lifting-day gap, no ring metric out of range two nights running, no first record in 60+ days. This is the test.", tag: "morning-none" }
        : { title: "No bedtime nudge tonight", body: "The last three bedtimes were within 20 minutes of the target. This is the test.", tag: "evening-none" });
      try {
        // test sends bypass the cap; they are logged as kind "test", which maySend ignores
        const status = await sendPush(env, sub, { title: msg.title, body: msg.body, tag: msg.tag || kind, url: "/" }, key);
        if (status >= 200 && status < 300) {
          const log = (await getJSON(env, PUSH_LOG)) || {};
          await putJSON(env, PUSH_LOG, recordSend(log, sub.user, { kind: "test", tag: msg.tag || kind }));
        }
        return json({ ok: status >= 200 && status < 300, status });
      } catch (e) {
        return json({ ok: false, error: "send failed: " + (e && e.message) }, 200);
      }
    }
    if (req.method === "POST" && url.pathname === "/push/opened") {
      // sw.js posts the notification's tag on click; goes in the same log as the sends
      let body;
      try { body = await req.json(); } catch { body = {}; }
      // Access mode knows the person from the login email; otherwise the service
      // worker sends the subscription endpoint and the stored subscription says whose it is
      let user = userFor(who.email, env);
      if (!user && body && body.endpoint) {
        const rec = await getJSON(env, `push/subs/${await sha256hex(String(body.endpoint))}.json`);
        user = rec && rec.user;
      }
      if (!user) return json({ error: "no user for this device" }, 403);
      const log = (await getJSON(env, PUSH_LOG)) || {};
      await putJSON(env, PUSH_LOG, recordOpened(log, user, body && body.tag));
      return json({ ok: true });
    }
    if (req.method === "GET" && url.pathname === "/push/subscribed") {
      const ep = url.searchParams.get("endpoint");
      if (!ep) return json({ subscribed: false });
      const rec = await getJSON(env, `push/subs/${await sha256hex(ep)}.json`);
      return json({ subscribed: !!rec, user: rec && rec.user });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      setTimeZone((await loadSettings(env)).tz);
      const r = await scheduledRefresh(env).catch((err) => ({ error: String(err && err.message) }));
      const m = await sendBriefs(env, "morning");
      const e = await sendBriefs(env, "evening");
      console.log(JSON.stringify({ refresh: r, morning: m, evening: e }));
    })());
  },
};
