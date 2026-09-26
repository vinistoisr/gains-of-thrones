// Deployment settings, per-person credentials and the Web Push key pair, all in
// the R2 bucket so a fresh deploy needs nothing beyond the password:
//   config/settings.json  {tz, people: [{id, name, workouts}], contact, origin}
//   config/secrets.json   {uid: {ultrahuman, liftoff, hevy}}   never sent to the browser
//   config/vapid.json     {publicKey, privateJwk}              generated on first use
//
// A deployment configured through Worker vars and secrets instead keeps working:
// the USERS var (JSON list) and TZ var stand in for settings.json until the
// settings page saves one, and a credential missing from secrets.json falls back
// to the Worker secret ULTRAHUMAN_TOKEN_<UID>, LIFTOFF_REFRESH_TOKEN_<UID> or
// HEVY_API_KEY_<UID>. VAPID_PUBLIC + VAPID_PRIVATE_JWK, when both are set, win
// over the generated pair so existing push subscriptions stay valid.

export const WORKOUT_SOURCES = ["liftoff", "hevy"];
const SECRET_ENV = { ultrahuman: "ULTRAHUMAN_TOKEN", liftoff: "LIFTOFF_REFRESH_TOKEN", hevy: "HEVY_API_KEY" };
const SETTINGS_KEY = "config/settings.json";
const SECRETS_KEY = "config/secrets.json";
const VAPID_KEY = "config/vapid.json";

async function getJSON(env, key) {
  const o = await env.BUCKET.get(key);
  if (!o) return null;
  try { return await o.json(); } catch { return null; }
}
const putJSON = (env, key, obj) => env.BUCKET.put(key, JSON.stringify(obj), { httpMetadata: { contentType: "application/json" } });

/** One person as stored; accepts the older {liftoff: true} flag. */
export function normPerson(p) {
  if (!p || typeof p !== "object") return null;
  const id = String(p.id || "").toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(id)) return null;
  const workouts = WORKOUT_SOURCES.includes(p.workouts) ? p.workouts : p.liftoff ? "liftoff" : null;
  return { id, name: String(p.name || id).slice(0, 40), workouts };
}

/** A new id from a display name, unique among `taken`. */
export function slugFor(name, taken) {
  const base = String(name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "person";
  let id = base, n = 2;
  while (taken.includes(id)) id = `${base}-${n++}`;
  return id;
}

/**
 * The settings in force: config/settings.json, else the USERS/TZ vars, else an
 * empty deployment. `source` says which ("r2" | "env" | "none").
 */
export async function loadSettings(env) {
  const stored = await getJSON(env, SETTINGS_KEY);
  if (stored && Array.isArray(stored.people)) {
    return { tz: stored.tz || env.TZ || "UTC", people: stored.people.map(normPerson).filter(Boolean),
      contact: stored.contact || "", origin: stored.origin || "", source: "r2" };
  }
  let people = [];
  try { people = JSON.parse(env.USERS || "[]").map(normPerson).filter(Boolean); } catch { people = []; }
  return { tz: env.TZ || "UTC", people, contact: "", origin: (stored && stored.origin) || "", source: people.length ? "env" : "none" };
}

export async function saveSettings(env, s) {
  const out = { tz: s.tz || "UTC", people: (s.people || []).map(normPerson).filter(Boolean), contact: s.contact || "", origin: s.origin || "" };
  await putJSON(env, SETTINGS_KEY, out);
  return { ...out, source: "r2" };
}

/** Remember the public origin (for the push contact and the coach header) the first time a signed-in page is served. */
export async function rememberOrigin(env, origin) {
  const stored = (await getJSON(env, SETTINGS_KEY)) || {};
  if (stored.origin === origin) return;
  await putJSON(env, SETTINGS_KEY, { ...stored, origin });
}

export async function loadSecrets(env) {
  return (await getJSON(env, SECRETS_KEY)) || {};
}

/** Set (value) or clear (null) one credential. */
export async function setSecret(env, uid, kind, value) {
  const all = await loadSecrets(env);
  const mine = { ...(all[uid] || {}) };
  if (value) mine[kind] = String(value).trim(); else delete mine[kind];
  if (Object.keys(mine).length) all[uid] = mine; else delete all[uid];
  await putJSON(env, SECRETS_KEY, all);
}

export async function dropSecrets(env, uid) {
  const all = await loadSecrets(env);
  if (!(uid in all)) return;
  delete all[uid];
  await putJSON(env, SECRETS_KEY, all);
}

/** One credential: the stored one, else the Worker secret of the older setup. */
export function credential(env, secrets, uid, kind) {
  const stored = secrets && secrets[uid] && secrets[uid][kind];
  if (stored) return String(stored).trim();
  const v = env[`${SECRET_ENV[kind]}_${uid.toUpperCase().replace(/-/g, "_")}`];
  return v ? String(v).trim() : null;
}

/** What the settings page may see: which credentials exist, never their values. */
export function peopleView(env, settings, secrets) {
  return settings.people.map((p) => ({
    ...p,
    has: Object.fromEntries(Object.keys(SECRET_ENV).map((k) => [k, !!credential(env, secrets, p.id, k)])),
  }));
}

// ---------------------------------------------------------------- Web Push keys
const b64u = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** {publicKey (b64url raw P-256 point), privateJwk (object)}; generated and stored once. */
export async function vapidKeys(env) {
  if (env.VAPID_PUBLIC && env.VAPID_PRIVATE_JWK) {
    // a secret piped in through PowerShell can carry a UTF-8 BOM / whitespace that breaks JSON.parse
    return { publicKey: env.VAPID_PUBLIC, privateJwk: JSON.parse(String(env.VAPID_PRIVATE_JWK).replace(/^﻿/, "").trim()) };
  }
  const stored = await getJSON(env, VAPID_KEY);
  if (stored && stored.publicKey && stored.privateJwk) return stored;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const keys = {
    publicKey: b64u(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
  await putJSON(env, VAPID_KEY, keys);
  return keys;
}

/** The VAPID "sub" claim: the configured contact, else the site origin. */
export function vapidSubject(env, settings) {
  if (env.VAPID_SUBJECT) return env.VAPID_SUBJECT;
  const c = (settings && settings.contact) || "";
  if (/^[^@\s]+@[^@\s]+$/.test(c)) return `mailto:${c}`;
  if (settings && /^https:\/\//.test(settings.origin || "")) return settings.origin;
  return "mailto:admin@example.com";
}
