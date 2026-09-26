import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixture.json";
import { parseDurationMin, loadWorkouts, mergeDays, WKEYS, SET_FAILURE, SET_WARMUP, SET_RIR, effortState, EFFORT_STATES } from "../src/pipeline/summarize.js";

test("parseDurationMin: plain seconds and H:MM:SS give minutes as a float", () => {
  assert.equal(parseDurationMin("3600"), 60);
  assert.equal(parseDurationMin("1:02:30"), 62.5);   // 3750 s
  assert.equal(parseDurationMin("45:00"), 45);
  assert.equal(parseDurationMin("90"), 1.5);
});

test("parseDurationMin: Liftoff phrases, any subset of units in any order", () => {
  assert.equal(parseDurationMin("1 hours 4 minutes 38 seconds"), 3878 / 60);
  assert.equal(parseDurationMin("01 hours 04 minutes 38 seconds"), 3878 / 60);   // zero-padded, the live form
  assert.equal(parseDurationMin("00 hours 45 minutes 10 seconds"), 2710 / 60);
  assert.equal(parseDurationMin("45 minutes 10 seconds"), 2710 / 60);
  assert.equal(parseDurationMin("1 hour"), 60);
  assert.equal(parseDurationMin("58 minutes"), 58);
  assert.equal(parseDurationMin("2 hours 30 seconds"), 120.5);
  assert.equal(parseDurationMin("38 seconds 4 minutes 1 hour"), 3878 / 60);
  assert.equal(parseDurationMin("1 Hour, 5 Minutes and 30 Seconds"), 65.5);
  assert.equal(parseDurationMin("1h 4min 38s"), 3878 / 60);
  assert.equal(parseDurationMin("  58 minutes  "), 58);
});

test("parseDurationMin: empty, missing, zero and garbage give null", () => {
  assert.equal(parseDurationMin(""), null);
  assert.equal(parseDurationMin(null), null);
  assert.equal(parseDurationMin(undefined), null);
  assert.equal(parseDurationMin("0"), null);
  assert.equal(parseDurationMin("abc"), null);
  assert.equal(parseDurationMin("1:xx:00"), null);
  assert.equal(parseDurationMin("hours minutes seconds"), null);
  assert.equal(parseDurationMin("1 hours 4 bananas"), null);
  assert.equal(parseDurationMin("0 hours 0 minutes 0 seconds"), null);
});

const workouts = loadWorkouts(fixture.workouts);

test("loadWorkouts: one record per session day", () => {
  assert.equal(Object.keys(workouts).length, 9);
  assert.ok(workouts["2026-05-30"], "first session");
  assert.ok(workouts["2026-06-27"], "last session");
});

test("loadWorkouts: set and volume totals", () => {
  const sets = Object.values(workouts).reduce((a, r) => a + r.wsets, 0);
  assert.equal(sets, 96);   // 3 rounds of push (12) + pull (12) + legs (8)
  for (const r of Object.values(workouts)) {
    assert.ok(r.wvol > 0, "volume");
    assert.equal(typeof r.wnames, "string");
    assert.ok(r.wexn >= 2);
  }
});

test("loadWorkouts: session duration comes from the Liftoff phrase, whole minutes per day", () => {
  assert.equal(workouts["2026-05-30"].wdur, 65);   // "1 hours 4 minutes 38 seconds"
  assert.equal(workouts["2026-06-27"].wdur, 79);   // "1 hours 18 minutes 33 seconds"
  for (const r of Object.values(workouts)) assert.ok(Number.isInteger(r.wdur) && r.wdur > 0, String(r.wdur));
  // two posts on one day add up before rounding
  const p = fixture.workouts[0];
  const two = loadWorkouts([p, { ...p, id: "post-1b", sessionDuration: "20 minutes 40 seconds" }]);
  assert.equal(two["2026-05-30"].wdur, 85);   // 64.63 + 20.67 = 85.3
});

