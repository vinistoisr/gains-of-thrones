import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixture.json";
import { loadWorkouts, mergeDays } from "../src/pipeline/summarize.js";
import { muscleGroup, computeBrief, liftTrend, tCrit95, usualLiftDays, NEED_H, PUSH_LOW_SETS, SET_MIN_RETURN, SET_HIGH_FROM, SET_VERY_HIGH_FROM, setStatus, weeklySets, setsRead,
  makePlan, planSentence, evaluatePlan, streak4, PLAN_TARGET } from "../src/pipeline/brief.js";
import { weekday, addDays, median, pyRound } from "../src/pipeline/util.js";
import { weeklyFacts } from "../src/pipeline/ai.js";

test("muscleGroup: known exercise names map to their group", () => {
  const cases = {
    "Cable Chest Press": "chest", "Bench Press": "chest",
    "Seated Cable Row": "back", "Lat Pulldown": "back",
    "Shoulder Press": "shoulders", "Lateral Raise": "shoulders",
    "Dumbbell Curl": "biceps", "Tricep Pushdown": "triceps",
    "Leg Press": "quads", "Barbell Squat": "quads",
    "Romanian Deadlift": "hamstrings/glutes", "Standing Calf Raise": "calves",
    "Face Pull": "shoulders", "Plank": "core",
  };
  for (const [name, group] of Object.entries(cases)) assert.equal(muscleGroup(name), group, name);
});

test("muscleGroup: first rule wins, unknown names are other", () => {
  assert.equal(muscleGroup("Leg Curl"), "hamstrings/glutes");   // not biceps
  assert.equal(muscleGroup("Wrist Curl"), "forearms");
  assert.equal(muscleGroup("Leg Extension"), "quads");
  assert.equal(muscleGroup("Battle Ropes"), "other");
});

test("muscleGroup: 'machine' does not match the chin token; chest-supported rows stay back", () => {
  assert.equal(muscleGroup("Machine Chest Fly"), "chest");
  assert.equal(muscleGroup("Chest Press Machine"), "chest");
  assert.equal(muscleGroup("Incline Machine Press"), "chest");
  assert.equal(muscleGroup("Chin Up"), "back");
  assert.equal(muscleGroup("Chest Supported Row"), "back");
  assert.equal(muscleGroup("Iso-Lateral High Row"), "back");
  assert.equal(muscleGroup("Face Pull"), "shoulders");           // rear delts count as shoulders, like the body map
});

const today = "2026-06-30";
const days = mergeDays(fixture.ring, loadWorkouts(fixture.workouts), fixture.screentime);
const brief = computeBrief(days, today);

test("computeBrief: the keys the Today card reads", () => {
  for (const k of ["hasSleep", "sleep", "bedtime", "ring", "training", "actions", "push"]) assert.ok(k in brief, k);
  assert.equal(brief.hasSleep, true);
  for (const k of ["fresh", "needH", "shortNights14", "nights14", "hoursBelow14", "short7", "nights7"]) assert.ok(k in brief.sleep, "sleep." + k);
  for (const k of ["target", "wake", "wakeDayType", "screensOff"]) assert.equal(typeof brief.bedtime[k], "string", "bedtime." + k);
  for (const k of ["sessions7", "sessionsWkAvg28", "target", "groups"]) assert.ok(k in brief.training, "training." + k);
  assert.ok(Array.isArray(brief.actions));
  assert.ok(brief.actions.length <= 3);
  for (const a of brief.actions) { assert.equal(typeof a.tag, "string"); assert.equal(typeof a.text, "string"); }
  assert.ok("morning" in brief.push && "evening" in brief.push);
});

test("computeBrief: short-night counts are built from recorded nights in the last 14 calendar days", () => {
  const s = brief.sleep;
  for (const k of ["shortNights14", "nights14", "hoursBelow14"]) assert.equal(typeof s[k], "number", k);
  assert.equal(NEED_H, 7);
  assert.equal(s.needH, NEED_H);
  assert.ok(s.nights14 <= 14, "nights14 <= 14");
  assert.ok(s.shortNights14 <= s.nights14, "shortNights14 <= nights14");
  assert.ok(s.hoursBelow14 >= 0);
  // independent recount straight from the fixture ring records
  const age = (d) => Math.round((Date.parse(today) - Date.parse(d)) / 86400000);
  const win = Object.entries(fixture.ring).filter(([d, r]) => r.slh != null && age(d) >= 0 && age(d) < 14).map(([, r]) => r);
  assert.equal(s.nights14, win.length);
  assert.equal(s.shortNights14, win.filter((r) => r.slh < NEED_H).length);
  assert.equal(s.hoursBelow14, +win.reduce((a, r) => a + Math.max(0, NEED_H - r.slh), 0).toFixed(1));
});

test("computeBrief: a long night never repays a short one", () => {
  // alternate 9h and 5h over the last 14 calendar days: only the 5h nights count, 2h each
  let i = 0;
  const tweaked = days.map((d) => {
    if (d.score == null || Math.round((Date.parse(today) - Date.parse(d.d)) / 86400000) >= 14) return d;
    return { ...d, slh: i++ % 2 ? 5 : 9 };
  });
  const s = computeBrief(tweaked, today).sleep;
  const fives = Math.floor(i / 2);
  assert.equal(s.nights14, i);
  assert.equal(s.shortNights14, fives);
  assert.equal(s.hoursBelow14, fives * 2);
});

test("computeBrief: nothing is called debt any more; the bedtime nudge says how many nights were recorded", () => {
  assert.ok(!/debt/i.test(JSON.stringify(brief)), "no debt in the brief");
  assert.ok(brief.push.evening.body.includes("recorded nights under 7h"), brief.push.evening.body);
  assert.ok(brief.push.evening.body.length <= 240);
});

test("weeklyFacts: reads the new sleep numbers, not debt14", () => {
  const f = weeklyFacts(days, brief, today);
  assert.equal(f.short_nights_last_14_days, brief.sleep.shortNights14);
  assert.equal(f.nights_recorded_last_14_days, brief.sleep.nights14);
  assert.equal(f.hours_under_7h_last_14_days, brief.sleep.hoursBelow14);
  assert.equal(typeof f.this_week.nights_under_7h, "number");
  assert.ok(!/debt/i.test(JSON.stringify(f)), "no debt in the facts");
});

