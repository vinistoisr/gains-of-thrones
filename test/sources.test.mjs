import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixture.json";
import { hevyToPosts, hevySync, liftoffSignIn, postsInUnit } from "../src/pipeline/sources.js";
import { loadWorkouts, SET_FAILURE, SET_WARMUP, SET_DROP, SET_RIR } from "../src/pipeline/summarize.js";
import { loadSettings, credential, vapidKeys, slugFor, normPerson } from "../src/config.js";
import { settingsApi } from "../src/settings.js";
import { runRefresh } from "../src/pipeline/refresh.js";

const bucket = (objects) => ({
  get: async (key) => (key in objects ? { body: objects[key], json: async () => JSON.parse(objects[key]) } : null),
  head: async (key) => (key in objects ? {} : null),
  put: async (key, body) => { objects[key] = String(body); },
  delete: async (key) => { delete objects[key]; },
  list: async () => ({ objects: [], truncated: false }),
});

// one Hevy workout in the documented API shape (api.hevyapp.com/docs)
const HEVY_WORKOUT = {
  id: "w1", title: "Push", routine_id: "r1",
  start_time: "2026-06-30T17:00:00Z", end_time: "2026-06-30T18:05:30Z",
  exercises: [
    { index: 0, title: "Bench Press (Barbell)", exercise_template_id: "t1", sets: [
      { index: 0, type: "warmup", weight_kg: 40, reps: 10, rpe: null },
      { index: 1, type: "normal", weight_kg: 80, reps: 8, rpe: 8 },
      { index: 2, type: "failure", weight_kg: 80, reps: 6, rpe: null },
      { index: 3, type: "dropset", weight_kg: 60, reps: 8, rpe: null },
    ] },
    { index: 1, title: "Push Up", sets: [{ index: 0, type: "normal", weight_kg: null, reps: 15 }] },
    { index: 2, title: "Treadmill", sets: [{ index: 0, type: "normal", distance_meters: 2000, duration_seconds: 720 }] },
  ],
};

test("hevyToPosts: loads stay in kg and say so, set types and RPE carry over, timed sets are cardio", () => {
  const [post] = hevyToPosts({ w1: HEVY_WORKOUT });
  assert.equal(post.loadUnit, "kg");
  assert.equal(post.startedAt, "2026-06-30T17:00:00Z");
  assert.equal(post.sessionDuration, "3930");
  const [bench, push, run] = post.exerciseData;
  assert.equal(bench.exerciseTypes, "WR");
  assert.deepEqual(bench.setsData.map((s) => [s.inputOne, s.inputTwo, s.setType]),
    [[40, 10, "warmup"], [80, 8, "normal"], [80, 6, "failure"], [60, 8, "drop"]]);
  assert.equal(bench.setsData[1].rir, 2, "RPE 8 is 2 reps in reserve");
  assert.equal(push.setsData[0].inputOne, 0, "bodyweight set has no load");
  assert.equal(run.exerciseTypes, "DD");
  assert.deepEqual([run.setsData[0].inputOne, run.setsData[0].inputTwo], [2000, 720]);
});

test("postsInUnit: Hevy kg stays kg for a kg person and becomes lb for an lb person", () => {
  const posts = hevyToPosts({ w1: HEVY_WORKOUT });
  assert.equal(postsInUnit(posts, "kg")[0], posts[0], "nothing to convert, same object");
  const lb = postsInUnit(posts, "lb")[0].exerciseData[0].setsData.map((s) => s.inputOne);
  assert.deepEqual(lb, [88.2, 176.4, 176.4, 132.3]);
  const cardio = postsInUnit(posts, "lb")[0].exerciseData[2].setsData[0];
  assert.deepEqual([cardio.inputOne, cardio.inputTwo], [2000, 720], "distance and time are not loads");
});

test("postsInUnit: Liftoff is as logged in the person's unit, except an exercise with an overrideWeightUnit", () => {
  const post = { startedAt: "2026-06-30T17:00:00Z", bodyweight: "80", exerciseData: [
    { exerciseName: "Squat", exerciseTypes: "WR", overrideWeightUnit: null, setsData: [{ inputOne: 100, inputTwo: 5 }] },
    { exerciseName: "Curl", exerciseTypes: "WR", overrideWeightUnit: "lbs", setsData: [{ inputOne: 45, inputTwo: 10 }] },
  ] };
  const [kg] = postsInUnit([post], "kg");
  assert.equal(kg.exerciseData[0].setsData[0].inputOne, 100, "as logged");
  assert.equal(kg.exerciseData[1].setsData[0].inputOne, 20.4, "45 lb override becomes kg");
  assert.equal(kg.bodyweight, "80");
  const [lb] = postsInUnit([post], "lb");
  assert.equal(lb.exerciseData[1].setsData[0].inputOne, 45, "already lb");
  assert.equal(lb.exerciseData[0].setsData[0].inputOne, 100, "no override: taken as the person's unit");
});