test("loadWorkouts: per-exercise e1RM is present and above the top weight", () => {
  for (const r of Object.values(workouts)) {
    for (const e of r.wex) {
      assert.equal(typeof e.e1, "number", e.n);
      assert.ok(e.e1 > e.mw, e.n);
      assert.ok(e.s >= 4, e.n);
    }
  }
});

test("loadWorkouts: wsr holds one tuple per WR set, indexed into wex", () => {
  for (const r of Object.values(workouts)) {
    assert.ok(Array.isArray(r.wsr), "wsr on a lifting day");
    assert.equal(r.wsr.length, r.wsets);
    for (const t of r.wsr) {
      assert.ok(t.length === 4 || t.length === 5, JSON.stringify(t));
      const [i, w, reps, flags] = t;
      assert.ok(Number.isInteger(i) && i >= 0 && i < r.wex.length, "exercise index in wex range");
      assert.equal(w * 2, Math.round(w * 2), "weight on a 0.5 grid");
      assert.ok(Number.isInteger(reps) && reps > 0);
      assert.ok(Number.isInteger(flags) && flags >= 0 && flags < 16);
      assert.equal(t.length === 5, (flags & SET_RIR) !== 0, "5th element only with the rir flag");
    }
    // per-exercise set counts in wsr agree with wex
    r.wex.forEach((e, i) => assert.equal(r.wsr.filter((t) => t[0] === i).length, e.s, e.n));
  }
});

test("loadWorkouts: wsr flags follow the fixture's setType and rir", () => {
  const r = workouts["2026-05-30"];
  // Chest Press Machine: warmup 36x10, two normal at rir 2, one failure 60x10 at rir 0
  assert.deepEqual(r.wsr.slice(0, 4), [[0, 36, 10, SET_WARMUP], [0, 60, 9, SET_RIR, 2], [0, 60, 9, SET_RIR, 2], [0, 60, 10, SET_FAILURE | SET_RIR, 0]]);
  const fails = Object.values(workouts).reduce((a, x) => a + x.wsr.filter((t) => t[3] & SET_FAILURE).length, 0);
  assert.equal(fails, Object.values(workouts).reduce((a, x) => a + x.wfail, 0));
  assert.ok(fails > 0);
});

test("loadWorkouts: wsr rounds weight to 0.25 and reps to an integer, skips empty sets, absent without WR sets", () => {
  const p = fixture.workouts[0];
  const ex = p.exerciseData[0];
  const sets = [
    { ...ex.setsData[1], inputOne: "61.3", inputTwo: 9.6, rir: null },
    { ...ex.setsData[1], inputOne: 0, inputTwo: 0, setType: "normal", rir: null },
    { ...ex.setsData[1], inputOne: 0, inputTwo: 12, setType: "normal", rir: "1" },
  ];
  const one = loadWorkouts([{ ...p, exerciseData: [{ ...ex, setsData: sets }] }])["2026-05-30"];
  assert.equal(one.wsets, 3);
  assert.deepEqual(one.wsr, [[0, 61.25, 10, 0], [0, 0, 12, SET_RIR, 1]]);
  const cardio = loadWorkouts([{ ...p, exerciseData: [{ ...ex, exerciseTypes: "DD", setsData: [{ ...ex.setsData[1], inputOne: 0, inputTwo: 600 }] }] }])["2026-05-30"];
  assert.equal(cardio.wsets, 0);
  assert.equal("wsr" in cardio, false);
});

