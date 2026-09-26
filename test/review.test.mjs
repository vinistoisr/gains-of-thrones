// Regression tests for the whole-project review of the public release: each test
// names the failure a first-time user would have hit.
import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixture.json";
import worker from "../src/worker.js";
import { runRefresh } from "../src/pipeline/refresh.js";
import { settingsApi } from "../src/settings.js";
import { renderPage } from "../src/pipeline/render.js";
import { computeBrief } from "../src/pipeline/brief.js";
import { loadWorkouts, mergeDays } from "../src/pipeline/summarize.js";
import { setTimeZone, todayLocal } from "../src/pipeline/util.js";

const bucket = (objects) => ({
  get: async (key) => (key in objects ? { body: objects[key], uploaded: new Date(0), json: async () => JSON.parse(objects[key]) } : null),
  head: async (key) => (key in objects ? {} : null),
  put: async (key, body) => { objects[key] = String(body); },
  delete: async (keys) => { for (const k of [].concat(keys)) delete objects[k]; },
  list: async ({ prefix }) => ({ objects: Object.keys(objects).filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
});
const ok = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
async function withFetch(routes, body) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    for (const [re, h] of routes) if (re.test(String(url))) return h(String(url), init);
    throw new Error(`unexpected fetch ${url}`);
  };
  try { return await body(); } finally { globalThis.fetch = real; }
}
const lastDay = Object.keys(fixture.ring).sort().pop();

test("review: POST /refresh finishes inside the request (no 30 s waitUntil cut-off) and clears its flag", async () => {
  setTimeZone("America/Vancouver");
  const objects = {
    "config/settings.json": JSON.stringify({ tz: "America/Vancouver", people: [{ id: "a", name: "A" }] }),
    "data/a/ring.json": JSON.stringify(fixture.ring),
  };
  const env = { APP_PASSWORD: "pw-for-test", BUCKET: bucket(objects) };
  const login = await worker.fetch(new Request("https://x.example/login", { method: "POST", body: new URLSearchParams({ password: "pw-for-test" }) }), env, { waitUntil: () => {} });
  const cookie = login.headers.get("Set-Cookie").split(";")[0];
  const res = await worker.fetch(new Request("https://x.example/refresh", { method: "POST", headers: { Cookie: cookie } }), env, { waitUntil: () => {} });
  // the response only comes back once the page is built, so the refresh cannot be cut off after it
  assert.deepEqual(await res.json(), { started: true, running: false, ok: true });
  assert.ok(objects["dashboard.html"]);
  assert.ok(!("refresh.flag" in objects));
});

test("review: a time zone change rebuilds every stored night, so old bedtimes are not hours off", async () => {
  setTimeZone("UTC");
  const raw = {
    sleep: [{ day: lastDay, type: "long_sleep", bedtime_start: `${lastDay}T06:30:00Z`, bedtime_end: `${lastDay}T14:00:00Z`, total_sleep_duration: 25000, time_in_bed: 27000 }],
    dailySleep: { day: lastDay, score: 80 },
  };
  const objects = {
    "config/settings.json": JSON.stringify({ tz: "UTC", people: [{ id: "s", name: "S", ring: "oura" }] }),
    "config/secrets.json": JSON.stringify({}),
    [`data/s/oura/${lastDay}.json`]: JSON.stringify(raw),
    "data/s/ring-oura.json": JSON.stringify({ [lastDay]: { d: lastDay, bed: "06:30", slh: 7, score: 80, nsc: 1 } }),
  };
  const env = { BUCKET: bucket(objects) };
  const r = await settingsApi(new Request("https://x.example/api/settings", { method: "POST", body: JSON.stringify({ tz: "America/Vancouver" }) }),
    env, new URL("https://x.example/api/settings"));
  assert.equal(r.status, 200);
  assert.ok("state/rebuild.flag" in objects);
  await runRefresh(env, { reason: "test", narrative: "skip" });
  assert.equal(JSON.parse(objects["data/s/ring-oura.json"])[lastDay].bed, "23:30", "06:30 UTC is 23:30 in Vancouver");
  assert.ok(!("state/rebuild.flag" in objects), "flag cleared after the rebuild");
});

test("review: a Google Health night keeps its sleep-stage timeline in the page", () => {
  const days = [{ d: lastDay, lbl: "x", wd: "Mon", dow: 0, wk: "x", nsc: 1, slh: 7, score: null, hyp: [[1, 2, "de"]] }];
  const { html } = renderPage({ users: [{ id: "g", name: "G", ring: "google" }], datasets: { g: days }, briefs: {}, narratives: {}, today: lastDay });
  assert.ok(html.includes('"hyp":[[1,2,"de"]]'));
  assert.ok(html.includes("Google Health"), "the header names the source");
});

test("review: an exercise named with </script> cannot end the page's data block", () => {
  const days = [{ d: lastDay, lbl: "x", wd: "Mon", dow: 0, wk: "x", score: 80, wex: [{ n: "</script><b>x" }] }];
  const { html } = renderPage({ users: [{ id: "a", name: "A" }], datasets: { a: days }, briefs: {}, narratives: {}, today: lastDay });
  assert.ok(!html.includes("</script><b>x"));
  assert.ok(html.includes("\\u003c/script>\\u003cb>x"));
});

