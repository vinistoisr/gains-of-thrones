import { test } from "node:test";
import assert from "node:assert/strict";
import { startAuth, finishAuth, accessToken, redirectUri, PROVIDERS } from "../src/oauth.js";
import { oura, google, ouraMainSleep, googleMainSleep } from "../src/pipeline/rings.js";
import { runRefresh } from "../src/pipeline/refresh.js";
import { settingsApi } from "../src/settings.js";
import { setTimeZone } from "../src/pipeline/util.js";

const bucket = (objects) => ({
  get: async (key) => (key in objects ? { body: objects[key], json: async () => JSON.parse(objects[key]) } : null),
  head: async (key) => (key in objects ? {} : null),
  put: async (key, body) => { objects[key] = String(body); },
  delete: async (key) => { delete objects[key]; },
  list: async ({ prefix }) => ({ objects: Object.keys(objects).filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
});
const ok = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
async function withFetch(routes, body) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [re, h] of routes) if (re.test(String(url))) return h(String(url), init, calls);
    throw new Error(`unexpected fetch ${url}`);
  };
  try { return await body(calls); } finally { globalThis.fetch = real; }
}
const ORIGIN = "https://dash.example";
const setup = (extra = {}) => {
  const objects = {
    "config/settings.json": JSON.stringify({ tz: "America/Vancouver", people: [{ id: "sam", name: "Sam", ring: "oura" }] }),
    "config/secrets.json": JSON.stringify({ _apps: { oura: { clientId: "cid", clientSecret: "csec" }, google: { clientId: "gid", clientSecret: "gsec" } }, ...extra }),
  };
  return { objects, env: { BUCKET: bucket(objects) } };
};

// ---------------------------------------------------------------- the sign-in round trip
test("oauth: start stores a one-time state and sends the person to Oura with the right redirect and scopes", async () => {
  const { objects, env } = setup();
  const r = await startAuth(env, "oura", "sam", ORIGIN);
  const u = new URL(r.location);
  assert.equal(u.origin + u.pathname, PROVIDERS.oura.authUrl);
  assert.equal(u.searchParams.get("client_id"), "cid");
  assert.equal(u.searchParams.get("redirect_uri"), `${ORIGIN}/oauth/oura/callback`);
  assert.equal(u.searchParams.get("scope"), "daily heartrate spo2 heart_health");
  const state = u.searchParams.get("state");
  assert.ok(objects[`state/oauth/${state}.json`]);
});

test("oauth: Google asks for offline access and consent, and the three read-only Health scopes", async () => {
  const { env } = setup();
  const u = new URL((await startAuth(env, "google", "sam", ORIGIN)).location);
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("include_granted_scopes"), null);
  assert.deepEqual(u.searchParams.get("scope").split(" ").map((s) => s.split("googlehealth.")[1]),
    ["sleep.readonly", "health_metrics_and_measurements.readonly", "activity_and_fitness.readonly"]);
});

test("oauth: start refuses without registered app credentials", async () => {
  const objects = { "config/settings.json": JSON.stringify({ people: [{ id: "sam", name: "Sam" }] }) };
  const r = await startAuth({ BUCKET: bucket(objects) }, "oura", "sam", ORIGIN);
  assert.match(r.error, /client ID and secret/);
});

test("oauth: the callback exchanges the code once, stores the tokens and the state cannot be replayed", async () => {
  const { objects, env } = setup();
  const state = new URL((await startAuth(env, "oura", "sam", ORIGIN)).location).searchParams.get("state");
  const cb = new URL(`${ORIGIN}/oauth/oura/callback?code=abc&state=${state}`);
  const r = await withFetch([[/oauth\/token/, (u, init) => {
    const f = new URLSearchParams(init.body);
    assert.equal(f.get("grant_type"), "authorization_code");
    assert.equal(f.get("code"), "abc");
    assert.equal(f.get("redirect_uri"), `${ORIGIN}/oauth/oura/callback`);
    assert.equal(f.get("client_secret"), "csec");
    return ok({ access_token: "at1", refresh_token: "rt1", expires_in: 86400, token_type: "bearer" });
  }]], () => finishAuth(env, "oura", cb));
  assert.deepEqual(r, { person: "sam", provider: "oura" });
  const t = JSON.parse(objects["config/secrets.json"]).sam.oura;
  assert.equal(t.access, "at1");
  assert.equal(t.refresh, "rt1");
  assert.ok(t.expiresAt > Date.now());
  const again = await finishAuth(env, "oura", cb);
  assert.match(again.error, /already used/);
});