test("hevyToPosts -> loadWorkouts: the day has sets, volume, flags, cardio and muscle credit", () => {
  const days = loadWorkouts(postsInUnit(hevyToPosts({ w1: HEVY_WORKOUT }), "kg"));
  const d = days["2026-06-30"];
  assert.equal(d.wvol, 40 * 10 + 80 * 8 + 80 * 6 + 60 * 8, "volume in kg");
  assert.ok(d, "Pacific date of a 17:00 UTC start");
  assert.equal(d.wsets, 5);
  assert.equal(d.wdur, 66);
  assert.equal(d.wcardio, 12);
  assert.equal(d.wfail, 1);
  const flags = d.wsr.filter((t) => t[0] === 0).map((t) => t[3]);
  assert.deepEqual(flags, [SET_WARMUP, SET_RIR, SET_FAILURE, SET_DROP]);
  assert.ok(d.wmus.chest >= 2, "bench and push-ups credit the chest");
  assert.equal(d.wstreak, 0, "no Liftoff streak on a Hevy log");
});

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [re, handler] of routes) if (re.test(String(url))) return handler(String(url), init);
    throw new Error(`unexpected fetch ${url}`);
  };
  fn.calls = calls;
  return fn;
}
async function withFetch(fn, body) {
  const real = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await body(); } finally { globalThis.fetch = real; }
}
const ok = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });

test("hevySync: the first run pages through everything, later runs apply change events", async () => {
  const fetch1 = fakeFetch([[/\/workouts\?page=(\d)/, (u) => {
    const page = Number(/page=(\d)/.exec(u)[1]);
    return ok({ page, page_count: 2, workouts: [{ ...HEVY_WORKOUT, id: `w${page}` }] });
  }]]);
  const first = await withFetch(fetch1, () => hevySync("key", null));
  assert.deepEqual(Object.keys(first.workouts).sort(), ["w1", "w2"]);
  assert.equal(fetch1.calls[0].init.headers["api-key"], "key");

  const fetch2 = fakeFetch([[/\/workouts\/events/, () => ok({ page: 1, page_count: 1, events: [
    { type: "deleted", id: "w1", deleted_at: "2026-07-01T00:00:00Z" },
    { type: "updated", workout: { ...HEVY_WORKOUT, id: "w3" } },
  ] })]]);
  const next = await withFetch(fetch2, () => hevySync("key", first));
  assert.deepEqual(Object.keys(next.workouts).sort(), ["w2", "w3"]);
  assert.match(fetch2.calls[0].url, /since=/);
});

test("liftoffSignIn: posts the credentials the way the app does and returns the refresh token", async () => {
  const f = fakeFetch([[/user\.signIn/, () => ok([{ result: { data: { json: {
    accessToken: "at", refreshToken: "rt", accessTokenExpiresAt: "2030-01-01T00:00:00Z" } } } }])]]);
  const r = await withFetch(f, () => liftoffSignIn("me@example.com", "pw", "https://liftoff.example"));
  assert.equal(r.refreshToken, "rt");
  assert.equal(f.calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { 0: { json: { usernameOrEmail: "me@example.com", password: "pw", provider: "gymbros" } } });
  const bad = fakeFetch([[/user\.signIn/, () => ok([{ error: { json: { message: "Invalid credentials" } } }])]]);
  await assert.rejects(withFetch(bad, () => liftoffSignIn("me@example.com", "no", "https://liftoff.example")), /Invalid credentials/);
});

test("config: the USERS var stands in until settings.json exists, and the older liftoff flag still reads", async () => {
  const env = { BUCKET: bucket({}), TZ: "America/Vancouver", USERS: JSON.stringify([{ id: "alex", name: "Alex", liftoff: true }]) };
  const s = await loadSettings(env);
  assert.equal(s.source, "env");
  assert.equal(s.tz, "America/Vancouver");
  assert.deepEqual(s.people, [{ id: "alex", name: "Alex", ring: "ultrahuman", workouts: "liftoff", units: "lb" }]);
  const stored = { BUCKET: bucket({ "config/settings.json": JSON.stringify({ tz: "Europe/Berlin", people: [{ id: "a", name: "A", workouts: "hevy" }] }) }), USERS: env.USERS };
  assert.equal((await loadSettings(stored)).people[0].id, "a");
});

