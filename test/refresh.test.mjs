import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixture.json";
import { runRefresh } from "../src/pipeline/refresh.js";
import { todayLocal, mondayOf } from "../src/pipeline/util.js";

// just enough of an R2 binding for a refresh with no API tokens: the ring and
// the workouts come from the bucket, nothing is fetched, no Workers AI
const bucket = (objects) => ({
  get: async (key) => (key in objects ? { body: objects[key], json: async () => JSON.parse(objects[key]) } : null),
  head: async (key) => (key in objects ? {} : null),
  put: async (key, body) => { objects[key] = String(body); },
  delete: async (key) => { delete objects[key]; },
  list: async () => ({ objects: [], truncated: false }),
});

test("runRefresh: the first refresh of a new week scores the stored weeks from the set log and appends this week's plan", async () => {
  const objects = {
    "data/alex/ring.json": JSON.stringify(fixture.ring),
    "data/alex/workouts.json": JSON.stringify(fixture.workouts),
    // two unscored weeks: quads hit (Leg Press 4 sets on 2026-06-27), calves miss (never trained)
    "state/plan.json": JSON.stringify({ weeks: [
      { weekStart: "2026-06-15", group: "calves", exercise: null, sets: 3, target: 4, days: [1, 5], createdAt: "2026-06-15" },
      { weekStart: "2026-06-22", group: "quads", exercise: "Leg Press", sets: 3, target: 4, days: [1, 5], createdAt: "2026-06-22" },
    ] }),
  };
  const env = { BUCKET: bucket(objects), USERS: JSON.stringify([{ id: "alex", name: "Alex", workouts: "liftoff" }]) };
  const summary = await runRefresh(env, { reason: "test", narrative: "skip" });
  assert.equal(summary.ok, true, summary.error);
  // the older single-lifter file is adopted into the person's own plan file
  const store = JSON.parse(objects["state/plan-alex.json"]);
  assert.equal(store.weeks.length, 3);
  assert.deepEqual(store.weeks.slice(0, 2).map((w) => [w.group, w.achieved, w.result]), [["calves", 0, "miss"], ["quads", 4, "hit"]]);
  const cur = store.weeks[2];
  assert.equal(cur.weekStart, mondayOf(todayLocal()));
  assert.ok(!("sentence" in cur) && !("state" in cur), "only the fixed fields are stored");
  for (const k of ["group", "sets", "target", "days", "createdAt"]) assert.ok(k in cur, k);
  const brief = JSON.parse(objects["brief.json"]).users.alex;
  assert.equal(brief.training.planHistory.length, 2, "the scored weeks reach the brief in the same refresh");
  assert.equal(brief.training.plan.weekStart, cur.weekStart);
  assert.ok(objects["dashboard.html"].includes("Past calls"));
  // a second refresh in the same week leaves the store as it is
  const before = objects["state/plan-alex.json"];
  await runRefresh(env, { reason: "test", narrative: "skip" });
  assert.equal(objects["state/plan-alex.json"], before);
});