test("computeBrief: training.groups lists the 8 main muscle groups", () => {
  assert.ok(Array.isArray(brief.training.groups));
  const names = brief.training.groups.map((g) => g.group);
  for (const g of ["chest", "back", "shoulders", "biceps", "triceps", "quads", "hamstrings/glutes", "calves"]) assert.ok(names.includes(g), g);
  assert.ok(!names.includes("rear delts/rotators"), "rear delts are folded into shoulders");
  for (const g of brief.training.groups) {
    assert.equal(typeof g.sets7, "number", g.group);
    assert.ok(["ok", "low", "none", "high", "very high", "info"].includes(g.status), g.group);
  }
});

test("computeBrief: a group with no sets this week is 'none', even when it was trained earlier in the month", () => {
  // fixture: chest was last trained 10 days before today, so sets7 = 0 while the 28-day average is above 0
  const chest = brief.training.groups.find((g) => g.group === "chest");
  assert.equal(chest.sets7, 0);
  assert.ok(chest.setsWkAvg28 > 0);
  assert.equal(chest.status, "none");
  const back = brief.training.groups.find((g) => g.group === "back");
  assert.equal(back.sets7, 8);                                     // Seated Cable Row 4 + Lat Pulldown 4, no chest press counted as back
  for (const g of brief.training.groups) if (g.fsets7 === 0 && g.status !== "info") assert.equal(g.status, "none", g.group);
});
// ---- morning push rules. The fixture lifts on 5 Saturdays, 3 Tuesdays and 1
// Wednesday in the 8 weeks before 2026-06-30 (a Tuesday), and chest has 0 sets
// in the last 7 days.
const lifts = days.filter((d) => (d.wvol || 0) > 0);
const shift = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

test("usualLiftDays: the busiest two or three weekdays of the last 8 weeks, never a one-off", () => {
  const wd = usualLiftDays(lifts, today);
  assert.deepEqual(wd, [5, 1]);                 // Saturday, Tuesday; the single Wednesday does not count
  assert.ok(wd.includes(weekday(today)), "2026-06-30 is a Tuesday");
});

test("computeBrief: a planned lifting day yields a morning push carrying the week's plan sentence", () => {
  const m = brief.push.morning;
  assert.ok(m, "morning push present");
  assert.equal(m.tag, "morning-lift");
  assert.equal(m.title, "Lifting day");
  // Tuesday is a planned day (usual days Tue and Sat), so rule (a) carries the plan sentence, not its own text
  assert.equal(m.body, brief.training.plan.push);
  assert.match(m.body, /^Calves 0.* sets in the last 7 days. Add .*3 sets of a calf exercise.* on Tue and Sat.$/);
  assert.ok(brief.training.groups.find((g) => g.group === "chest").fsets7 < PUSH_LOW_SETS);
  assert.ok(!/\u2014/.test(m.title + m.body), "no em dash");
  assert.ok(m.body.split(/[.!?]\s/).length <= 2, "one or two sentences");
});

test("computeBrief: a day no rule fires yields push.morning === null", () => {
  // 2026-07-01 is a Wednesday (one session in 8 weeks, not a usual day); the
  // last session was 4 days earlier and last night's ring numbers are ordinary
  const b = computeBrief(days, "2026-07-01");
  assert.strictEqual(b.push.morning, null);
  assert.ok(b.push.evening, "the bedtime nudge is unaffected");
});

test("computeBrief: resting HR more than 1.5 SD above its trailing mean two nights running yields the ring text", () => {
  const nights = days.filter((d) => d.score != null);
  const base = nights.slice(0, -2).map((n) => n.rhr);
  const mu = base.reduce((a, b) => a + b, 0) / base.length;
  const sd = Math.sqrt(base.reduce((a, b) => a + (b - mu) ** 2, 0) / base.length);
  const hi = Math.round(mu + 3 * sd);
  const lastTwo = new Set(nights.slice(-2).map((n) => n.d));
  const tweaked = days.map((d) => (lastTwo.has(d.d) ? { ...d, rhr: hi } : d));
  const b = computeBrief(tweaked, "2026-07-01");   // no lifting-day rule that day, so the ring rule stands alone
  const m = b.push.morning;
  assert.ok(m, "morning push present");
  assert.equal(m.tag, "morning-ring");
  assert.equal(m.body, `Resting HR has been high two nights running (${hi} and ${hi} vs your usual ${Math.round(mu)}).`);
  // the same numbers one night only: nothing
  const one = days.map((d) => (d.d === nights[nights.length - 1].d ? { ...d, rhr: hi } : d));
  assert.strictEqual(computeBrief(one, "2026-07-01").push.morning, null);
});

test("computeBrief: the ring rule wins the title and the lifting-day sentence is appended", () => {
  const nights = days.filter((d) => d.score != null);
  const lastTwo = new Set(nights.slice(-2).map((n) => n.d));
  const tweaked = days.map((d) => (lastTwo.has(d.d) ? { ...d, rhr: 90 } : d));
  const m = computeBrief(tweaked, today).push.morning;
  assert.equal(m.tag, "morning-ring");
  assert.deepEqual(m.rules, ["ring", "lift"]);
  assert.match(m.body, /^Resting HR has been high two nights running (.*). Calves 0.* sets in the last 7 days. Add .*3 sets of a calf exercise.* on Tue and Sat.$/);
  assert.ok(m.body.length <= 240);
});

test("computeBrief: a first record on a lift in 60+ days, logged yesterday, yields the PR text", () => {
  // move the whole fixture history back so the lift has been logged for more
  // than 60 days, then add a session yesterday that beats every prior Leg Press
  const back = 70;
  const older = days.map((d) => ({ ...d, d: shift(d.d, -back) }));
  const yday = shift(today, -1);
  const session = { d: yday, wvol: 3000, wsets: 6, wex: [{ n: "Leg Press", v: 3000, s: 3, mw: 160, mr: 10, e1: 213.3 }], wprNames: ["Leg Press 160x10"], wrankNames: [] };
  const ring = days[days.length - 1];
  const withPr = [...older, { ...ring, d: shift(today, -2) }, { ...ring, d: yday, ...session }];
  const m = computeBrief(withPr, today).push.morning;
  assert.ok(m, "morning push present");
  assert.equal(m.tag, "morning-pr");
  assert.equal(m.body, "First PR on Leg Press in 60+ days: 160 lb x 10.");
  // the same session when Leg Press had a record 3 days before it: nothing
  const recent = [...older, { ...ring, d: shift(today, -4), wvol: 100, wsets: 1, wex: [{ n: "Leg Press", v: 100, s: 1, mw: 100, mr: 1, e1: 100 }], wprNames: ["Leg Press 100x1"] }, { ...ring, d: yday, ...session }];
  assert.strictEqual(computeBrief(recent, today).push.morning, null);
});

