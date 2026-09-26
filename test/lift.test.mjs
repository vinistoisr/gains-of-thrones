import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixture.json";
import { loadWorkouts, mergeDays } from "../src/pipeline/summarize.js";
import { modalReps, bestLoadAtReps, LIFT_FN_JS } from "../src/pipeline/lift.js";

// wsr tuples: [exIdx, kg, reps, flags(1 failure, 2 warm-up, 4 rir logged, 8 drop), rir?]

test("modalReps: picks the most common working rep count and skips warm-ups", () => {
  const sessions = [
    [[0, 40, 10, 2], [0, 60, 12, 0], [0, 60, 12, 0], [0, 60, 8, 1]],
    [[0, 40, 10, 2], [0, 62.5, 12, 4, 2], [0, 62.5, 8, 0]],
  ];
  // 12 reps x3, 8 reps x2; the 10-rep warm-ups (x2) must not tie 8
  assert.equal(modalReps(sessions), 12);
});

test("modalReps: ties break to the lower rep count", () => {
  const sessions = [[[0, 60, 12, 0], [0, 60, 8, 0]], [[0, 60, 12, 0], [0, 60, 8, 0]]];
  assert.equal(modalReps(sessions), 8);
});

test("modalReps: no working sets, missing wsr, or bodyweight-only sets give null", () => {
  assert.equal(modalReps([]), null);
  assert.equal(modalReps([undefined, []]), null);
  assert.equal(modalReps([[[0, 40, 10, 2]]]), null, "only warm-ups");
  assert.equal(modalReps([[[0, 0, 10, 0]]]), null, "no load logged");
});

test("bestLoadAtReps: heaviest set at exactly r reps, null when the session has none", () => {
  const sets = [[0, 40, 10, 2], [0, 60, 10, 0], [0, 65, 10, 1], [0, 70, 6, 0]];
  assert.equal(bestLoadAtReps(sets, 10), 65);
  assert.equal(bestLoadAtReps(sets, 6), 70);
  assert.equal(bestLoadAtReps(sets, 12), null, "no 12-rep set");
  assert.equal(bestLoadAtReps([[0, 40, 10, 2]], 10), null, "a warm-up at r reps does not count");
  assert.equal(bestLoadAtReps(undefined, 10), null, "a day without wsr");
});

test("bestLoadAtReps on the fixture: sessions without the modal count are gaps", () => {
  const days = mergeDays(fixture.ring, loadWorkouts(fixture.workouts), fixture.screentime);
  const name = "Chest Press Machine";
  const sessions = days.map((d) => {
    const xi = (d.wex || []).findIndex((e) => e.n === name);
    return xi < 0 ? null : (d.wsr || []).filter((t) => t[0] === xi);
  }).filter(Boolean);
  assert.equal(sessions.length, 3);
  const r = modalReps(sessions);
  assert.equal(r, 9, "9 reps x4 beats 10 x2, 11 x2, 12 x1, 8 x1; warm-ups at 10 are ignored");
  assert.deepEqual(sessions.map((s) => bestLoadAtReps(s, r)), [60, 62.5, 65]);
  assert.equal(bestLoadAtReps(sessions[0], 12), null);
  assert.deepEqual(sessions.map((s) => bestLoadAtReps(s, 12)), [null, 62.5, null]);
});

test("LIFT_FN_JS: the page copy of both helpers is self-contained source", () => {
  assert.ok(LIFT_FN_JS.startsWith("function modalReps("));
  assert.ok(LIFT_FN_JS.includes("function bestLoadAtReps("));
  assert.ok(!/\bimport\b|\bexport\b|\brequire\(/.test(LIFT_FN_JS));
  const fn = new Function(LIFT_FN_JS + "\nreturn { modalReps, bestLoadAtReps };")();
  assert.equal(fn.modalReps([[[0, 50, 8, 0], [0, 50, 8, 0], [0, 50, 12, 0]]]), 8);
  assert.equal(fn.bestLoadAtReps([[0, 50, 8, 0]], 8), 50);
});
