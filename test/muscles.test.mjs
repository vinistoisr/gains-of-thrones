import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPS, SECONDARY_W, attribution, muscleGroup, fractionalSets } from "../src/pipeline/muscles.js";

const by = (name) => Object.fromEntries(attribution(name).map((a) => [a.group, a.w]));

test("muscles: GROUPS lists the 8 main groups first, then core and forearms", () => {
  assert.deepEqual(GROUPS, ["chest", "back", "shoulders", "biceps", "triceps", "quads", "hamstrings/glutes", "calves", "core", "forearms"]);
  assert.equal(SECONDARY_W, 0.5);
});

test("attribution: primary at 1.0, each secondary at SECONDARY_W", () => {
  const cases = {
    "Seated Cable Row": { back: 1, biceps: SECONDARY_W, shoulders: SECONDARY_W },
    "Lat Pulldown": { back: 1, biceps: SECONDARY_W, shoulders: SECONDARY_W },
    "Chin Up": { back: 1, biceps: SECONDARY_W, shoulders: SECONDARY_W },
    "Chest Supported Row": { back: 1, biceps: SECONDARY_W, shoulders: SECONDARY_W },
    "Bench Press": { chest: 1, triceps: SECONDARY_W, shoulders: SECONDARY_W },
    "Chest Press Machine": { chest: 1, triceps: SECONDARY_W, shoulders: SECONDARY_W },
    "Dip": { chest: 1, triceps: SECONDARY_W, shoulders: SECONDARY_W },
    "Machine Chest Fly": { chest: 1 },
    "Shoulder Press": { shoulders: 1, triceps: SECONDARY_W },
    "Dumbbell Push Press": { shoulders: 1, triceps: SECONDARY_W },
    "Lateral Raise": { shoulders: 1 },
    "Face Pull": { shoulders: 1 },
    "Reverse Fly": { shoulders: 1 },
    "Leg Press": { quads: 1, "hamstrings/glutes": SECONDARY_W },
    "Hack Squat": { quads: 1, "hamstrings/glutes": SECONDARY_W },
    "Walking Lunge": { quads: 1, "hamstrings/glutes": SECONDARY_W },
    "Leg Extension": { quads: 1 },
    "Romanian Deadlift": { "hamstrings/glutes": 1 },
    "Deadlift": { "hamstrings/glutes": 1, back: SECONDARY_W },
    "Kettlebell Swing": { "hamstrings/glutes": 1, back: SECONDARY_W },
    "Machine Hip Thrust": { "hamstrings/glutes": 1 },
    "Lying Leg Curl": { "hamstrings/glutes": 1 },
    "Good Morning": { "hamstrings/glutes": 1 },
    "Seated Calf Raise": { calves: 1 },
    "Dumbbell Curl": { biceps: 1 },
    "Hammer Curl": { biceps: 1, forearms: SECONDARY_W },
    "Tricep Pushdown": { triceps: 1 },
    "EZ Bar Lying Tricep Extension": { triceps: 1 },
    "Skullcrusher": { triceps: 1 },
    "Wrist Curl": { forearms: 1 },
    "Machine Seated Crunch": { core: 1 },
    "Plank": { core: 1 },
    "Cable Woodchopper": { core: 1 },
    "Palloff Press": { core: 1 },
  };
  for (const [name, want] of Object.entries(cases)) assert.deepEqual(by(name), want, name);
});

test("attribution: a compound with an assist is 1.0 + 0.5, the primary comes first, unknown names give []", () => {
  const a = attribution("Incline Dumbbell Bench Press");
  assert.equal(a[0].group, "chest");
  assert.equal(a[0].w, 1);
  assert.equal(a.reduce((s, x) => s + x.w, 0), 1 + 2 * SECONDARY_W);
  assert.deepEqual(attribution("Battle Ropes"), []);
  assert.deepEqual(attribution(""), []);
});

test("muscleGroup: the primary of attribution, other when nothing matches", () => {
  assert.equal(muscleGroup("Leg Curl"), "hamstrings/glutes");   // not biceps
  assert.equal(muscleGroup("Chest Supported Row"), "back");     // not chest
  assert.equal(muscleGroup("Straight Arm Pulldown"), "back");
  assert.equal(muscleGroup("Battle Ropes"), "other");
});

test("fractionalSets: sums set counts by weight and counts unmatched sets", () => {
  const { mus, unc } = fractionalSets([{ n: "Bench Press", s: 4 }, { n: "Tricep Pushdown", s: 3 }, { n: "Battle Ropes", s: 2 }]);
  assert.deepEqual(mus, { chest: 4, triceps: 3 + 4 * SECONDARY_W, shoulders: 4 * SECONDARY_W });
  assert.equal(unc, 2);
  assert.deepEqual(fractionalSets([]), { mus: {}, unc: 0 });
  assert.deepEqual(fractionalSets(undefined), { mus: {}, unc: 0 });
});
