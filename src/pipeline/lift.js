// Raw-load helpers for the lift chart. The page gets these two functions
// verbatim (render.js fills __LIFTFN__ with their source), so they must stay
// self-contained: no imports, no module-level names, plain ES2015.
//
// A session is that day's wsr tuples for one exercise: [exIdx, load, reps, flags(, rir)].
// Warm-up sets (flags & 2, SET_WARMUP in summarize.js) never count.

/** Most common rep count across the sessions' working sets; ties go to the lower count. null if no sets. */
export function modalReps(sessions) {
  const count = {};
  for (const sets of sessions) for (const t of sets || []) {
    if (t[3] & 2) continue;
    const r = t[2];
    if (!(r > 0) || !(t[1] > 0)) continue;
    count[r] = (count[r] || 0) + 1;
  }
  let best = null;
  for (const k in count) {
    const r = Number(k);
    if (best === null || count[r] > count[best] || (count[r] === count[best] && r < best)) best = r;
  }
  return best;
}

/** Heaviest working set at exactly r reps in one session, or null when there is none. */
export function bestLoadAtReps(sets, r) {
  let best = null;
  for (const t of sets || []) {
    if (t[3] & 2) continue;
    if (t[2] !== r || !(t[1] > 0)) continue;
    if (best === null || t[1] > best) best = t[1];
  }
  return best;
}

export const LIFT_FN_JS = [modalReps, bestLoadAtReps].map((f) => f.toString()).join("\n");