test("oauth: a denied consent comes back as a readable error", async () => {
  const { env } = setup();
  const state = new URL((await startAuth(env, "oura", "sam", ORIGIN)).location).searchParams.get("state");
  const r = await finishAuth(env, "oura", new URL(`${ORIGIN}/oauth/oura/callback?error=access_denied&state=${state}`));
  assert.match(r.error, /Oura said: access_denied/);
});

// ---------------------------------------------------------------- refresh
test("oauth: an expired access token is refreshed and Oura's rotated refresh token is saved", async () => {
  const { objects, env } = setup({ sam: { oura: { access: "old", refresh: "rt1", expiresAt: 0 } } });
  const secrets = JSON.parse(objects["config/secrets.json"]);
  const tok = await withFetch([[/oauth\/token/, (u, init) => {
    assert.equal(new URLSearchParams(init.body).get("refresh_token"), "rt1");
    return ok({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 });
  }]], () => accessToken(env, secrets, "sam", "oura"));
  assert.equal(tok, "at2");
  assert.equal(JSON.parse(objects["config/secrets.json"]).sam.oura.refresh, "rt2");
});

test("oauth: a used-up refresh token is not a reconnect when an overlapping refresh already rotated it", async () => {
  const { objects, env } = setup({ sam: { oura: { access: "old", refresh: "rt1", expiresAt: 0 } } });
  const mine = JSON.parse(objects["config/secrets.json"]);          // read before the other run
  const stored = JSON.parse(objects["config/secrets.json"]);
  stored.sam.oura = { access: "at9", refresh: "rt9", expiresAt: Date.now() + 3600_000 };
  objects["config/secrets.json"] = JSON.stringify(stored);          // the other run won
  const tok = await withFetch([[/oauth\/token/, () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })]],
    () => accessToken(env, mine, "sam", "oura"));
  assert.equal(tok, "at9");
  assert.ok(!JSON.parse(objects["config/secrets.json"]).sam.oura.needsReconnect);
});

test("oauth: a revoked grant flags the person for Reconnect and says so", async () => {
  const { objects, env } = setup({ sam: { oura: { access: "old", refresh: "rt1", expiresAt: 0 } } });
  const secrets = JSON.parse(objects["config/secrets.json"]);
  await assert.rejects(withFetch([[/oauth\/token/, () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })]],
    () => accessToken(env, secrets, "sam", "oura")), /Press Reconnect/);
  assert.equal(JSON.parse(objects["config/secrets.json"]).sam.oura.needsReconnect, true);
});

// ---------------------------------------------------------------- Oura adapter
// payloads in the documented v2 shapes (cloud.ouraring.com/v2/docs, OpenAPI 1.41)
const OURA_SLEEP = {
  id: "s1", day: "2026-09-24", type: "long_sleep", period: 1, low_battery_alert: false,
  bedtime_start: "2026-09-23T23:10:00-07:00", bedtime_end: "2026-09-24T06:55:00-07:00",
  total_sleep_duration: 25200, time_in_bed: 27900, deep_sleep_duration: 5400, rem_sleep_duration: 6000,
  light_sleep_duration: 13800, awake_time: 2700, efficiency: 90, latency: 600,
  average_hrv: 52, average_heart_rate: 55.2, lowest_heart_rate: 48, restless_periods: 12,
  sleep_phase_5_min: "4422211333", readiness: { score: 80, temperature_deviation: -0.1, contributors: {} },
};
const OURA_NAP = { ...OURA_SLEEP, id: "s2", type: "sleep", total_sleep_duration: 1800, bedtime_start: "2026-09-24T14:00:00-07:00", bedtime_end: "2026-09-24T14:40:00-07:00" };