test("computeBrief: the bedtime nudge is dropped while the last 3 bedtimes sit within 20 minutes of the target", () => {
  const [hh, mm] = brief.bedtime.target.split(":").map(Number);
  const h = hh + mm / 60, targetRel = h > 12 ? h - 24 : h;
  const nights = days.filter((d) => d.score != null);
  const last3 = new Set(nights.slice(-3).map((n) => n.d));
  const held = days.map((d) => (last3.has(d.d) ? { ...d, bedRel: targetRel + 0.15 } : d));   // 9 minutes late
  const b = computeBrief(held, today);
  assert.strictEqual(b.push.evening, null);
  assert.equal(b.push.eveningHolding, true);
  const slipped = held.map((d) => (d.d === nights[nights.length - 1].d ? { ...d, bedRel: targetRel + 0.6 } : d));   // 36 minutes late
  assert.ok(computeBrief(slipped, today).push.evening, "one late night brings the nudge back");
});


test("computeBrief: fractional counts sit beside the direct ones and status is banded on them", () => {
  const MAIN = ["chest", "back", "shoulders", "biceps", "triceps", "quads", "hamstrings/glutes", "calves"];
  for (const g of brief.training.groups) {
    assert.equal(typeof g.fsets7, "number", g.group);
    assert.equal(typeof g.fsetsWkAvg28, "number", g.group);
    assert.ok(g.fsets7 >= g.sets7, `${g.group}: fsets7 ${g.fsets7} >= sets7 ${g.sets7}`);
    assert.ok(g.fsetsWkAvg28 >= g.setsWkAvg28, `${g.group}: fsetsWkAvg28 ${g.fsetsWkAvg28} >= setsWkAvg28 ${g.setsWkAvg28}`);
    if (g.status !== "info") assert.equal(g.status, setStatus(g.fsets7), g.group);
  }
  const by = Object.fromEntries(brief.training.groups.map((g) => [g.group, g]));
  for (const g of MAIN) assert.ok(by[g], g);
  // last 7 days of the fixture: pull day (row 4, pulldown 4, curl 4) and leg day (leg press 4, RDL 4)
  assert.equal(by.back.sets7, 8); assert.equal(by.back.fsets7, 8);
  assert.equal(by.biceps.sets7, 4); assert.equal(by.biceps.fsets7, 8);          // 4 direct + 0.5 x 8 pulling sets
  assert.equal(by.shoulders.sets7, 0); assert.equal(by.shoulders.fsets7, 4);    // rear delts from the 8 pulling sets
  assert.equal(by.shoulders.status, "ok");                                      // 0 direct is not "none" when assists exist; 4 fractional reaches the 4-set line
  assert.equal(by.quads.sets7, 4); assert.equal(by.quads.fsets7, 4);
  assert.equal(by["hamstrings/glutes"].sets7, 4); assert.equal(by["hamstrings/glutes"].fsets7, 6);   // RDL 4 + 0.5 x 4 leg press
  assert.equal(by.chest.fsets7, 0); assert.equal(by.chest.status, "none");
});

test("computeBrief: no sleep data at all", () => {
  const b = computeBrief([], today);
  assert.equal(b.hasSleep, false);
  assert.deepEqual(b.push, {});
});

test("computeBrief: no hardcoded physiology claims in the output", () => {
  const text = JSON.stringify(brief);
  for (const s of ["18%", "4.6 score", "protein synthesis", "easing training"]) assert.ok(!text.includes(s), `found "${s}"`);
  // the fixture has enough hours under 7h to take the 14-day sleep branch, so the check is not vacuous
  assert.ok(brief.sleep.hoursBelow14 >= 5, `hoursBelow14 ${brief.sleep.hoursBelow14}`);
  const sleep = brief.actions.find((a) => a.tag === "sleep");
  assert.ok(sleep, "sleep action present");
  assert.match(sleep.text, /^\d+(\.\d)?h under 7h across \d+ of \d+ recorded nights in the last 14 days\.$/);
  // the untrained action words its set numbers the way claims.js does (sets-growth-range, sets-maintenance-dose)
  const training = brief.actions.find((a) => a.tag === "training" && /^No sets for /.test(a.text));
  assert.ok(training, "untrained action present");
  assert.match(training.text, /Most of the growth per set comes between 4 and 10 fractional sets a week; about a third of your usual volume holds size, and none at all loses it\.$/);
  assert.ok(!/10 to 20|growth range/.test(JSON.stringify(brief)), "old 10-20 wording gone");
  assert.ok(!/only maintains|needs ~10/.test(training.text), training.text);
});

test("computeBrief: ring gap is measured from the last missing night, not the start of the gap run", () => {
  // 20 recorded-or-missing nights ending the day before today, built from one
  // fixture ring record; "recorded" means score != null, the same test the
  // page's 28-night coverage strip uses. Missing: Jun 14, Jun 18 and a 3-night
  // run Jun 24-26 that ends 4 days before today (2026-06-30).
  const base = fixture.ring["2026-05-27"];
  const missing = new Set(["2026-06-14", "2026-06-18", "2026-06-24", "2026-06-25", "2026-06-26"]);
  const series = [];
  for (let i = 20; i >= 1; i--) {
    const d = new Date(Date.parse(today) - i * 86400000).toISOString().slice(0, 10);
    series.push(missing.has(d) ? { d, score: null, slh: null } : { ...base, d });
  }
  const b = computeBrief(series, today);
  assert.equal(b.ring.missingNights, 5);
  assert.equal(b.ring.sinceGapDays, 4);          // from Jun 26, not 6 from Jun 24
  assert.equal(b.ring.cadenceDays, 5);           // gap starts Jun 14, 18, 24: spacings 4 and 6
  assert.equal(b.ring.chargeDue, true);
  const ring = b.actions.find((a) => a.tag === "ring");
  assert.ok(ring, "ring action present");
  assert.match(ring.text, /^Charge the ring tonight: 4 days since it last missed a night, and it usually needs charging every 5 days or so./);
  assert.match(b.push.evening.body, /Charge the ring first \(4 days since the last missing night\)\.$/);
  // every other night missing (cadence 2) with the last gap yesterday: due, and singular
  const odd = new Set(["2026-06-21", "2026-06-23", "2026-06-25", "2026-06-27", "2026-06-29"]);
  const s1 = series.map((n) => (odd.has(n.d) ? { d: n.d, score: null, slh: null } : missing.has(n.d) ? { ...base, d: n.d } : n));
  const b1 = computeBrief(s1, today);
  assert.equal(b1.ring.sinceGapDays, 1);
  assert.equal(b1.ring.chargeDue, true);
  assert.match(b1.actions.find((a) => a.tag === "ring").text, /^Charge the ring tonight: 1 day since it last missed a night/);
  assert.match(b1.push.evening.body, /\(1 day since the last missing night\)\.$/);
});

