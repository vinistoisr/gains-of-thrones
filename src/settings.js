// The settings page's JSON API (/api/settings, /api/people). Signed-in callers
// only; worker.js checks that before routing here. Credentials go into
// config/secrets.json and are never sent back: the page only learns which ones
// exist (config.js peopleView).
import {
  loadSettings, saveSettings, loadSecrets, saveSecrets, setSecret, dropSecrets, peopleView, slugFor, normPerson,
  WORKOUT_SOURCES, UNITS, RING_SOURCES,
} from "./config.js";
import { PROVIDERS, OAUTH_PROVIDERS, appCreds, redirectUri } from "./oauth.js";
import { fetchUltrahumanDay, liftoffSignIn, HEVY_BASE, LIFTOFF_DEFAULT_BASE } from "./pipeline/sources.js";
import { validTimeZone, setTimeZone, todayLocal, addDays } from "./pipeline/util.js";
import { authMode } from "./auth.js";

const MAX_PEOPLE = 8;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
async function body(req) {
  try { return await req.json(); } catch { return null; }
}

async function state(env, origin) {
  const settings = await loadSettings(env);
  const secrets = await loadSecrets(env);
  let last = null;
  const o = await env.BUCKET.get("state/last-refresh.json");
  if (o) { try { last = await o.json(); } catch { last = null; } }
  const st = await env.BUCKET.get("status.json");
  let status = null;
  if (st) { try { status = await st.json(); } catch { status = null; } }
  return {
    mode: authMode(env),
    tz: settings.tz,
    contact: settings.contact,
    source: settings.source,
    people: peopleView(env, settings, secrets),
    workoutSources: WORKOUT_SOURCES,
    ringSources: RING_SOURCES,
    // OAuth apps this deployment has registered (never the secret itself)
    apps: Object.fromEntries(OAUTH_PROVIDERS.map((p) => {
      const a = appCreds(env, secrets, p);
      return [p, { label: PROVIDERS[p].label, configured: !!a, clientId: a ? a.clientId : "", redirectUri: origin ? redirectUri(origin, p) : "", help: PROVIDERS[p].appHelp }];
    })),
    lastRefresh: last && {
      at: status && status.last, ok: last.ok, error: last.ok ? null : String(last.error || "").split("\n")[0],
      users: Object.fromEntries(Object.entries(last.users || {}).map(([k, v]) => [k, { warnings: v.warnings || [], days: v.days || 0, workouts: v.workouts }])),
    },
    running: !!(status && status.running),
  };
}

async function checkUltrahuman(token) {
  try { await fetchUltrahumanDay(addDays(todayLocal(), -1), token); return null; }
  catch (e) { return /HTTP 40[13]/.test(e.message) ? "Ultrahuman rejected this token." : `Ultrahuman check failed: ${e.message.slice(0, 120)}`; }
}

async function checkHevy(key) {
  const r = await fetch(`${HEVY_BASE}/workouts/count`, { headers: { "api-key": key, Accept: "application/json" } });
  if (r.status === 401 || r.status === 403) return "Hevy rejected this API key. The API needs a Hevy Pro subscription.";
  if (!r.ok) return `Hevy check failed: HTTP ${r.status}`;
  return null;
}

/**
 * Create or update one person. Body: {id?, name, ring?, workouts, units?, ultrahuman?, hevy?,
 * liftoffEmail?, liftoffPassword?, clear?: ["ultrahuman"|"liftoff"|"hevy"]}.
 * A credential field left empty keeps what is stored. Each new credential is
 * tried against its service first, so a typo is reported here, not at 6 a.m.
 */