test("oura: the scored night is the long_sleep, never a nap or a rejected rest", () => {
  assert.equal(ouraMainSleep([OURA_NAP, OURA_SLEEP, { ...OURA_SLEEP, id: "r", type: "rest", total_sleep_duration: 99999 }]).id, "s1");
});

test("oura: fetchDays pages every collection and toRec maps it onto the ring record", async () => {
  setTimeZone("America/Vancouver");
  const { objects, env } = setup({ sam: { oura: { access: "at", refresh: "rt", expiresAt: Date.now() + 3600_000 } } });
  const secrets = JSON.parse(objects["config/secrets.json"]);
  const pages = {
    sleep: [{ data: [OURA_SLEEP], next_token: "p2" }, { data: [OURA_NAP], next_token: null }],
    daily_sleep: [{ data: [{ id: "d", day: "2026-09-24", score: 82, contributors: {}, timestamp: "x" }], next_token: null }],
    daily_readiness: [{ data: [{ id: "r", day: "2026-09-24", score: 79, temperature_deviation: -0.2, contributors: {}, timestamp: "x" }], next_token: null }],
    daily_activity: [{ data: [{ id: "a", day: "2026-09-24", steps: 9123, score: 70 }], next_token: null }],
    daily_spo2: [{ data: [{ id: "o", day: "2026-09-24", spo2_percentage: { average: 96.4 } }], next_token: null }],
    vO2_max: [{ data: [], next_token: null }],
  };
  const raw = await withFetch([[/api\.ouraring\.com\/v2\/usercollection\/(\w+)\?/, (u, init) => {
    assert.equal(init.headers.Authorization, "Bearer at");
    const coll = /usercollection\/(\w+)\?/.exec(u)[1];
    const next = new URL(u).searchParams.get("next_token");
    return ok(pages[coll][next ? 1 : 0]);
  }]], () => oura.fetchDays(env, secrets, "sam", "2026-09-20", "2026-09-25"));
  assert.equal(raw["2026-09-24"].sleep.length, 2, "both pages of sleep periods");
  const rec = oura.toRec(raw["2026-09-24"], "2026-09-24");
  assert.equal(rec.score, 82, "daily sleep score");
  assert.equal(rec.rec, 79, "readiness score");
  assert.equal(rec.slh, 7);
  assert.equal(rec.tib, 7.75);
  assert.deepEqual([rec.deep, rec.rem, rec.light], [90, 100, 230]);
  assert.deepEqual([rec.hrv, rec.rhr, rec.eff, rec.temp, rec.steps, rec.spo2, rec.toss], [52, 48, 90, -0.2, 9123, 96.4, 12]);
  assert.equal(rec.bed, "23:10");
  assert.equal(rec.wake, "06:55");
  assert.equal(rec.bedRel, -0.83);
  const bt = Date.parse(OURA_SLEEP.bedtime_start) / 1000;
  assert.deepEqual(rec.hyp.map((h) => h[2]), ["aw", "li", "de", "re"]);
  assert.deepEqual(rec.hyp[0], [bt, bt + 600, "aw"], "two 5-minute awake phases merge");
  assert.equal(rec.mov, null, "no Ultrahuman movement index");
});

// ---------------------------------------------------------------- Google adapter
// shapes from the v4 discovery document (health.googleapis.com/$discovery/rest?version=v4)
const G_SLEEP = {
  type: "STAGES",
  interval: { startTime: "2026-09-24T06:05:00Z", endTime: "2026-09-24T13:50:00Z", startUtcOffset: "-25200s", endUtcOffset: "-25200s",
    civilEndTime: { date: { year: 2026, month: 9, day: 24 }, time: { hours: 6, minutes: 50 } } },
  metadata: { mainSleep: true, nap: false, processed: true },
  summary: { minutesInSleepPeriod: "465", minutesAsleep: "420", minutesAwake: "45",
    stagesSummary: [{ type: "DEEP", minutes: "80", count: "4" }, { type: "REM", minutes: "95", count: "5" }, { type: "LIGHT", minutes: "245", count: "20" }, { type: "AWAKE", minutes: "45", count: "12" }] },
  stages: [
    { type: "AWAKE", startTime: "2026-09-24T06:05:00Z", endTime: "2026-09-24T06:15:00Z" },
    { type: "LIGHT", startTime: "2026-09-24T06:15:00Z", endTime: "2026-09-24T07:00:00Z" },
    { type: "DEEP", startTime: "2026-09-24T07:00:00Z", endTime: "2026-09-24T08:00:00Z" },
  ],
};
const gDate = { year: 2026, month: 9, day: 24 };

