import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixture.json";
import { setTimeZone } from "../src/pipeline/util.js";
import { loadWorkouts, mergeDays } from "../src/pipeline/summarize.js";
import { computeBrief } from "../src/pipeline/brief.js";
import { coachMarkdown, setList, SESSION_DAYS } from "../src/pipeline/coach.js";

const today = Object.keys(fixture.ring).sort().pop();
const days = mergeDays(fixture.ring, loadWorkouts(fixture.workouts), fixture.screentime);
const brief = computeBrief(days, today);
setTimeZone("America/Vancouver");
const users = [{ id: "alex", name: "Alex", workouts: "liftoff" }, { id: "sam", name: "Sam", workouts: null }];
const user = users[0];
const md = coachMarkdown({ user, days, brief, narrative: null, today, now: Date.UTC(2026, 8, 21, 22, 5) });

test("coach: the snapshot names the person, stamps itself and explains its units", () => {
  assert.match(md, /^# Alex: training and recovery snapshot\n/);
  assert.match(md, /Generated 2026-09-21 15:05 America\/Vancouver/);   // local wall clock, not UTC
  assert.match(md, new RegExp(`data through ${today}`));
  assert.match(md, /loads in lb/);
  assert.match(md, /w = warm-up, f = taken to failure/);
});

test("coach: every session in the window is listed set by set with its muscle group and e1RM", () => {
  const recent = days.filter((d) => d.wsets && today && (Date.parse(today) - Date.parse(d.d)) / 86400000 < SESSION_DAYS);
  assert.ok(recent.length > 0, "fixture has sessions in the window");
  for (const d of recent) {
    assert.match(md, new RegExp(`### \\w{3} \\w{3} \\d+ \\(.*\\): .*${d.wsets} sets`), d.d);
    for (const e of d.wex) assert.ok(md.includes(`- ${e.n} (`), `${d.d} ${e.n}`);
  }
  // a set string: load x reps, optional flag letters and @rir, comma separated, then the e1RM
  assert.match(md, /- .+ \((quads|back|chest)\): \d+(\.\d)?x\d+[wfd]*(@\d+)?(, \d+(\.\d)?x\d+[wfd]*(@\d+)?)* \| e1RM \d+/);
});

test("coach: setList formats the wsr tuples with the flag letters", () => {
  const day = { wsr: [[0, 45, 12, 2], [0, 50, 10, 1], [0, 50, 8, 8], [0, 0, 12, 0], [1, 100, 5, 4, 2]] };
  assert.equal(setList(day, 0), "45x12w, 50x10f, 50x8d, bwx12");
  assert.equal(setList(day, 1), "100x5@2");
  assert.equal(setList(day, 2), null);
});

test("coach: volume, trend and recovery sections are present and the bands are explained", () => {
  assert.match(md, /## Weekly sets by muscle/);
  assert.match(md, /\| chest \| \d+(\.\d)? \| \d+(\.\d)? \| (none|low|ok|high|very high) \| /);
  assert.match(md, /Bands are fractional sets per week: 0 none, under 4 low/);
  assert.match(md, /Fractional sets by ISO week/);
  assert.match(md, /## Lift trends, last 90 days/);
  assert.match(md, /- Stronger \(\d+\)/);
  assert.match(md, /## Recovery, last 7 recorded nights/);
  assert.match(md, /\| night \| asleep \| score \| recovery \| HRV \| RHR \| bed \| wake \| deep \| REM \|/);
  assert.match(md, /\| 28-night baseline \|/);
});

test("coach: the weekly note is appended when there is one and skipped when there is not", () => {
  assert.doesNotMatch(md, /## Weekly note/);
  const withNote = coachMarkdown({ user: users[0], days, brief, today, narrative: { week_ending: today, headline: "Chest volume hit 16 sets", body: "Body text.", focus: "Bring quads to 10 sets." } });
  assert.match(withNote, /## Weekly note \(written by the dashboard's model, week ending/);
  assert.match(withNote, /Chest volume hit 16 sets\. Body text\.\nFocus: Bring quads to 10 sets\./);
});

test("coach: a ring-only user gets nights and a plain 'no sessions' line, no lifting sections", () => {
  const ringOnly = mergeDays(fixture.ring, {}, {});
  const b = computeBrief(ringOnly, today);
  const out = coachMarkdown({ user: users[1], days: ringOnly, brief: b, narrative: null, today });
  assert.match(out, /^# Sam: /);
  assert.match(out, /No sessions logged\./);
  assert.doesNotMatch(out, /## Weekly sets by muscle/);
  assert.match(out, /## Recovery, last 7 recorded nights/);
});

test("coach: a failed brief still yields the sessions and nights, with the error named", () => {
  const out = coachMarkdown({ user: users[0], days, brief: { error: "brief: boom" }, narrative: null, today });
  assert.match(out, /The daily brief failed this refresh \(brief: boom\)/);
  assert.match(out, /## Sessions, last 14 days\n### /);
  assert.match(out, /## Recovery/);
});

test("coach: the snapshot stays small enough to inject into every conversation", () => {
  assert.ok(md.length < 12000, `${md.length} chars`);
});