// ---- lift trend (item 21): OLS slope of best-set e1RM with a 95% CI, not a 2% bucket ----
const sessionsFrom = (vals, step = 4, start = "2026-04-01") =>
  vals.map((e1, i) => ({ d: new Date(Date.parse(start) + i * step * 86400000).toISOString().slice(0, 10), e1 }));

test("liftTrend: 8 sessions with a clear upward trend are 'stronger'", () => {
  const t = liftTrend(sessionsFrom([90, 92, 91, 94, 96, 95, 98, 100]));
  assert.equal(t.n, 8);
  assert.equal(t.state, "stronger");
  assert.ok(t.slopePerWeek > 0 && t.ci[0] > 0 && t.ci[1] > t.ci[0], JSON.stringify(t));
  assert.equal(t.e1Prev, 90); assert.equal(t.e1Now, 100);
  assert.equal(t.resid.length, 8);
  for (const r of t.resid) { assert.match(r.d, /^\d{4}-\d{2}-\d{2}$/); assert.equal(typeof r.z, "number"); }
});

test("liftTrend: a flat noisy series is 'flat'", () => {
  const t = liftTrend(sessionsFrom([95, 98, 93, 97, 94, 99, 92, 96, 95, 97]));
  assert.equal(t.state, "flat");
  assert.ok(t.ci[0] < 0 && t.ci[1] > 0, JSON.stringify(t.ci));
});

test("liftTrend: a clear downward trend is 'weaker'", () => {
  const t = liftTrend(sessionsFrom([100, 98, 99, 96, 94, 95, 92, 90]));
  assert.equal(t.state, "weaker");
  assert.ok(t.ci[1] < 0, JSON.stringify(t.ci));
});

test("liftTrend: one extra rep once in 8 sessions is not a trend", () => {
  // 78x8 = 98.8 every session, one 78x9 = 101.4 (the case that flipped the old 2% bucket)
  const t = liftTrend(sessionsFrom([98.8, 98.8, 98.8, 98.8, 98.8, 98.8, 101.4, 98.8]));
  assert.equal(t.state, "flat");
});

test("liftTrend: 5 sessions is 'not enough sessions'", () => {
  const t = liftTrend(sessionsFrom([90, 92, 94, 96, 98]));
  assert.equal(t.n, 5);
  assert.equal(t.state, "not enough sessions");
  assert.equal(typeof t.slopePerWeek, "number");   // the fit is still there for the tooltip, only the state is withheld
});

test("liftTrend: residual z values have mean ~0 and unit scale", () => {
  const t = liftTrend(sessionsFrom([90, 95, 91, 97, 93, 99, 94, 101, 96, 102, 97, 105]));
  const z = t.resid.map((r) => r.z);
  const m = z.reduce((a, b) => a + b, 0) / z.length;
  assert.ok(Math.abs(m) < 0.05, "mean " + m);
  const sd = Math.sqrt(z.reduce((a, v) => a + (v - m) ** 2, 0) / (z.length - 2));
  assert.ok(Math.abs(sd - 1) < 0.05, "sd " + sd);
});

test("tCrit95: lookup for small df, 1.96 beyond 30", () => {
  assert.equal(tCrit95(4), 2.776);
  assert.equal(tCrit95(10), 2.228);
  assert.equal(tCrit95(30), 2.042);
  assert.equal(tCrit95(31), 1.96);
});

test("computeBrief: progress carries the trend fields and progUp/Flat/Down/NA add up", () => {
  const t = brief.training;
  assert.ok(Array.isArray(t.progress));
  for (const p of t.progress) {
    for (const k of ["lift", "n", "slopePerWeek", "ci", "state", "e1Now", "e1Prev", "resid", "pct"]) assert.ok(k in p, p.lift + "." + k);
    assert.ok(["stronger", "flat", "weaker", "not enough sessions"].includes(p.state), p.state);
  }
  assert.equal(t.progUp + t.progFlat + t.progDown + t.progNA, t.progress.length);
  // the fixture has 3 sessions per lift, so every lift is short of the 6-session floor
  assert.equal(t.progNA, t.progress.length);
  assert.ok(t.progress.length > 0);
});

test("computeBrief: eight rising sessions of one lift inside 90 days count as stronger", () => {
  const extra = sessionsFrom([90, 92, 91, 94, 96, 95, 98, 100], 7, "2026-04-20").map(({ d, e1 }) => ({
    d, wvol: 1000, wsets: 4, wex: [{ n: "Trend Press", v: 1000, s: 4, mw: 80, mr: 8, e1, e1w: 80, e1r: 8 }],
  }));
  const merged = [...days.filter((d) => !extra.some((e) => e.d === d.d)), ...extra].sort((a, b) => (a.d < b.d ? -1 : 1));
  const t = computeBrief(merged, today).training;
  const p = t.progress.find((x) => x.lift === "Trend Press");
  assert.equal(p.state, "stronger");
  assert.equal(p.n, 8);
  assert.equal(t.progUp, 1);
  assert.equal(t.progress[0].lift, "Trend Press", "stronger/weaker lifts sort ahead of not-enough-sessions ones");
});

