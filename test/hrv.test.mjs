import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixture.json";
import { mergeDays, loadWorkouts, minimalRec, HRV_ROLL_MIN, HRV_BASE_MIN } from "../src/pipeline/summarize.js";
import { computeBrief, hrvState, HRV_BAND_SD } from "../src/pipeline/brief.js";
import { renderPage } from "../src/pipeline/render.js";
import { addDays } from "../src/pipeline/util.js";

// 90 synthetic nights, HRV wobbling around 65 ms with no trend (nothing from .dev-data)
function series(n, lastHrv) {
  const ring = {};
  for (let i = 0; i < n; i++) {
    const d = addDays("2026-03-01", i);
    const hrv = i === n - 1 && lastHrv != null ? lastHrv : 65 + 8 * Math.sin(i * 1.3) + (i % 3);
    ring[d] = { ...minimalRec(d), score: 80, rec: 70, slh: 7.2, hrv, rhr: 55, bedRel: -1, wakeRel: 6 };
  }
  return ring;
}
const days = mergeDays(series(90), {}, {});
const today = days[days.length - 1].d;

test("addHrvFields: hrvLn is ln(hrv); hrv7 needs 4 recorded nights, hrvBase/hrvSd need 20 before the 7-night window", () => {
  assert.equal(HRV_ROLL_MIN, 4);
  assert.equal(HRV_BASE_MIN, 20);
  for (const x of days) assert.ok(Math.abs(x.hrvLn - Math.log(x.hrv)) < 1e-3, x.d);
  assert.equal(days[2].hrv7, null);                 // 3 nights so far
  assert.notEqual(days[3].hrv7, null);              // 4 nights
  assert.notEqual(days[6].hrv7, null);              // a full 7-night window
  assert.ok(Math.abs(days[6].hrv7 - days.slice(0, 7).reduce((a, x) => a + x.hrvLn, 0) / 7) < 1e-3);
  assert.equal(days[25].hrvBase, null);             // window is nights 19..25: only 19 before it
  assert.equal(days[25].hrvSd, null);
  assert.notEqual(days[26].hrvBase, null);          // window 20..26: 20 nights before it
  assert.ok(days[26].hrvSd > 0);
  const last = days[days.length - 1];
  const win = days.slice(-7).map((x) => x.hrvLn), base = days.slice(-67, -7).map((x) => x.hrvLn);
  assert.equal(base.length, 60);
  assert.ok(Math.abs(last.hrv7 - win.reduce((a, b) => a + b, 0) / 7) < 1e-3);
  assert.ok(Math.abs(last.hrvBase - base.reduce((a, b) => a + b, 0) / 60) < 1e-3);
});

test("addHrvFields: nights without HRV get no log fields and do not count as recorded", () => {
  const ring = series(10);
  const k = Object.keys(ring).sort();
  ring[k[4]].hrv = null;
  const out = mergeDays(ring, {}, {});
  assert.ok(!("hrvLn" in out[4]) && !("hrv7" in out[4]));
  assert.equal(out[3].hrv7 == null, false);
  // night 5 (index 5) has only 5 recorded nights before it plus itself, all used
  assert.ok(Math.abs(out[5].hrv7 - [0, 1, 2, 3, 5].reduce((a, i) => a + out[i].hrvLn, 0) / 5) < 1e-3);
});

test("hrvState: in the band at the baseline, above well over it, below well under it, null without a baseline", () => {
  assert.equal(HRV_BAND_SD, 0.5);
  const b = days[days.length - 1];
  const at = mergeDays(series(90, Math.exp(b.hrvBase)), {}, {});
  const atLast = at[at.length - 1];
  assert.equal(atLast.hrvBase, b.hrvBase, "the baseline excludes the night itself");
  assert.equal(hrvState(atLast), "in");
  assert.equal(computeBrief(at, today).sleep.hrvState, "in");
  const up = mergeDays(series(90, Math.exp(b.hrvBase + 3 * b.hrvSd)), {}, {});
  assert.equal(hrvState(up[up.length - 1]), "above");
  assert.equal(computeBrief(up, today).sleep.hrvState, "above");
  const down = mergeDays(series(90, Math.exp(b.hrvBase - 3 * b.hrvSd)), {}, {});
  assert.equal(hrvState(down[down.length - 1]), "below");
  assert.equal(hrvState(days[10]), null);
  assert.equal(hrvState(null), null);
  const early = mergeDays(series(15), {}, {});
  assert.equal(computeBrief(early, early[14].d).sleep.hrvState, null);
});

test("computeBrief: the fixture (32 nights, 25 before the window) carries hrv in ms plus a band state", () => {
  const fx = mergeDays(fixture.ring, loadWorkouts(fixture.workouts), fixture.screentime);
  const b = computeBrief(fx, "2026-06-30");
  assert.equal(typeof b.sleep.hrv, "number");
  assert.ok(["below", "in", "above"].includes(b.sleep.hrvState), b.sleep.hrvState);
  assert.equal(typeof b.sleep.hrvBase, "number");
  assert.ok(b.sleep.hrvSd > 0);
  assert.equal(b.sleep.hrvState, hrvState(fx[fx.length - 1]));
});

test("renderPage: the HRV chart is drawn against his own band and says it is not a training call", () => {
  const users = [{ id: "syn", name: "Synthetic Person", workouts: null }];
  const brief = computeBrief(days, today);
  const { html } = renderPage({ users, datasets: { syn: days }, briefs: { syn: brief }, narratives: {}, today, now: Date.parse(today + "T19:00:00Z") });
  assert.ok(html.includes("your band"));
  assert.ok(html.includes("Your own band: 60-night baseline, half a night-to-night SD either side."));
  assert.ok(html.includes("This chart is a record of past nights."));
  assert.ok(html.includes('"hrvState":"'), "state embedded in the brief");
  assert.ok(html.includes('"hrvBase":'), "baseline embedded in the day data");
  for (const bad of ["undefined", "NaN"]) assert.ok(!html.includes(bad), bad);
});
