import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixture.json";
import { loadWorkouts, mergeDays } from "../src/pipeline/summarize.js";
import { buildInsights } from "../src/pipeline/insights.js";
import { computeBrief } from "../src/pipeline/brief.js";
import { addDays, wdName } from "../src/pipeline/util.js";

test("buildInsights: an array of [tag, title, body] string triples", () => {
  const days = mergeDays(fixture.ring, loadWorkouts(fixture.workouts), fixture.screentime);
  const cards = buildInsights(days.slice(-35), "2026-06-30");
  assert.ok(Array.isArray(cards));
  assert.ok(cards.length >= 1 && cards.length <= 8, `got ${cards.length}`);
  for (const card of cards) {
    assert.equal(card.length, 3);
    const [tag, title, body] = card;
    for (const s of [tag, title, body]) { assert.equal(typeof s, "string"); assert.ok(s.length > 0); }
    assert.ok(!/undefined|NaN/.test(title + body), title);
  }
});

test("buildInsights: nothing without sleep data", () => {
  assert.deepEqual(buildInsights([], "2026-06-30"), []);
});

test("buildInsights: no hardcoded physiology claims, falling HRV stops at the observation", () => {
  const days = mergeDays(fixture.ring, loadWorkouts(fixture.workouts), fixture.screentime);
  const cards = buildInsights(days.slice(-35), "2026-06-30");
  const text = JSON.stringify(cards);
  for (const s of ["18%", "4.6 score", "protein synthesis", "easing training"]) assert.ok(!text.includes(s), `found "${s}"`);
  // the fixture's HRV falls over the last 7 nights, so the card is present
  const trend = cards.find(([tag, title]) => tag === "Trend" && /trending down/.test(title));
  assert.ok(trend, "falling-HRV card present");
  assert.match(trend[2], /over the prior stretch \(-\d+%\)\.$/);
});

test("buildInsights: the steps card words VO2 max the way claims.js does (vo2-endurance-response)", () => {
  const days = mergeDays(fixture.ring, loadWorkouts(fixture.workouts), fixture.screentime);
  const cards = buildInsights(days.slice(-35), "2026-06-30");
  const steps = cards.find(([tag]) => tag === "Activity");
  assert.ok(steps, "activity card present");
  assert.match(steps[2], /VO2 max is \d+\. Sustained cardio is what moves it\.$/);
  assert.ok(!/lever/.test(steps[2]), steps[2]);
});

// causal verbs are banned in insight copy; the cards describe what went with what
const CAUSAL = /\b(raises?|raising|improves?|improving|drives?|driving|boosts?|boosting|causes?|causing|cuts?|cutting|predicts?|predicting)\b/i;
test("buildInsights: no causal verbs in any card", () => {
  const days = mergeDays(fixture.ring, loadWorkouts(fixture.workouts), fixture.screentime);
  const cards = buildInsights(days.slice(-35), "2026-06-30");
  assert.ok(cards.length >= 1);
  for (const [tag, title, body] of cards) {
    const m = (title + " " + body).match(CAUSAL);
    assert.equal(m, null, `${tag}: "${title}" uses "${m && m[0]}"`);
  }
  const brief = computeBrief(days, "2026-06-30");
  for (const a of brief.actions || []) {
    const m = a.text.match(CAUSAL);
    assert.equal(m, null, `brief action [${a.tag}] uses "${m && m[0]}"`);
  }
});

test("buildInsights: the recover-well card ends on the weekday caveat", () => {
  // 14 days from a Monday, a session every other day, and the morning after a session scores higher
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays("2026-06-01", i);
    days.push({ d, wd: wdName(d), score: 80, slh: 7.5, hrv: 60, rhr: 50, rec: 70, wsets: i % 2 === 0 ? 10 : 0 });
  }
  for (let i = 1; i < 14; i++) days[i].rec = days[i - 1].wsets ? 85 : 70;
  const cards = buildInsights(days, "2026-06-15");
  const card = cards.find(([, title]) => title === "Recovery is higher the morning after a session");
  assert.ok(card, "card present");
  assert.ok(card[2].endsWith(" Lifting and the weekdays you lift on are confounded here."), card[2]);
});