test("computeBrief: each progress entry carries effort counts and training.effortSummary sums the last 28 days", () => {
  const t = brief.training;
  for (const p of t.progress) {
    assert.ok(p.effort, p.lift + ".effort");
    for (const k of ["n", "nearFailure", "moderate", "easy", "capped"]) assert.ok(Number.isInteger(p.effort[k]) && p.effort[k] >= 0, p.lift + ".effort." + k);
    assert.equal(p.effort.n, p.effort.nearFailure + p.effort.moderate + p.effort.easy + p.effort.capped, p.lift);
    assert.ok(p.effort.n <= p.n, p.lift + ": no more reads than sessions");
  }
  const es = t.effortSummary;
  for (const k of ["sessions", "computable", "nearFailure", "moderate", "easy", "capped"]) assert.ok(Number.isInteger(es[k]) && es[k] >= 0, "effortSummary." + k);
  assert.equal(es.computable, es.nearFailure + es.moderate + es.easy + es.capped);
  assert.ok(es.computable <= es.sessions);
  const l28 = days.filter((d) => (d.wvol || 0) > 0 && d.d > "2026-06-02");
  assert.equal(es.sessions, l28.reduce((a, d) => a + d.wex.length, 0), "one entry per exercise-session in the last 28 days");
  if (es.computable) {
    assert.equal(es.hardShare, Math.round((es.nearFailure + es.moderate) / es.computable * 100));
    assert.equal(es.cappedShare, Math.round(es.capped / es.computable * 100));
  } else { assert.equal(es.hardShare, null); assert.equal(es.cappedShare, null); }
  // a lift with wef states set by hand: three near failure, one capped, one unreadable
  const wef = ["near failure", "near failure", "near failure", "capped", "not computable"];
  const extra = sessionsFrom([90, 92, 91, 94, 96], 7, "2026-05-30").map(({ d, e1 }, i) => ({
    d, wvol: 1000, wsets: 3, wex: [{ n: "Effort Press", v: 1000, s: 3, mw: 80, mr: 8, e1, e1w: 80, e1r: 8 }], wef: [wef[i]],
  }));
  const merged = [...days.filter((d) => !extra.some((e) => e.d === d.d)), ...extra].sort((a, b) => (a.d < b.d ? -1 : 1));
  const tt = computeBrief(merged, today).training;
  assert.deepEqual(tt.progress.find((x) => x.lift === "Effort Press").effort, { n: 4, nearFailure: 3, moderate: 0, easy: 0, capped: 1 });
  // days without wef (older pipeline output) read as not computable, never throw
  const bare = computeBrief(days.map((d) => { const { wef: _w, ...r } = d; return r; }), today).training;
  assert.equal(bare.effortSummary.computable, 0);
  assert.equal(bare.effortSummary.hardShare, null);
});

test("weeklyFacts: the trend counts reach the note under 90-day names", () => {
  const f = weeklyFacts(days, brief, today);
  assert.equal(f.training.lifts_stronger_90_day_trend, brief.training.progUp);
  assert.equal(f.training.lifts_weaker_90_day_trend, brief.training.progDown);
  assert.equal(f.training.lifts_with_under_6_sessions, brief.training.progNA);
  assert.ok(!("lifts_up_vs_prior_4_weeks" in f.training));
});

// ---- item 14: one fractional count behind every training threshold ----
test("setStatus: the tiers at 0, 3, 4, 10, 11, 18, 19 fractional sets", () => {
  assert.equal(SET_MIN_RETURN, 4); assert.equal(SET_HIGH_FROM, 11); assert.equal(SET_VERY_HIGH_FROM, 19);
  assert.equal(PUSH_LOW_SETS, SET_MIN_RETURN, "the morning push rule sits on the same line");
  assert.equal(setStatus(0), "none");
  assert.equal(setStatus(3), "low");
  assert.equal(setStatus(4), "ok");
  assert.equal(setStatus(10), "ok");
  assert.equal(setStatus(11), "high");
  assert.equal(setStatus(18), "high");
  assert.equal(setStatus(19), "very high");
  assert.equal(setStatus(3.5), "low");
  assert.equal(setStatus(10.5), "ok");
  // the brief embeds the lines for the page
  assert.equal(brief.training.setMinReturn, 4); assert.equal(brief.training.setHighFrom, 11); assert.equal(brief.training.setVeryHighFrom, 19);
  assert.ok(!("setTarget" in brief.training) && !("setUpper" in brief.training), "old 10/20 fields gone");
});

test("computeBrief: status bands reach 'high' and 'very high' through a week's sessions", () => {
  // one session inside the window: 12 sets of bench (chest 12, triceps 6, shoulders 6) and 8 sets of rows
  // (back 8, biceps 4, shoulders 4), then a second with 20 sets of curls (biceps 24 in total)
  const ring = days[days.length - 1];
  const s1 = { ...ring, d: shift(today, -2), wvol: 5000, wsets: 20, wex: [{ n: "Bench Press", v: 3000, s: 12 }, { n: "Seated Cable Row", v: 2000, s: 8 }] };
  const s2 = { ...ring, d: shift(today, -1), wvol: 2000, wsets: 20, wex: [{ n: "Dumbbell Curl", v: 2000, s: 20 }] };
  const older = days.filter((d) => Math.round((Date.parse(today) - Date.parse(d.d)) / 86400000) >= 7);
  const by = Object.fromEntries(computeBrief([...older, s1, s2], today).training.groups.map((g) => [g.group, g]));
  assert.equal(by.chest.fsets7, 12); assert.equal(by.chest.status, "high");
  assert.equal(by.biceps.fsets7, 24); assert.equal(by.biceps.status, "very high");
  assert.equal(by.shoulders.fsets7, 10); assert.equal(by.shoulders.status, "ok");
  assert.equal(by.triceps.fsets7, 6); assert.equal(by.triceps.status, "ok");
  assert.equal(by.quads.fsets7, 0); assert.equal(by.quads.status, "none");
});