test("config: a stored credential wins, the older Worker secret is the fallback", () => {
  const env = { ULTRAHUMAN_TOKEN_ALEX: " env-token ", LIFTOFF_REFRESH_TOKEN_ALEX: "rt" };
  assert.equal(credential(env, {}, "alex", "ultrahuman"), "env-token");
  assert.equal(credential(env, { alex: { ultrahuman: "stored" } }, "alex", "ultrahuman"), "stored");
  assert.equal(credential(env, {}, "alex", "liftoff"), "rt");
  assert.equal(credential(env, {}, "alex", "hevy"), null);
});

test("config: VAPID keys come from the Worker vars when set, otherwise are generated once and kept", async () => {
  const pinned = await vapidKeys({ VAPID_PUBLIC: "pub", VAPID_PRIVATE_JWK: "﻿{\"kty\":\"EC\"}", BUCKET: bucket({}) });
  assert.deepEqual(pinned, { publicKey: "pub", privateJwk: { kty: "EC" } });
  const objects = {};
  const a = await vapidKeys({ BUCKET: bucket(objects) });
  const b = await vapidKeys({ BUCKET: bucket(objects) });
  assert.equal(a.publicKey, b.publicKey);
  assert.equal(Buffer.from(a.publicKey, "base64url").length, 65, "uncompressed P-256 point");
  assert.equal(a.privateJwk.crv, "P-256");
});

test("config: ids are slugs of the name, unique, and bad records are dropped", () => {
  assert.equal(slugFor("Zoë Smith", []), "zoe-smith");
  assert.equal(slugFor("Sam", ["sam"]), "sam-2");
  assert.equal(normPerson({ id: "../x", name: "x" }), null);
});

test("settings API: adding a Hevy person checks both tokens, never echoes them, and a refresh builds the page", async () => {
  const objects = {};
  const env = { BUCKET: bucket(objects) };
  const ring = fixture.ring;
  const lastDay = Object.keys(ring).sort().pop();
  const f = fakeFetch([
    [/ultrahuman\.com/, () => ok({ data: { metrics: {} } })],
    [/hevyapp\.com\/v1\/workouts\/count/, () => ok({ workout_count: 1 })],
    [/hevyapp\.com\/v1\/workouts\?/, () => ok({ page: 1, page_count: 1, workouts: [{ ...HEVY_WORKOUT, start_time: `${lastDay}T17:00:00Z`, end_time: `${lastDay}T18:00:00Z` }] })],
  ]);
  const req = (method, path, body) => new Request(`https://h.example${path}`, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const res = await withFetch(f, () => settingsApi(req("POST", "/api/people", { name: "Sam", workouts: "hevy", ultrahuman: "uh-tok", hevy: "hv-key" }), env, new URL("https://h.example/api/people")));
  const out = await res.json();
  assert.equal(res.status, 200, out.error);
  assert.deepEqual(out.people, [{ id: "sam", name: "Sam", ring: "ultrahuman", workouts: "hevy", units: "kg",
    has: { ultrahuman: true, liftoff: false, hevy: true, oura: false, google: false }, reconnect: { oura: false, google: false } }]);
  assert.ok(!JSON.stringify(out).includes("uh-tok") && !JSON.stringify(out).includes("hv-key"), "no credential in the response");
  assert.deepEqual(JSON.parse(objects["config/secrets.json"]), { sam: { ultrahuman: "uh-tok", hevy: "hv-key" } });

  // the ring days come from the bucket (the fake Ultrahuman has nothing new), the workouts from Hevy
  objects["data/sam/ring.json"] = JSON.stringify(ring);
  const summary = await withFetch(f, () => runRefresh(env, { reason: "test", narrative: "skip" }));
  assert.equal(summary.ok, true, summary.error);
  assert.equal(summary.users.sam.workouts, 1);
  assert.ok(objects["dashboard.html"].includes("Ultrahuman Ring + Hevy"));
  assert.ok(objects["config/vapid.json"], "push keys generated on the first render");
});

test("settings API: a rejected Hevy key is reported against its field and nothing is saved", async () => {
  const objects = {};
  const f = fakeFetch([[/hevyapp\.com/, () => new Response("no", { status: 401 })]]);
  const res = await withFetch(f, () => settingsApi(new Request("https://h.example/api/people", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Sam", workouts: "hevy", hevy: "bad" }),
  }), { BUCKET: bucket(objects) }, new URL("https://h.example/api/people")));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).field, "hevy");
  assert.equal(objects["config/settings.json"], undefined);
});
