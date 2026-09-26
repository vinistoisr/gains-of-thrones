// OAuth 2.0 authorization-code sign-in for ring and tracker sources that have
// no personal tokens (Oura, Google Health). Each deployment registers its own
// app with the provider and pastes the client ID and secret on the settings
// page; the redirect URL to register is <origin>/oauth/<provider>/callback.
//
//   GET /oauth/<provider>/start?person=<id>   signed-in only; stores a one-time
//                                              state and redirects to the provider
//   GET /oauth/<provider>/callback?code&state  exchanges the code, stores the tokens
//
// Storage (config.js, config/secrets.json):
//   secrets._apps[provider] = {clientId, clientSecret}
//   secrets[uid][provider]  = {access, refresh, expiresAt, scope, needsReconnect?}
// Worker secrets OURA_CLIENT_ID / OURA_CLIENT_SECRET (GOOGLE_...) stand in for _apps.

import { loadSecrets, loadSettings, saveSecrets } from "./config.js";

export class ReconnectError extends Error {
  constructor(provider, detail, never = false) {
    const label = PROVIDERS[provider] ? PROVIDERS[provider].label : provider;
    super(never ? `Not connected to ${label} yet. Press Connect ${label} on the settings page.`
      : `${label} sign-in expired or was revoked. Press Reconnect on the settings page.${detail ? ` (${detail})` : ""}`);
    this.provider = provider;
  }
}

export const PROVIDERS = {
  oura: {
    label: "Oura",
    authUrl: "https://cloud.ouraring.com/oauth/authorize",
    tokenUrl: "https://api.ouraring.com/oauth/token",
    // daily summaries (sleep, readiness, activity), heart rate, SpO2; the sleep
    // periods and VO2 max come under "daily". Oura allows 10 users per app until approved.
    scopes: ["daily", "heartrate", "spo2"],
    authParams: {},
    appHelp: "https://cloud.ouraring.com/oauth/applications",
  },
  google: {
    label: "Google Health",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
      "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
      "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
    ],
    // offline + consent return a refresh token every time; no include_granted_scopes,
    // which can merge older Google Fit scopes into the token and get it rejected (403)
    authParams: { access_type: "offline", prompt: "consent" },
    appHelp: "https://console.cloud.google.com/projectcreate",
  },
};
export const OAUTH_PROVIDERS = Object.keys(PROVIDERS);
const STATE_TTL_MS = 15 * 60_000;
const EARLY_MS = 2 * 60_000;             // refresh a little before the stated expiry

const ENV_APP = (p) => [`${p.toUpperCase()}_CLIENT_ID`, `${p.toUpperCase()}_CLIENT_SECRET`];

export const redirectUri = (origin, provider) => `${origin.replace(/\/$/, "")}/oauth/${provider}/callback`;

/** {clientId, clientSecret} for a provider, or null when the deployment has not set it up. */
export function appCreds(env, secrets, provider) {
  const stored = secrets && secrets._apps && secrets._apps[provider];
  if (stored && stored.clientId && stored.clientSecret) return stored;
  const [i, s] = ENV_APP(provider);
  if (env[i] && env[s]) return { clientId: String(env[i]).trim(), clientSecret: String(env[s]).trim() };
  return null;
}

function b64u(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Redirect to the provider's consent screen for one person. */
export async function startAuth(env, provider, person, origin) {
  const p = PROVIDERS[provider];
  const secrets = await loadSecrets(env);
  const app = appCreds(env, secrets, provider);
  if (!app) return { error: `Add the ${p.label} app's client ID and secret on the settings page first.` };
  const settings = await loadSettings(env);
  if (!settings.people.some((x) => x.id === person)) return { error: "No such person." };
  const state = b64u(crypto.getRandomValues(new Uint8Array(24)));
  await env.BUCKET.put(`state/oauth/${state}.json`, JSON.stringify({ provider, person, at: Date.now() }),
    { httpMetadata: { contentType: "application/json" } });
  const q = new URLSearchParams({
    response_type: "code", client_id: app.clientId, redirect_uri: redirectUri(origin, provider),
    scope: p.scopes.join(" "), state, ...p.authParams,
  });
  return { location: `${p.authUrl}?${q}` };
}

async function tokenRequest(provider, app, fields) {
  const r = await fetch(PROVIDERS[provider].tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...fields, client_id: app.clientId, client_secret: app.clientSecret }),
  });
  let j = {};
  try { j = await r.json(); } catch { j = {}; }
  if (!r.ok || !j.access_token) {
    const err = j.error || `HTTP ${r.status}`;
    if (err === "invalid_grant" || r.status === 401) throw new ReconnectError(provider, err);
    throw new Error(`${PROVIDERS[provider].label} token request failed: ${err}${j.error_description ? ` - ${j.error_description}` : ""}`);
  }
  return j;
}