test("computeBrief: the lowest-group pick prefers calves at 0 over a group with 3 direct and 9 fractional sets", () => {
  // this week: bench 12 (chest 12, triceps 6, shoulders 6), pushdown 3 (triceps 3 direct, 9 in total),
  // rows 8 (back 8, biceps 4, shoulders 10), leg press 4 (quads 4, hams 2), RDL 4 (hams 6); calves 0
  const ring = days[days.length - 1];
  const session = { ...ring, d: shift(today, -2), wvol: 9000, wsets: 31, wex: [
    { n: "Bench Press", v: 3000, s: 12 }, { n: "Tricep Pushdown", v: 500, s: 3 }, { n: "Seated Cable Row", v: 2000, s: 8 },
    { n: "Leg Press", v: 3000, s: 4 }, { n: "Romanian Deadlift", v: 500, s: 4 }] };
  const older = days.filter((d) => Math.round((Date.parse(today) - Date.parse(d.d)) / 86400000) >= 7);
  const b = computeBrief([...older, session], today);
  const by = Object.fromEntries(b.training.groups.map((g) => [g.group, g]));
  assert.equal(by.triceps.sets7, 3); assert.equal(by.triceps.fsets7, 9); assert.equal(by.triceps.status, "ok");
  assert.equal(by.calves.fsets7, 0); assert.equal(by.calves.status, "none");
  for (const g of ["chest", "back", "shoulders", "biceps", "quads", "hamstrings/glutes"]) assert.ok(by[g].fsets7 >= SET_MIN_RETURN, g);
  const m = b.push.morning;
  assert.ok(m && m.tag === "morning-lift", "lifting-day push fires on a usual day");
  // Tuesday is a planned day, so the push carries the week's plan, and the plan picks the same lowest group
  assert.equal(b.training.plan.group, "calves");
  assert.equal(m.body, b.training.plan.push);
  assert.ok(!/triceps/i.test(m.body), "triceps at 9 fractional sets is not the lowest group");
  // once this week's plan is done (a stored quads plan met by a Monday leg-press session), rule (a)
  // falls back to its own text and still names calves on the fractional count
  const mon = { ...ring, d: shift(today, -1), wvol: 3000, wsets: 4, wex: [{ n: "Leg Press", v: 3000, s: 4 }] };
  const done = { weeks: [{ weekStart: shift(today, -1), group: "quads", exercise: "Leg Press", sets: 3, target: 4, days: [1, 5], createdAt: shift(today, -1) }] };
  const b2 = computeBrief([...older, session, mon], today, done);
  assert.equal(b2.training.plan.state, "done");
  assert.equal(b2.push.morning.body, "Calves: 0 sets this week counting assists. Add 3 sets today.");
  assert.ok(!/triceps/i.test(b2.push.morning.body), "triceps at 9 fractional sets is not the lowest group");
  // the action text and the focus list use the same line: calves is the only group under it
  assert.match(b.actions.find((a) => a.tag === "training" && /^No sets for /.test(a.text)).text, /^No sets for calves in the last 7 days\./);
  assert.ok(!b.actions.some((a) => /triceps/.test(a.text)), "no action names triceps");
});

test("computeBrief: the 'low' action fires on the fractional count and names the 4-set line", () => {
  // every main group trained, calves with 2 direct sets (2 fractional)
  const ring = days[days.length - 1];
  const session = { ...ring, d: shift(today, -2), wvol: 9000, wsets: 33, wex: [
    { n: "Bench Press", v: 3000, s: 12 }, { n: "Tricep Pushdown", v: 500, s: 3 }, { n: "Seated Cable Row", v: 2000, s: 8 },
    { n: "Leg Press", v: 3000, s: 4 }, { n: "Romanian Deadlift", v: 500, s: 4 }, { n: "Standing Calf Raise", v: 200, s: 2 }] };
  const older = days.filter((d) => Math.round((Date.parse(today) - Date.parse(d.d)) / 86400000) >= 7);
  const b = computeBrief([...older, session], today);
  const by = Object.fromEntries(b.training.groups.map((g) => [g.group, g]));
  assert.equal(by.calves.fsets7, 2); assert.equal(by.calves.status, "low"); assert.equal(by.calves.lastSetDaysAgo, 2);
  const low = b.actions.find((a) => a.tag === "training" && /^Under /.test(a.text));
  assert.ok(low, "low action present");
  assert.equal(low.text, "Under 4 weekly sets counting assists for calves: the small-return band.");
  // planned Tuesday: the plan sentence (named after the calf exercise he has logged) carries the push
  assert.equal(b.training.plan.group, "calves");
  assert.equal(b.push.morning.body, b.training.plan.push);
  // with this week's plan already done, rule (a) reports the fractional count itself
  const mon = { ...ring, d: shift(today, -1), wvol: 3000, wsets: 4, wex: [{ n: "Leg Press", v: 3000, s: 4 }] };
  const done = { weeks: [{ weekStart: shift(today, -1), group: "quads", exercise: "Leg Press", sets: 3, target: 4, days: [1, 5], createdAt: shift(today, -1) }] };
  assert.equal(computeBrief([...older, session, mon], today, done).push.morning.body, "Calves: 2 sets this week counting assists. Add 3 sets today.");
});

test("computeBrief: lastSetDaysAgo is days since the last day whose wmus had the group, null if never", () => {
  const by = Object.fromEntries(brief.training.groups.map((g) => [g.group, g]));
  for (const g of brief.training.groups) assert.ok(g.lastSetDaysAgo === null || Number.isInteger(g.lastSetDaysAgo), g.group);
  // independent recount from the merged days
  const age = (d) => Math.round((Date.parse(today) - Date.parse(d)) / 86400000);
  for (const g of brief.training.groups) {
    const hit = days.filter((d) => (d.wmus || {})[g.group] > 0).map((d) => age(d.d));
    assert.equal(g.lastSetDaysAgo, hit.length ? Math.min(...hit) : null, g.group);
  }
  assert.equal(by.chest.lastSetDaysAgo, 10);            // push day 2026-06-20
  assert.equal(by.quads.lastSetDaysAgo, 3);             // leg day 2026-06-27
  assert.equal(by.shoulders.lastSetDaysAgo, 6);         // rear delts on the pull day 2026-06-24, 0 direct sets
  assert.strictEqual(by.calves.lastSetDaysAgo, null);   // never in the fixture
});

