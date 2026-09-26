import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixture.json";
import { loadWorkouts, mergeDays } from "../src/pipeline/summarize.js";
import { computeBrief } from "../src/pipeline/brief.js";
import { weeklyFacts, writeNarrative, validate, numerals, unverifiableNumbers, countFacts } from "../src/pipeline/ai.js";

const today = "2026-06-30";
const days = mergeDays(fixture.ring, loadWorkouts(fixture.workouts), fixture.screentime);
const facts = weeklyFacts(days, computeBrief(days, today), today);

// a well-formed note whose numbers all come from the facts sheet
const filler = "Sleep and training moved together this week and the pattern is worth a look before next week starts.";
const pad = (lead) => { let s = lead; while (s.split(/\s+/).length < 95) s += " " + filler; return s; };
const goodNote = () => ({
  headline: `Sleep averaged ${facts.this_week.sleep_h} h across ${facts.this_week.nights} nights this week`,
  body: pad(`You slept ${facts.this_week.sleep_h} h a night against the prior 4 weeks, with ${facts.training.sessions_this_week} lifting sessions logged.`),
  focus: "Be in bed by 22:30 on four weeknights and add one more leg session before Friday.",
});
const BOGUS = 987654;

test("numerals: dates, clock times, ordinals and metric names are not figures", () => {
  assert.deepEqual(numerals("Be in bed by 07:00 on 2026-06-30, the 3rd week; e1RM rose 4.5% to 112 kg, VO2 max 40"), [4.5, 112, 40]);
  assert.deepEqual(numerals("June 30 and 30 June and 10 pm and 1,234 steps"), [1234]);
  assert.deepEqual(numerals("fell -2.5% then 6.9h"), [2.5, 6.9]);
});

test("unverifiableNumbers: 0.05 tolerance, so 6.9 matches 6.92 and 16 matches 16", () => {
  const sheet = { sleep_h: 6.92, chest: "16 sets: IN the growth range", pct: -3.1 };
  assert.deepEqual(unverifiableNumbers("Sleep fell to 6.9 h while chest hit 16 sets, down 3.1%", sheet), []);
  assert.deepEqual(unverifiableNumbers("Sleep fell to 6.8 h while chest hit 16 sets", sheet), [6.8]);
  assert.deepEqual(unverifiableNumbers("Bed by 07:00 on 2026-06-30 with 23 sets", sheet), [23]);
});

test("weeklyFacts: loads are stated in lb as logged in Liftoff, never kg", () => {
  assert.equal(facts.training.load_unit, "lb, as logged in Liftoff");
  for (const p of facts.training.top_progressions) assert.match(p, / lb over \d+ sessions /, p);
  assert.ok(!/\bkg\b/.test(JSON.stringify(facts)), "no kg anywhere in the facts sheet");
});

test("validate: a note with a number missing from the facts fails, one with all numbers present passes", () => {
  assert.ok(!numerals(JSON.stringify(facts)).includes(BOGUS), "the bogus number must not be in the fixture facts");
  assert.ok(facts.this_week.sleep_h != null, "fixture has sleep this week");
  assert.deepEqual(validate(goodNote(), facts), []);
  const bad = { ...goodNote(), body: pad(`You slept ${facts.this_week.sleep_h} h a night and lifted ${BOGUS} kg in total.`) };
  const problems = validate(bad, facts);
  assert.equal(problems.length, 1, problems.join("; "));
  assert.match(problems[0], /^body uses numbers that are not in the facts: 987654$/);
});

test("weeklyFacts: muscle counts are fractional and say so in the field names", () => {
  const t = facts.training;
  assert.ok("fractional_sets_per_week_last_4_by_muscle" in t);
  assert.ok(!("hard_sets_per_week_last_4_by_muscle" in t), "old direct-only field is gone");
  for (const v of Object.values(t.muscle_status_this_week)) assert.match(v, /fractional sets/);
  assert.match(t.muscle_status_this_week.biceps, /^8 fractional sets/);       // 4 direct + 0.5 x 8 pulling sets
  assert.match(t.muscle_status_this_week.shoulders, /^4 fractional sets/);    // rear delts from pulling, 0 direct
  // the same 4-set line as brief.js: 4 fractional sets is in the most-return band, 0 is not trained
  assert.equal(t.muscle_status_this_week.shoulders, "4 fractional sets: 4-10, most of the return per set");
  assert.equal(t.muscle_status_this_week.chest, "0 fractional sets: NOT TRAINED this week");
  assert.equal(t.most_return_per_set_fractional_sets_per_muscle_per_week, "4-10");
  assert.ok(!("target_hard_sets_per_muscle_per_week" in t), "old 10-20 field gone");
  assert.ok(!/10-20/.test(JSON.stringify(t)), "no 10-20 in the facts");
  assert.ok(!/\d/.test(t.fractional_sets_note), "the note adds no numerals to the facts sheet");
});

test("countFacts: leaf values only, nulls excluded", () => {
  assert.equal(countFacts({ a: 1, b: null, c: { d: "x", e: [2, 3] }, f: [] }), 4);
  assert.ok(countFacts(facts) > 20, `fixture facts has ${countFacts(facts)} fields`);
});

function fakeAI(notes) {
  const calls = [];
  return { env: { AI: { run: async (model, req) => { calls.push(req.messages.map((m) => m.content)); return { response: notes[calls.length - 1] }; } } }, calls };
}

test("writeNarrative: an unverifiable number survives the retry, so the body is dropped and headline and focus stay", async () => {
  const bad = { ...goodNote(), body: pad(`You slept ${facts.this_week.sleep_h} h a night and lifted ${BOGUS} kg in total.`) };
  const { env, calls } = fakeAI([bad, bad]);
  const n = await writeNarrative(env, facts, []);
  assert.equal(calls.length, 2, "one retry");
  assert.match(calls[1].at(-1), /987654/, "the retry prompt names the number");
  assert.equal(n.body, "");
  assert.equal(n.dropped, "body: unverifiable number 987654");
  assert.equal(n.headline, bad.headline);
  assert.equal(n.focus, bad.focus);
  assert.equal(n.week_ending, today);
  assert.equal(n.verified, countFacts(facts));
  assert.match(n.quality, /^low: body uses numbers that are not in the facts/);
});

test("writeNarrative: the retry fixes the number, nothing is dropped", async () => {
  const bad = { ...goodNote(), headline: `Sleep averaged ${BOGUS} h this week across nights` };
  const { env, calls } = fakeAI([bad, goodNote()]);
  const n = await writeNarrative(env, facts, []);
  assert.equal(calls.length, 2);
  assert.equal(n.dropped, undefined);
  assert.equal(n.quality, "ok");
  assert.equal(n.headline, goodNote().headline);
  assert.ok(n.body.length > 0);
  assert.equal(n.verified, countFacts(facts));
});

test("weeklyFacts: no correlation fields on the ring's composite scores; score and recovery stay as plain averages", () => {
  assert.ok(!("personal_correlations_last_90_nights" in facts), "the correlation block is gone");
  const walk = (v, path) => {
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      assert.ok(!/_vs_|correlat/i.test(k), path.concat(k).join("."));
      walk(x, path.concat(k));
    }
  };
  walk(facts, []);
  assert.equal(typeof facts.this_week.score, "number");
  assert.equal(typeof facts.this_week.recovery, "number");
});