function tokenRecord(j, prev) {
  return {
    access: j.access_token,
    // some providers rotate refresh tokens, some only send one the first time
    refresh: j.refresh_token || (prev && prev.refresh) || null,
    expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    scope: j.scope || (prev && prev.scope) || "",
  };
}

/** The callback: returns {person, provider} on success or {error}. */
export async function finishAuth(env, provider, url) {
  const state = url.searchParams.get("state") || "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(state)) return { error: "Missing or malformed sign-in state." };
  const key = `state/oauth/${state}.json`;
  const o = await env.BUCKET.get(key);
  if (!o) return { error: "This sign-in link was already used or has expired. Start again from the settings page." };
  let st;
  try { st = await o.json(); } catch { st = null; }
  await env.BUCKET.delete(key);
  if (!st || st.provider !== provider || Date.now() - st.at > STATE_TTL_MS) return { error: "The sign-in took too long. Start again from the settings page." };
  if (url.searchParams.get("error")) return { error: `${PROVIDERS[provider].label} said: ${url.searchParams.get("error_description") || url.searchParams.get("error")}` };
  const code = url.searchParams.get("code");
  if (!code) return { error: "No authorization code came back." };
  const secrets = await loadSecrets(env);
  const app = appCreds(env, secrets, provider);
  if (!app) return { error: "The app credentials were removed during the sign-in." };
  let j;
  try {
    j = await tokenRequest(provider, app, { grant_type: "authorization_code", code, redirect_uri: redirectUri(url.origin, provider) });
  } catch (e) {
    return { error: e.message };
  }
  const rec = tokenRecord(j, null);
  if (!rec.refresh) return { error: `${PROVIDERS[provider].label} did not return a refresh token, so the connection would stop working within the hour. Remove the app's access in your ${PROVIDERS[provider].label} account settings and connect again.` };
  secrets[st.person] = { ...(secrets[st.person] || {}), [provider]: rec };
  await saveSecrets(env, secrets);
  return { person: st.person, provider };
}

/**
 * A valid access token for one person, refreshing (and persisting a rotated
 * refresh token) when needed. Throws ReconnectError when the grant is gone;
 * the stored record is then flagged so the settings page shows Reconnect.
 */
export async function accessToken(env, secrets, uid, provider) {
  const rec = secrets[uid] && secrets[uid][provider];
  if (!rec || !rec.refresh) throw new ReconnectError(provider, null, true);
  if (rec.needsReconnect) throw new ReconnectError(provider);
  if (rec.access && rec.expiresAt - EARLY_MS > Date.now()) return rec.access;
  const app = appCreds(env, secrets, provider);
  if (!app) throw new Error(`${PROVIDERS[provider].label} app credentials are missing (settings page).`);
  try {
    const j = await tokenRequest(provider, app, { grant_type: "refresh_token", refresh_token: rec.refresh });
    secrets[uid][provider] = tokenRecord(j, rec);
  } catch (e) {
    if (!(e instanceof ReconnectError)) throw e;
    // Oura refresh tokens are single-use: a refresh running at the same time may
    // already have swapped it. Take the newer stored token before giving up.
    const fresh = await loadSecrets(env);
    const now = fresh[uid] && fresh[uid][provider];
    if (now && now.refresh && now.refresh !== rec.refresh && !now.needsReconnect) {
      secrets[uid][provider] = now;
      if (now.access && now.expiresAt - EARLY_MS > Date.now()) return now.access;
      return accessToken(env, secrets, uid, provider);
    }
    fresh[uid] = { ...(fresh[uid] || {}), [provider]: { ...rec, needsReconnect: true } };
    secrets[uid] = fresh[uid];
    await saveSecrets(env, fresh);
    throw e;
  }
  await saveSecrets(env, secrets);
  return secrets[uid][provider].access;
}

/** GET (or POST with a JSON body) with a bearer token; one refresh-and-retry on 401. */
export async function authedGet(env, secrets, uid, provider, url, body) {
  const send = (token) => fetch(url, body === undefined
    ? { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
    : { method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let token = await accessToken(env, secrets, uid, provider);
  let r = await send(token);
  if (r.status === 401) {
    secrets[uid][provider] = { ...secrets[uid][provider], expiresAt: 0 };
    token = await accessToken(env, secrets, uid, provider);
    r = await send(token);
  }
  if (r.status === 401 || r.status === 403) {
    const body = (await r.text()).slice(0, 160);
    if (r.status === 401) {
      secrets[uid][provider] = { ...secrets[uid][provider], needsReconnect: true };
      await saveSecrets(env, secrets);
      throw new ReconnectError(provider, "401");
    }
    throw new Error(`${PROVIDERS[provider].label} refused the request (403): ${body}`);
  }
  if (r.status === 429) throw new Error(`${PROVIDERS[provider].label} rate limit reached; the next refresh retries.`);
  if (!r.ok) throw new Error(`${PROVIDERS[provider].label} HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