test("loadWorkouts: wmus carries fractional sets by muscle, wunc the unmatched sets, on lifting days only", () => {
  assert.ok(WKEYS.includes("wmus") && WKEYS.includes("wunc"));
  for (const r of Object.values(workouts)) {
    assert.equal(typeof r.wmus, "object", "wmus");
    assert.ok(Number.isInteger(r.wunc) && r.wunc >= 0, "wunc");
    for (const v of Object.values(r.wmus)) assert.ok(v > 0);
    // the fractional total is the direct set count plus 0.5 per assisting muscle, never less
    const total = Object.values(r.wmus).reduce((a, b) => a + b, 0);
    assert.ok(total >= r.wsets - r.wunc, `${total} >= ${r.wsets - r.wunc}`);
  }
  // push day: chest press 4, shoulder press 4, pushdown 4 -> triceps 4 + 0.5 x 8 assists
  const push = workouts["2026-05-30"];
  assert.equal(push.wmus.chest, 4);
  assert.equal(push.wmus.triceps, 8);
  assert.equal(push.wmus.shoulders, 6);
  assert.equal(push.wunc, 0);
  // every fixture exercise has 4 sets, so assists land on whole numbers there; an odd
  // set count shows the half-set credit
  const p = fixture.workouts[0];
  const three = loadWorkouts([{ ...p, exerciseData: [{ ...p.exerciseData[0], setsData: p.exerciseData[0].setsData.slice(0, 3) }] }]);
  assert.deepEqual(three["2026-05-30"].wmus, { chest: 3, triceps: 1.5, shoulders: 1.5 });
  // an unknown exercise name counts as unclassified, not as a muscle
  const odd = loadWorkouts([{ ...p, exerciseData: [{ ...p.exerciseData[0], exerciseName: "Battle Ropes" }] }]);
  assert.equal(odd["2026-05-30"].wunc, 4);
  assert.deepEqual(odd["2026-05-30"].wmus, {});
});

test("loadWorkouts: wex records the set behind e1 (e1w x e1r), which need not be the heaviest set", () => {
  for (const r of Object.values(workouts)) {
    for (const e of r.wex) {
      assert.ok(e.e1w > 0 && e.e1r > 0, e.n);
      assert.equal(+(e.e1w * (1 + e.e1r / 30)).toFixed(1), e.e1, e.n);
      assert.ok(e.e1w <= e.mw, e.n);
    }
  }
  // a lighter set with more reps gives the e1RM while the heavier set stays the top set
  const p = fixture.workouts[0];
  const ex = { exerciseName: "Test Press", exerciseTypes: "WR", setsData: [
    { inputOne: "80", inputTwo: "3", setType: "normal" },
    { inputOne: "70", inputTwo: "10", setType: "normal" },
  ] };
  const one = loadWorkouts([{ ...p, id: "post-x", exerciseData: [ex] }]);
  const e = Object.values(one)[0].wex.find((w) => w.n === "Test Press");
  assert.equal(e.mw, 80); assert.equal(e.mr, 3);
  assert.equal(e.e1w, 70); assert.equal(e.e1r, 10);
  assert.equal(e.e1, 93.3);
});

test("effortState: rep drop-off at a fixed load maps to a coarse state, never a number", () => {
  assert.equal(effortState([[60, 12], [60, 10], [60, 8]]), "near failure");        // 8/12 = 0.67 <= 0.75
  assert.equal(effortState([[60, 10], [60, 10], [60, 10]]), "capped");              // a rep target
  assert.equal(effortState([[60, 10], [65, 9], [70, 8]]), "not computable");        // loads vary
  assert.equal(effortState([[60, 10], [60, 9], [65, 8]]), "not computable");        // only 2 at one load
  assert.equal(effortState([[60, 12], [60, 10]]), "not computable");                // under 3 working sets
  assert.equal(effortState([]), "not computable");
  assert.equal(effortState([[60, 10], [60, 9], [60, 9], [60, 8]]), "moderate");     // 4 sets, 0.8 <= 0.85
  assert.equal(effortState([[60, 10], [60, 9], [60, 9]]), "moderate");              // 3 sets, 0.9 <= 0.90
  assert.equal(effortState([[60, 11], [60, 10], [60, 10]]), "easy");               // 3 sets, 0.91 above 0.90
  assert.equal(effortState([[60, 10], [60, 10], [60, 9], [60, 9]]), "easy");        // 4 sets, 0.9 above 0.85
  assert.equal(effortState([[60, 10], [60, 9], [60, 8], [60, 6]]), "near failure"); // 4 sets, 0.6 <= 0.65
  // a top set plus three back-off sets: the back-off load carries the run
  assert.equal(effortState([[80, 5], [60, 12], [60, 10], [60, 8]]), "near failure");
  for (const st of ["near failure", "moderate", "easy", "capped", "not computable"]) assert.ok(EFFORT_STATES.includes(st));
});