test("google: the main night is the one flagged mainSleep, else the longest non-nap", () => {
  const nap = { ...G_SLEEP, metadata: { nap: true }, summary: { minutesAsleep: "900" } };
  assert.equal(googleMainSleep([nap, G_SLEEP]), G_SLEEP);
  const plain = { ...G_SLEEP, metadata: {} };
  assert.equal(googleMainSleep([nap, plain]), plain);
});

test("google: fetchDays filters by civil date, rolls up steps, and toRec fills what Google has", async () => {
  setTimeZone("America/Vancouver");
  const { objects, env } = setup({ sam: { google: { access: "gat", refresh: "grt", expiresAt: Date.now() + 3600_000 } } });
  const secrets = JSON.parse(objects["config/secrets.json"]);
  const seen = [];
  const raw = await withFetch([
    [/dataTypes\/steps\/dataPoints:dailyRollUp/, (u, init) => {
      const b = JSON.parse(init.body);
      assert.deepEqual(b.range.start.date, { year: 2026, month: 9, day: 20 });
      assert.equal(b.windowSizeDays, 1);
      return ok({ rollupDataPoints: [{ civilStartTime: { date: gDate }, steps: { countSum: "10456" } }] });
    }],
    [/dataTypes\/([a-z-]+)\/dataPoints\?/, (u) => {
      const type = /dataTypes\/([a-z-]+)\//.exec(u)[1];
      seen.push([type, new URL(u).searchParams.get("filter")]);
      const pts = {
        sleep: [{ sleep: G_SLEEP }],
        "daily-resting-heart-rate": [{ dailyRestingHeartRate: { date: gDate, beatsPerMinute: "51" } }],
        "daily-heart-rate-variability": [{ dailyHeartRateVariability: { date: gDate, averageHeartRateVariabilityMilliseconds: 44.6 } }],
        "daily-oxygen-saturation": [{ dailyOxygenSaturation: { date: gDate, averagePercentage: 95.8 } }],
        "daily-sleep-temperature-derivations": [{ dailySleepTemperatureDerivations: { date: gDate, nightlyTemperatureCelsius: 33.9, baselineTemperatureCelsius: 34.2 } }],
      }[type];
      if (!pts) return new Response("{}", { status: 404 });          // no VO2 max on this device
      return ok({ dataPoints: pts, nextPageToken: "" });
    }],
  ], () => google.fetchDays(env, secrets, "sam", "2026-09-20", "2026-09-25"));
  assert.deepEqual(seen[0], ["sleep", 'sleep.interval.civil_end_time >= "2026-09-20" AND sleep.interval.civil_end_time < "2026-09-26"']);
  assert.ok(seen.some(([t, f]) => t === "daily-heart-rate-variability" && f.startsWith('daily_heart_rate_variability.date >= "2026-09-20"')));
  const rec = google.toRec(raw["2026-09-24"], "2026-09-24");
  assert.equal(rec.score, null, "Google publishes no sleep score");
  assert.equal(rec.rec, null);
  assert.deepEqual([rec.slh, rec.tib, rec.eff], [7, 7.75, 90]);
  assert.deepEqual([rec.deep, rec.rem, rec.light], [80, 95, 245]);
  assert.deepEqual([rec.hrv, rec.rhr, rec.spo2, rec.temp, rec.steps], [44.6, 51, 95.8, -0.3, 10456]);
  assert.equal(rec.vo2, null);
  assert.equal(rec.bed, "23:05");
  assert.equal(rec.wake, "06:50");
  assert.deepEqual(rec.hyp.map((h) => h[2]), ["aw", "li", "de"]);
});