// ---- sets per muscle by ISO week (item 24: weeklySets, setsRead, training.weekly)
test("weeklySets: 12 Mon-Sun weeks ending with today's partial week, totals equal the days' wmus", () => {
  const weeks = weeklySets(days, 12, today);
  assert.equal(weeks.length, 12);
  for (const w of weeks) {
    assert.equal(weekday(w.start), 0, `${w.start} is a Monday`);
    assert.equal(w.end, addDays(w.start, 6));
  }
  for (let i = 1; i < weeks.length; i++) assert.equal(weeks[i].start, addDays(weeks[i - 1].start, 7), "consecutive weeks");
  assert.equal(weeks[11].partial, true);
  assert.ok(weeks.slice(0, 11).every((w) => !w.partial), "only the current week is partial");
  assert.ok(weeks[11].start <= today && today <= weeks[11].end, "the last week holds today");
  // independent recount from the fixture days
  for (const w of weeks) {
    const inWeek = days.filter((d) => d.wsets && d.d >= w.start && d.d <= w.end);
    assert.equal(w.sessions, inWeek.length, `${w.start} sessions`);
    const want = {};
    for (const d of inWeek) for (const [g, v] of Object.entries(d.wmus)) want[g] = (want[g] || 0) + v;
    assert.deepEqual(Object.keys(w.mus).sort(), Object.keys(want).sort(), `${w.start} groups`);
    for (const g of Object.keys(want)) assert.ok(Math.abs(w.mus[g] - want[g]) < 0.011, `${w.start} ${g}: ${w.mus[g]} vs ${want[g]}`);
  }
  const trained = weeks.filter((w) => w.sessions > 0);
  assert.ok(trained.length >= 4, "the fixture trains in several weeks");
  assert.ok(weeks.some((w) => w.sessions === 0 && !Object.keys(w.mus).length), "weeks before the fixture are empty");
  // with no today given the last day in the list anchors the window
  assert.equal(weeklySets(days, 4)[3].end >= days[days.length - 1].d, true);
  assert.deepEqual(weeklySets([], 12), []);
});

test("setsRead: the four states at their boundaries", () => {
  const med = 8;
  assert.equal(setsRead(3.99, med), "well below");   // under 50%
  assert.equal(setsRead(4, med), "below");           // exactly 50% is not "well below"
  assert.equal(setsRead(5.99, med), "below");        // under 75%
  assert.equal(setsRead(6, med), "steady");          // exactly 75%
  assert.equal(setsRead(8, med), "steady");
  assert.equal(setsRead(10, med), "steady");         // exactly 125%
  assert.equal(setsRead(10.01, med), "above");       // over 125%
  assert.equal(setsRead(0, med), "well below");
  assert.equal(setsRead(0, 0), "steady");
  assert.equal(setsRead(3, 0), "above");
});

test("computeBrief: training.weekly draws the two lowest main groups and the highest, each with a read", () => {
  const w = brief.training.weekly;
  assert.equal(w.weeks.length, 12);
  assert.equal(w.medianWeeks, 4);
  assert.equal(w.minDose, 4);
  assert.equal(w.picks.length, 3);
  assert.deepEqual(w.picks.map((p) => p.role), ["low", "low", "ref"]);
  const main = brief.training.groups.filter((g) => !["core", "forearms", "other"].includes(g.group));
  const avg = Object.fromEntries(main.map((g) => [g.group, g.fsetsWkAvg28]));
  const lows = w.picks.slice(0, 2).map((p) => avg[p.group]);
  const rest = main.filter((g) => !w.picks.slice(0, 2).some((p) => p.group === g.group)).map((g) => g.fsetsWkAvg28);
  assert.ok(Math.max(...lows) <= Math.min(...rest), "the two low picks have the lowest 28-day averages");
  assert.equal(avg[w.picks[2].group], Math.max(...Object.values(avg)), "the reference is the highest");
  const full = w.weeks.filter((x) => !x.partial), lastFull = full[full.length - 1];
  const medWeeks = full.slice(-5, -1);
  for (const p of w.picks) {
    assert.ok(["well below", "below", "steady", "above"].includes(p.read), p.read);
    assert.equal(p.lastFull, pyRound(lastFull.mus[p.group] || 0, 1));
    assert.equal(p.median, pyRound(median(medWeeks.map((x) => x.mus[p.group] || 0)), 1));
    assert.equal(p.read, setsRead(lastFull.mus[p.group] || 0, median(medWeeks.map((x) => x.mus[p.group] || 0))));
  }
});

// ---- the weekly plan (item 5). In the fixture calves has 0 sets everywhere and
// no calf exercise has ever been logged; 2026-06-29 is the Monday of today's week.
test("makePlan: picks calves when calves is at 0, asks 3 sets per session on the usual days still ahead", () => {
  const p = brief.training.plan;
  assert.ok(p, "plan present");
  assert.equal(p.group, "calves");
  assert.equal(p.weekStart, "2026-06-29");
  assert.equal(p.target, PLAN_TARGET);
  assert.equal(p.sets, 3);                        // 4 sets over two sessions, never under 3
  assert.deepEqual(p.days, [1, 5]);               // Tue (today) and Sat
  assert.strictEqual(p.exercise, null);           // no calf exercise in his history
  assert.equal(p.state, "open");
  assert.match(p.sentence, /^Under 4 sets in the last 7 days: .*calves 0.*Add .*3 sets of a calf exercise.* on Tue and Sat. Checked Sunday.$/);
  assert.deepEqual(brief.training.planHistory, [], "no store, no history");
  assert.equal(makePlan(days, today, brief.training.groups).group, "calves");
});

test("makePlan: the sentence names the most-used exercise once one exists for the group", () => {
  const calf = { d: "2026-06-10", wvol: 800, wsets: 3, wex: [{ n: "Standing Calf Raise", v: 800, s: 3, mw: 80, mr: 12, e1: 100 }] };
  const withCalf = [...days.filter((d) => d.d !== calf.d), { ...(days.find((d) => d.d === calf.d) || {}), ...calf }].sort((a, b) => (a.d < b.d ? -1 : 1));
  const b = computeBrief(withCalf, today);
  assert.equal(b.training.plan.group, "calves");
  assert.equal(b.training.plan.exercise, "Standing Calf Raise");
  assert.match(b.training.plan.sentence, /^Under 4 sets in the last 7 days: .*calves 0.*Add .*3 sets of Standing Calf Raise.* on Tue and Sat. Checked Sunday.$/);
  assert.ok(!/\u2014/.test(b.training.plan.sentence), "no em dash");
});

