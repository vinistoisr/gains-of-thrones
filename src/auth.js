// Who is asking. Two modes, picked by the Worker's vars:
//
//   access    ACCESS_TEAM + ACCESS_AUD set: Cloudflare Access fronts the hostname
//             and the Worker verifies the Access JWT itself as defence in depth.
//             A login email maps to a person through EMAIL_USERS. Service tokens
//             carry no email: ADMIN_CLIENT_ID may do anything, any other one only
//             reads GET /coach and GET /status.
//   password  the default: one password (the APP_PASSWORD secret) for the whole
//             deployment, a signed session cookie after sign-in, failed attempts
//             throttled per IP. An optional API_TOKEN secret, sent as
//             "Authorization: Bearer <token>", reads GET /coach and GET /status.
//
// identify() returns {email, admin, limited} or null.

const te = new TextEncoder();
const COOKIE = "hd_session";
const SESSION_DAYS = 180;
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_MAX = 8;                     // per IP per window
const FAIL_KEY = "state/login-fail.json";
let JWKS = { team: null, keys: null, at: 0 };

export const authMode = (env) => (env.ACCESS_TEAM && env.ACCESS_AUD ? "access" : "password");

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
function cookie(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.get("Cookie") || "");
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- Access
async function accessKeys(team) {
  if (JWKS.team === team && JWKS.keys && Date.now() - JWKS.at < 3600_000) return JWKS.keys;
  const r = await fetch(`${team}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new Error(`certs ${r.status}`);
  const { keys } = await r.json();
  JWKS = { team, keys, at: Date.now() };
  return keys;
}

/** The verified Access JWT payload, or null. */
export async function verifyAccess(req, env) {
  const team = String(env.ACCESS_TEAM).replace(/\/$/, "");
  const token = req.headers.get("Cf-Access-Jwt-Assertion") || cookie(req, "CF_Authorization");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64uDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64uDecode(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== team || !aud.includes(env.ACCESS_AUD) || !(payload.exp > now)) return null;
  const jwk = (await accessKeys(team)).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uDecode(parts[2]), te.encode(`${parts[0]}.${parts[1]}`));
  return ok ? payload : null;
}

// ---------------------------------------------------------------- password sessions
async function hmacKey(env) {
  const raw = await crypto.subtle.digest("SHA-256", te.encode(`health-dashboard session|${env.APP_PASSWORD}`));
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** "v1.<expiry seconds>.<sig>"; changing APP_PASSWORD signs everyone out. */
export async function makeSession(env, now = Date.now()) {
  const body = `v1.${Math.floor(now / 1000) + SESSION_DAYS * 86400}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), te.encode(body));
  return `${body}.${b64uEncode(sig)}`;
}

export async function checkSession(env, value) {
  if (!value || !env.APP_PASSWORD) return false;
  const m = /^(v1\.(\d+))\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!m || Number(m[2]) * 1000 < Date.now()) return false;
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(env), b64uDecode(m[3]), te.encode(m[1]));
  } catch { return false; }
}

export function sessionCookie(value, secure) {
  const attrs = [`${COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${value ? SESSION_DAYS * 86400 : 0}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Constant-time comparison through HMAC of both sides. */
async function sameSecret(a, b) {
  const k = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const [x, y] = await Promise.all([a, b].map((v) => crypto.subtle.sign("HMAC", k, te.encode(String(v)))));
  const u = new Uint8Array(x), w = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ w[i];
  return d === 0;
}

async function ipKey(req) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const h = await crypto.subtle.digest("SHA-256", te.encode(`login|${ip}`));
  return b64uEncode(h).slice(0, 16);
}

/**
 * Check a submitted password. Returns "ok", "wrong" or "throttled"; a wrong
 * attempt is counted against the caller's IP for FAIL_WINDOW_MS.
 */
export async function tryPassword(env, req, password) {
  const now = Date.now();
  const who = await ipKey(req);
  let log = {};
  const o = await env.BUCKET.get(FAIL_KEY);
  if (o) { try { log = await o.json(); } catch { log = {}; } }
  for (const k of Object.keys(log)) {
    log[k] = (log[k] || []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (!log[k].length) delete log[k];
  }
  if ((log[who] || []).length >= FAIL_MAX) return "throttled";
  if (env.APP_PASSWORD && await sameSecret(password || "", env.APP_PASSWORD)) {
    if (log[who]) { delete log[who]; await env.BUCKET.put(FAIL_KEY, JSON.stringify(log)); }
    return "ok";
  }
  log[who] = [...(log[who] || []), now];
  await env.BUCKET.put(FAIL_KEY, JSON.stringify(log));
  return "wrong";
}

// ---------------------------------------------------------------- identify
/** {email, admin, limited} for an allowed caller, or null. Throws if Access certs are unreachable. */
export async function identify(req, env) {
  if (authMode(env) === "access") {
    const p = await verifyAccess(req, env);
    if (!p) return null;
    if (p.email) return { email: p.email, admin: true, limited: false };
    const admin = !!env.ADMIN_CLIENT_ID && p.common_name === env.ADMIN_CLIENT_ID;
    return { email: null, admin, limited: !admin };
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("Authorization") || "");
  if (bearer && env.API_TOKEN && await sameSecret(bearer[1].trim(), env.API_TOKEN)) return { email: null, admin: false, limited: true };
  if (await checkSession(env, cookie(req, COOKIE))) return { email: null, admin: true, limited: false };
  return null;
}