// ---------------------------------------------------------------- end to end
test("refresh: an Oura person gets a page built from Oura data, stored under its own source", async () => {
  setTimeZone("America/Vancouver");
  const { objects, env } = setup({ sam: { oura: { access: "at", refresh: "rt", expiresAt: Date.now() + 3600_000 } } });
  const summary = await withFetch([[/api\.ouraring\.com\/v2\/usercollection\/(\w+)\?/, (u) => {
    const coll = /usercollection\/(\w+)\?/.exec(u)[1];
    const start = new URL(u).searchParams.get("start_date");
    const days = [];
    for (let i = 0; i < 20; i++) {
      const d = new Date(Date.parse(start) + (i + 1) * 86400000).toISOString().slice(0, 10);
      if (coll === "sleep") days.push({ ...OURA_SLEEP, id: d, day: d, bedtime_start: `${d}T00:10:00-07:00`, bedtime_end: `${d}T07:10:00-07:00`, average_hrv: 40 + i });
      if (coll === "daily_sleep") days.push({ id: d, day: d, score: 70 + (i % 10), contributors: {} });
      if (coll === "daily_readiness") days.push({ id: d, day: d, score: 75, temperature_deviation: 0.1, contributors: {} });
      if (coll === "daily_activity") days.push({ id: d, day: d, steps: 8000 + i * 100 });
    }
    return ok({ data: days, next_token: null });
  }]], () => runRefresh(env, { reason: "test", narrative: "skip" }));
  assert.equal(summary.ok, true, summary.error);
  assert.ok(summary.users.sam.fetched > 0);
  assert.ok(objects["data/sam/ring-oura.json"], "summaries under ring-oura.json");
  assert.ok(Object.keys(objects).some((k) => /^data\/sam\/oura\/\d{4}-\d{2}-\d{2}\.json$/.test(k)), "raw days under data/sam/oura/");
  assert.ok(!objects["data/sam/ring.json"], "the Ultrahuman summaries are untouched");
  assert.ok(objects["dashboard.html"].includes("Sam"));
});

test("refresh: an expired Google sign-in is a warning, not a crash", async () => {
  const objects = {
    "config/settings.json": JSON.stringify({ tz: "America/Vancouver", people: [{ id: "g", name: "G", ring: "google" }] }),
    "config/secrets.json": JSON.stringify({ _apps: { google: { clientId: "gid", clientSecret: "gsec" } }, g: { google: { access: "x", refresh: "y", expiresAt: 0 } } }),
  };
  const summary = await withFetch([[/oauth2\.googleapis\.com\/token/, () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })]],
    () => runRefresh({ BUCKET: bucket(objects) }, { reason: "test", narrative: "skip" }));
  assert.match(summary.users.g.warnings[0], /Google Health sign-in expired or was revoked/);
  assert.equal(JSON.parse(objects["config/secrets.json"]).g.google.needsReconnect, true);
});

test("settings API: app credentials are stored, never echoed, and the redirect URI is shown", async () => {
  const objects = {};
  const env = { BUCKET: bucket(objects) };
  const call = (b) => settingsApi(new Request(`${ORIGIN}/api/apps`, { method: "POST", body: JSON.stringify(b) }), env, new URL(`${ORIGIN}/api/apps`));
  const res = await call({ provider: "oura", clientId: "cid", clientSecret: "shh" });
  const out = await res.json();
  assert.equal(res.status, 200, out.error);
  assert.deepEqual(out.apps.oura, { label: "Oura", configured: true, clientId: "cid", redirectUri: redirectUri(ORIGIN, "oura"), help: PROVIDERS.oura.appHelp });
  assert.ok(!JSON.stringify(out).includes("shh"));
  assert.equal((await (await call({ provider: "google", clientId: "g" })).json()).field, "clientSecret");
});
