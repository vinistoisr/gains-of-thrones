// Exercise name -> muscle groups, with fractional credit for assisting muscles.
// The primary mover counts a full set; each listed secondary counts SECONDARY_W.
// Pelland et al. 2025 (meta-regression of set volume and hypertrophy) found that
// fractional counting, primary 1.0 and secondary 0.5, fit the data better than
// counting direct sets only. The 0.5 is a convention taken from that paper, not
// a measurement of how hard the assisting muscle works; edit it here and every
// count in the pipeline and on the page follows.
export const SECONDARY_W = 0.5;

// the ordered main groups the brief, the AI facts and the body map report on
export const GROUPS = ["chest", "back", "shoulders", "biceps", "triceps",
  "quads", "hamstrings/glutes", "calves", "core", "forearms"];

// [regex, primary, [secondaries]]. First match wins, so specific patterns sit
// above the general ones they would otherwise be caught by ("leg curl" before
// "curl", "chest supported" before "chest", "reverse fly" before "fly").
const PATTERNS = [
  // hinge and posterior chain
  [/leg curl/, "hamstrings/glutes", []],
  [/romanian|rdl|hip thrust|good morning|glute|hip a[bd]duction/, "hamstrings/glutes", []],
  [/deadlift|kettlebell swing/, "hamstrings/glutes", ["back"]],
  // knee dominant
  [/leg extension/, "quads", []],
  [/leg press|squat|hack|lunge|wall ball/, "quads", ["hamstrings/glutes"]],
  [/calf/, "calves", []],
  [/crunch|woodchop|palloff|pallof|plank|\bab\b|sit.?up|leg raise|knee raise/, "core", []],
  [/wrist/, "forearms", []],
  [/shrug/, "back", []],
  // rear delt and rotator work counts as shoulders, the same as the body map (deltoid-rear -> shoulders)
  [/face pull|reverse fly|external rotation|internal rotation|rear delt|y raise/, "shoulders", []],
  [/lateral raise|front raise/, "shoulders", []],
  [/snatch/, "shoulders", ["hamstrings/glutes"]],
  [/shoulder press|arnold|push press|overhead press|clean and press|military press/, "shoulders", ["triceps"]],
  [/tricep|pushdown|skull/, "triceps", []],
  [/hammer curl|reverse .*curl/, "biceps", ["forearms"]],
  [/curl/, "biceps", []],
  [/chest supported/, "back", ["biceps", "shoulders"]],     // "Chest Supported Row" is a row; must beat the chest rule
  [/fly|crossover/, "chest", []],                                   // flyes isolate the chest; must beat the press rule
  [/bench|chest|dip|floor press|incline.*press|machine press|push.?up/, "chest", ["triceps", "shoulders"]],
  [/pullover|straight arm/, "back", []],
  [/pulldown|pull.?up|\bchin\b|row/, "back", ["biceps", "shoulders"]],   // \bchin\b so "machine" does not match
];

/**
 * Exercise name -> [{group, w}]: the primary at 1.0, each secondary at
 * SECONDARY_W. Empty array when no pattern matches (the set stays unclassified).
 */
export function attribution(name) {
  const n = String(name || "").toLowerCase();
  for (const [re, primary, secondaries] of PATTERNS) {
    if (re.test(n)) return [{ group: primary, w: 1 }, ...secondaries.map((group) => ({ group, w: SECONDARY_W }))];
  }
  return [];
}

/** Primary group of an exercise, "other" when nothing matches. */
export function muscleGroup(name) {
  const a = attribution(name);
  return a.length ? a[0].group : "other";
}

/**
 * exercises: [{n, s}] (per-exercise name and set count, the wex shape) ->
 * {mus: {group: fractionalSets}, unc: sets whose name matched no pattern}.
 */
export function fractionalSets(exercises) {
  const mus = {};
  let unc = 0;
  for (const e of exercises || []) {
    const sets = e.s || 0;
    const a = attribution(e.n);
    if (!a.length) { unc += sets; continue; }
    for (const { group, w } of a) mus[group] = (mus[group] || 0) + sets * w;
  }
  return { mus, unc };
}