test("loadWorkouts: wef gives one effort state per wex entry, warm-ups excluded, on lifting days only", () => {
  assert.ok(WKEYS.includes("wef"));
  for (const r of Object.values(workouts)) {
    assert.ok(Array.isArray(r.wef), "wef on a lifting day");
    assert.equal(r.wef.length, r.wex.length);
    for (const st of r.wef) assert.ok(EFFORT_STATES.includes(st), st);
  }
  const p = fixture.workouts[0];
  const ex = p.exerciseData[0];
  const mk = (sets) => loadWorkouts([{ ...p, exerciseData: [{ ...ex, setsData: sets }] }])["2026-05-30"];
  const set = (kg, reps, setType = "normal") => ({ ...ex.setsData[1], inputOne: String(kg), inputTwo: reps, setType, rir: null });
  // a warm-up at the working load does not join the run: without it 12/10/8 reads near failure
  assert.deepEqual(mk([set(60, 15, "warmup"), set(60, 12), set(60, 10), set(60, 8)]).wef, ["near failure"]);
  // and a warm-up is not a working set: two working sets stay not computable
  assert.deepEqual(mk([set(60, 12, "warmup"), set(60, 12), set(60, 8)]).wef, ["not computable"]);
  assert.deepEqual(mk([set(60, 10), set(60, 10), set(60, 10)]).wef, ["capped"]);
  assert.deepEqual(mk([set(60, 10), set(65, 9), set(70, 8)]).wef, ["not computable"]);
  assert.deepEqual(mk([set(60, 10), set(60, 9), set(60, 9), set(60, 8)]).wef, ["moderate"]);
  // the fixture's chest press: warm-up 36x10 then 60x9, 60x9, 60x10 -> the run rises, easy
  assert.equal(workouts["2026-05-30"].wef[0], "easy");
  // e1RM is untouched by the effort read
  assert.equal(mk([set(60, 12), set(60, 10), set(60, 8)]).wex[0].e1, 84);
  // cardio-only day: no wsr, no wef
  const cardio = loadWorkouts([{ ...p, exerciseData: [{ ...ex, exerciseTypes: "DD", setsData: [{ ...ex.setsData[1], inputOne: 0, inputTwo: 600 }] }] }])["2026-05-30"];
  assert.equal("wef" in cardio, false);
});

const days = mergeDays(fixture.ring, workouts, fixture.screentime);
const byD = Object.fromEntries(days.map((d) => [d.d, d]));

test("mergeDays: ring-only day keeps the ring fields, trained = 0", () => {
  const d = byD["2026-05-27"];
  assert.equal(d.score, fixture.ring["2026-05-27"].score);
  assert.equal(d.trained, 0);
  assert.equal(d.wsets, undefined);
  assert.equal(d.pc, fixture.screentime["2026-05-27"].pc);
});

test("mergeDays: lift-only day (ring was charging) gets a minimal record", () => {
  assert.equal(fixture.ring["2026-06-20"], undefined);
  const d = byD["2026-06-20"];
  assert.equal(d.score, undefined);
  assert.equal(d.wd, "Sat");
  assert.equal(d.trained, 1);
  assert.ok(d.wsets > 0);
});

test("mergeDays: a day with both, list sorted and complete", () => {
  const d = byD["2026-05-30"];
  assert.equal(typeof d.score, "number");
  assert.equal(d.trained, 1);
  assert.equal(d.wsets, 12);
  assert.deepEqual(d.wsr, workouts["2026-05-30"].wsr);
  assert.equal("wsr" in byD["2026-05-27"], false);
  assert.deepEqual(days.map((x) => x.d), [...days.map((x) => x.d)].sort());
  assert.equal(days.length, 35);
});