async function savePerson(env, b, origin) {
  const settings = await loadSettings(env);
  const people = [...settings.people];
  const name = String(b.name || "").trim();
  if (!name) return json({ error: "Enter a name." }, 400);
  const workouts = WORKOUT_SOURCES.includes(b.workouts) ? b.workouts : null;
  let idx = b.id ? people.findIndex((p) => p.id === b.id) : -1;
  if (b.id && idx < 0) return json({ error: "No such person." }, 404);
  if (idx < 0 && people.length >= MAX_PEOPLE) return json({ error: `Up to ${MAX_PEOPLE} people.` }, 400);
  const id = idx >= 0 ? people[idx].id : slugFor(name, people.map((p) => p.id));

  setTimeZone(settings.tz);
  const ring = RING_SOURCES.includes(b.ring) ? b.ring : "ultrahuman";
  const ultrahuman = ring === "ultrahuman" ? String(b.ultrahuman || "").trim() : "";
  if (ultrahuman) { const err = await checkUltrahuman(ultrahuman); if (err) return json({ error: err, field: "ultrahuman" }, 400); }
  const hevy = workouts === "hevy" ? String(b.hevy || "").trim() : "";
  if (hevy) { const err = await checkHevy(hevy); if (err) return json({ error: err, field: "hevy" }, 400); }
  let liftoff = null;
  if (workouts === "liftoff" && b.liftoffEmail && b.liftoffPassword) {
    try {
      const base = (env.LIFTOFF_API_BASE || LIFTOFF_DEFAULT_BASE).replace(/\/$/, "");
      liftoff = await liftoffSignIn(String(b.liftoffEmail).trim(), String(b.liftoffPassword), base);
    } catch (e) {
      return json({ error: `Liftoff sign-in failed: ${e.message.slice(0, 160)}`, field: "liftoff" }, 400);
    }
  }

  const units = UNITS.includes(b.units) ? b.units : undefined;
  const person = normPerson({ id, name, ring, workouts, units });
  if (idx >= 0) people[idx] = person; else people.push(person);
  await saveSettings(env, { ...settings, people });
  if (ultrahuman) await setSecret(env, id, "ultrahuman", ultrahuman);
  if (hevy) await setSecret(env, id, "hevy", hevy);
  if (liftoff) {
    await setSecret(env, id, "liftoff", liftoff.refreshToken);
    await env.BUCKET.put(`data/${id}/liftoff-auth.json`, JSON.stringify({ accessToken: liftoff.accessToken, expiresAt: liftoff.expiresAt }),
      { httpMetadata: { contentType: "application/json" } });
  }
  for (const k of Array.isArray(b.clear) ? b.clear : []) {
    if (["ultrahuman", "liftoff", "hevy", "oura", "google"].includes(k)) await setSecret(env, id, k, null);
  }
  return json({ ok: true, id, ...(await state(env, origin)) });
}

async function removePerson(env, id, origin) {
  const settings = await loadSettings(env);
  if (!settings.people.some((p) => p.id === id)) return json({ error: "No such person." }, 404);
  await saveSettings(env, { ...settings, people: settings.people.filter((p) => p.id !== id) });
  await dropSecrets(env, id);
  return json({ ok: true, ...(await state(env, origin)) });
}

/** Body {provider, clientId, clientSecret} stores an OAuth app; {provider, clear: true} removes it. */
async function saveApp(env, b, origin) {
  const provider = OAUTH_PROVIDERS.includes(b.provider) ? b.provider : null;
  if (!provider) return json({ error: "Unknown provider." }, 400);
  const secrets = await loadSecrets(env);
  const apps = { ...(secrets._apps || {}) };
  if (b.clear) delete apps[provider];
  else {
    const clientId = String(b.clientId || "").trim(), clientSecret = String(b.clientSecret || "").trim();
    const prev = apps[provider] || {};
    if (!clientId) return json({ error: "Enter the client ID.", field: "clientId" }, 400);
    if (!clientSecret && !prev.clientSecret) return json({ error: "Enter the client secret.", field: "clientSecret" }, 400);
    apps[provider] = { clientId, clientSecret: clientSecret || prev.clientSecret };
  }
  secrets._apps = apps;
  await saveSecrets(env, secrets);
  return json({ ok: true, ...(await state(env, origin)) });
}

/** Routes under /api/. Returns a Response, or null when the path is not ours. */
export async function settingsApi(req, env, url) {
  if (url.pathname === "/api/settings") {
    if (req.method === "GET") return json(await state(env, url.origin));
    if (req.method === "POST") {
      const b = await body(req);
      if (!b) return json({ error: "bad json" }, 400);
      const settings = await loadSettings(env);
      const tz = b.tz != null ? String(b.tz) : settings.tz;
      if (!validTimeZone(tz)) return json({ error: "Unknown time zone.", field: "tz" }, 400);
      const contact = b.contact != null ? String(b.contact).trim().slice(0, 120) : settings.contact;
      if (contact && !/^[^@\s]+@[^@\s]+$/.test(contact)) return json({ error: "Enter an email address or leave it blank.", field: "contact" }, 400);
      await saveSettings(env, { ...settings, tz, contact });
      return json({ ok: true, ...(await state(env, url.origin)) });
    }
  }
  if (url.pathname === "/api/apps" && req.method === "POST") {
    const b = await body(req);
    if (!b) return json({ error: "bad json" }, 400);
    return saveApp(env, b, url.origin);
  }
  if (url.pathname === "/api/people" && req.method === "POST") {
    const b = await body(req);
    if (!b) return json({ error: "bad json" }, 400);
    return savePerson(env, b, url.origin);
  }
  const m = /^\/api\/people\/([a-z0-9_-]{1,32})$/.exec(url.pathname);
  if (m && req.method === "DELETE") return removePerson(env, m[1], url.origin);
  return null;
}