test("plan: todo carries one box per group with this week's sets, and when names the next planned day", () => {
  const calf = { d: "2026-06-10", wvol: 800, wsets: 3, wex: [{ n: "Standing Calf Raise", v: 800, s: 3, mw: 80, mr: 12, e1: 100 }] };
  const withCalf = [...days.filter((d) => d.d !== calf.d), { ...(days.find((d) => d.d === calf.d) || {}), ...calf }].sort((a, b) => (a.d < b.d ? -1 : 1));
  const p = computeBrief(withCalf, today).training.plan;
  assert.equal(p.when, "Today", "the fixture today is a planned Tuesday");
  assert.equal(p.todo[0].group, "calves");
  assert.equal(p.todo[0].exercise, "Standing Calf Raise");
  assert.equal(p.todo[0].sets, p.sets);
  assert.equal(typeof p.todo[0].week, "number");
  assert.equal(p.todo.length, p.items.length);
  const missed = computeBrief(days, "2026-07-01", { weeks: [{ weekStart: "2026-06-29", group: "calves", exercise: null, sets: 3, target: 4, days: [1, 5], createdAt: "2026-06-29" }] }).training.plan;
  assert.equal(missed.when, "Tonight");
  assert.equal(missed.todo[0].exercise, "a calf exercise");
});

test("planSentence: a stored plan whose planned day went by with no session turns into the missed line; done once the target is reached", () => {
  const store = { weeks: [{ weekStart: "2026-06-29", group: "calves", exercise: null, sets: 3, target: 4, days: [1, 5], createdAt: "2026-06-29" }] };
  // Wednesday 2026-07-01: Tuesday was planned and nothing was logged that day
  const b = computeBrief(days, "2026-07-01", store);
  assert.equal(b.training.plan.state, "missed");
  assert.match(b.training.plan.sentence, /^Missed Tue. Tonight, 15 minutes: 3 sets of a calf exercise( and .*)?.$/);
  assert.deepEqual(b.training.plan.days, [1, 5], "the stored days stand");
  // the same week with a Tuesday session that logged 4 calf sets: done
  const tue = { d: "2026-06-30", wvol: 800, wsets: 4, wex: [{ n: "Standing Calf Raise", v: 800, s: 4, mw: 80, mr: 12, e1: 100 }] };
  const withTue = days.map((d) => (d.d === tue.d ? { ...d, ...tue } : d));
  const s = planSentence(store.weeks[0], withTue, "2026-07-01");
  assert.equal(s.state, "done");
  assert.equal(s.text, "Done: calves at 4 of 4 sets this week. Checked Sunday.");
  // a done plan no longer carries the push: rule (a) falls back to its own lowest-group text on the planned Saturday
  assert.equal(computeBrief(withTue, "2026-07-04", store).push.morning.body, "Chest: 0 sets this week counting assists. Add 3 sets today.");
});

test("evaluatePlan: hit when the week's fractional sets reach the target, miss otherwise", () => {
  // quads: Leg Press 4 sets on Sat 2026-06-27 -> 4/4 hit; calves: nothing -> 0/4 miss
  assert.deepEqual(evaluatePlan({ weekStart: "2026-06-22", group: "quads", target: 4 }, days), { achieved: 4, result: "hit" });
  assert.deepEqual(evaluatePlan({ weekStart: "2026-06-22", group: "calves", target: 4 }, days), { achieved: 0, result: "miss" });
  // hamstrings/glutes: RDL 4 direct + Leg Press 4 x 0.5 assist = 6 -> hit on fractional sets
  assert.deepEqual(evaluatePlan({ weekStart: "2026-06-22", group: "hamstrings/glutes", target: 4 }, days), { achieved: 6, result: "hit" });
  assert.deepEqual(evaluatePlan({ weekStart: "2026-06-22", group: "chest", target: 4 }, days), { achieved: 0, result: "miss" });
});

test("streak4: counts consecutive completed weeks with every main group at 4+ fractional sets, ending last week", () => {
  const full = (d) => ({ d, wvol: 5000, wsets: 32, wex: [
    { n: "Bench Press", s: 4 }, { n: "Seated Cable Row", s: 4 }, { n: "Shoulder Press", s: 4 }, { n: "Dumbbell Curl", s: 4 },
    { n: "Tricep Pushdown", s: 4 }, { n: "Leg Press", s: 4 }, { n: "Romanian Deadlift", s: 4 }, { n: "Standing Calf Raise", s: 4 }] });
  // one session a week on Wednesdays from 2026-05-06; today 2026-06-30 (Tue), so the last completed week starts
  // 2026-06-22 and the week of 2026-05-04 is only partly inside the data window: 7 weeks, not 8
  const weds = ["2026-05-06", "2026-05-13", "2026-05-20", "2026-05-27", "2026-06-03", "2026-06-10", "2026-06-17", "2026-06-24"];
  const synth = weds.map(full);
  assert.equal(streak4(synth, today), 7);
  // drop the calf sets from the week of 2026-06-01: the streak stops there
  const broken = synth.map((d) => (d.d === "2026-06-03" ? { ...d, wex: d.wex.filter((e) => e.n !== "Standing Calf Raise") } : d));
  assert.equal(streak4(broken, today), 3);
  // a week only partly inside the data window never counts
  assert.equal(streak4(synth.slice(-1), today), 0);
  assert.equal(brief.training.streak4, 0, "the fixture never trains calves");
});

test("computeBrief: a store with scored weeks reaches training.planHistory, newest last, at most 8", () => {
  const weeks = [];
  for (let i = 10; i >= 1; i--) {
    const ws = shift("2026-06-29", -7 * i);
    weeks.push({ weekStart: ws, group: i % 2 ? "calves" : "quads", exercise: null, sets: 3, target: 4, days: [1, 5], createdAt: ws, achieved: i % 2 ? 0 : 4, result: i % 2 ? "miss" : "hit" });
  }
  const b = computeBrief(days, today, { weeks });
  assert.equal(b.training.planHistory.length, 8);
  assert.equal(b.training.planHistory[7].weekStart, "2026-06-22");
  assert.deepEqual(Object.keys(b.training.planHistory[0]), ["weekStart", "group", "achieved", "target", "result"]);
  assert.equal(b.training.plan.weekStart, "2026-06-29", "no stored plan for this week: a fresh one");
});