test("review: Oura answering 401 on SpO2 or VO2 max skips that data type and never asks for a reconnect", async () => {
  setTimeZone("America/Vancouver");
  const day = todayLocal();
  const objects = {
    "config/settings.json": JSON.stringify({ tz: "America/Vancouver", people: [{ id: "s", name: "S", ring: "oura" }] }),
    "config/secrets.json": JSON.stringify({ _apps: { oura: { clientId: "c", clientSecret: "d" } }, s: { oura: { access: "at", refresh: "rt", expiresAt: Date.now() + 3600_000 } } }),
  };
  const summary = await withFetch([
    [/oauth\/token/, () => ok({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 })],
    [/usercollection\/(daily_spo2|vO2_max)/, () => new Response("{}", { status: 401 })],
    [/usercollection\/sleep\?/, () => ok({ data: [{ day, type: "long_sleep", bedtime_start: `${day}T00:10:00-07:00`, bedtime_end: `${day}T07:10:00-07:00`, total_sleep_duration: 25200, time_in_bed: 27000 }], next_token: null })],
    [/usercollection\//, () => ok({ data: [], next_token: null })],
  ], () => runRefresh({ BUCKET: bucket(objects) }, { reason: "test", narrative: "skip" }));
  assert.equal(summary.ok, true, summary.error);
  assert.deepEqual(summary.users.s.warnings, []);
  assert.ok(!JSON.parse(objects["config/secrets.json"]).s.oura.needsReconnect);
});

test("review: switching the workout log to None or to Hevy (no key yet) drops the old Liftoff log", async () => {
  setTimeZone("America/Vancouver");
  const base = {
    "data/a/ring.json": JSON.stringify(fixture.ring),
    "data/a/workouts.json": JSON.stringify(fixture.workouts),     // an older Liftoff log, no workouts-src.json
  };
  for (const workouts of [null, "hevy"]) {
    const objects = { ...base, "config/settings.json": JSON.stringify({ tz: "America/Vancouver", people: [{ id: "a", name: "A", workouts }] }) };
    const summary = await runRefresh({ BUCKET: bucket(objects) }, { reason: "test", narrative: "skip" });
    assert.equal(summary.ok, true, summary.error);
    const brief = JSON.parse(objects["brief.json"]).users.a;
    assert.ok(!brief.training || !brief.training.sessions7, `no sessions from the old log with workouts=${workouts}`);
  }
  // still Liftoff: the stored log is used while the source is unreachable
  const objects = { ...base, "config/settings.json": JSON.stringify({ tz: "America/Vancouver", people: [{ id: "a", name: "A", workouts: "liftoff" }] }) };
  await runRefresh({ BUCKET: bucket(objects) }, { reason: "test", narrative: "skip" });
  assert.ok(objects["dashboard.html"].includes('"wsets"'));
});

test("review: removing a person deletes their data, plan and push subscriptions, so a new person with the same name starts clean", async () => {
  const objects = {
    "config/settings.json": JSON.stringify({ people: [{ id: "me", name: "Me" }, { id: "b", name: "B" }] }),
    "config/secrets.json": JSON.stringify({ me: { ultrahuman: "t" } }),
    "data/me/ring.json": "{}", "data/me/empty.json": "{}", "data/me/oura/2026-01-01.json": "{}",
    "coach/me.md": "x", "state/plan-me.json": "{}",
    "push/subs/aaa.json": JSON.stringify({ user: "me" }), "push/subs/bbb.json": JSON.stringify({ user: "b" }),
    "data/b/ring.json": "{}",
  };
  const res = await settingsApi(new Request("https://x.example/api/people/me", { method: "DELETE" }), { BUCKET: bucket(objects) }, new URL("https://x.example/api/people/me"));
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(objects).filter((k) => k.includes("me")).sort(), []);
  assert.ok(objects["push/subs/bbb.json"] && objects["data/b/ring.json"], "the other person is untouched");
});

test("review: a scored night with no bedtime does not pull the bedtime target toward midnight", () => {
  setTimeZone("America/Vancouver");
  const days = mergeDays(fixture.ring, loadWorkouts(fixture.workouts), {});
  const clean = computeBrief(days, lastDay);
  const withGap = days.map((d, i) => (i === days.length - 3 ? { ...d, bedRel: null, wakeRel: null, bed: null, wake: null } : d));
  const gapped = computeBrief(withGap, lastDay);
  // counted as midnight, one missing bedtime moved the spread by an hour or more and the target with it
  assert.ok(Math.abs(gapped.sleep.bedSdMin - clean.sleep.bedSdMin) < 15, `bedtime spread ${clean.sleep.bedSdMin} -> ${gapped.sleep.bedSdMin}`);
  const mins = (hm) => { const [h, m] = hm.split(":").map(Number); return ((h + 12) % 24) * 60 + m; };
  assert.ok(Math.abs(mins(gapped.bedtime.target) - mins(clean.bedtime.target)) <= 30, `target ${clean.bedtime.target} -> ${gapped.bedtime.target}`);
});
