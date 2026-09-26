// Raw Ultrahuman day payloads and
// Liftoff posts -> the per-day summary records the page renders.
import { localParts, parseTs, pyRound, lblShort, wdName, weekday, mondayOf, mean, pstdev } from "./util.js";
import { fractionalSets } from "./muscles.js";

export const WKEYS = ["wvol", "wsets", "wexn", "wdur", "wpr", "wcardio", "wbody", "wnames", "wex", "wsr", "wmus", "wunc", "wef"];
// wsr set flags. Liftoff setType vocabulary seen in the raw posts: "normal",
// "failure", "drop", "warmup" (warm-ups are "warmup", one word). rir is null
// unless the user typed one, then an integer.
export const SET_FAILURE = 1, SET_WARMUP = 2, SET_RIR = 4, SET_DROP = 8;
const HYP_CODES = { awake: "aw", light_sleep: "li", deep_sleep: "de", rem_sleep: "re" };

const DUR_UNIT_SEC = { h: 3600, m: 60, s: 1 };
const DUR_TOKEN = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;

/**
 * sessionDuration -> minutes as a float (null if empty/invalid). Liftoff sends a
 * phrase, "01 hours 04 minutes 38 seconds" (also "45 minutes 10 seconds",
 * "1 hour", "58 minutes": any subset of units, any order). Plain seconds and
 * H:MM:SS are still accepted. loadWorkouts rounds the per-day sum.
 */
export function parseDurationMin(s) {
  if (!s) return null;
  s = String(s).trim();
  let sec;
  if (s.includes(":")) {
    const parts = s.split(":").map(Number);
    if (parts.some(Number.isNaN)) return null;
    sec = parts.reduce((acc, p) => acc * 60 + p, 0);
  } else if (/[a-z]/i.test(s)) {
    let n = 0;
    sec = 0;
    const rest = s.replace(DUR_TOKEN, (_, num, unit) => { sec += Number(num) * DUR_UNIT_SEC[unit[0].toLowerCase()]; n++; return ""; });
    // every token must be a number plus a unit; "1 hours 4 bananas" is not a duration
    if (!n || /[^\s,]/.test(rest.replace(/\band\b/gi, ""))) return null;
  } else {
    sec = Number(s);
    if (Number.isNaN(sec)) return null;
  }
  return sec / 60 || null;
}

/**
 * Aggregate Liftoff posts into one record per local date.
 * Beyond the original per-day fields (wvol, wsets, ...), the raw API also gives:
 *   wstreak    Liftoff's streak counter (days, with grace) as of that day
 *   wxp        experience points gained
 *   wrank      exercises that ranked up (rankUpSetId set), wrankNames the first few
 *   wfail      sets logged as taken to failure
 *   wprNames   records we detect ourselves: heavier top weight or higher e1RM than
 *              anything before in that exercise, e.g. "Bench Press 95x12"
 *   wsr        every WR set of the day, in the order the posts list them (the same
 *              order wex is built in): [exerciseIndex, load, reps, flags(, rir)]
 *              where exerciseIndex is the position in that day's wex array (wnames
 *              is a truncated string on the page, so it cannot be indexed), weight
 *              in the person's unit (refresh.js runs postsInUnit first; the page labels it)
 *              rounded to 0.25 (keeps 1.25 kg plates), reps an integer, flags a SET_* bitmask and rir the
 *              logged value only when SET_RIR is set. Sets with no weight and no
 *              reps are skipped. Absent (not []) on days without a WR set.
 *   wmus       {group: fractional sets} for lifting days: each set counts 1.0 for the
 *              primary muscle and SECONDARY_W (muscles.js) for each assisting one
 *   wunc       sets whose exercise name matched no pattern in muscles.js
 *   wef        effort state per exercise, aligned with wex (effortState below):
 *              "near failure" | "moderate" | "easy" | "capped" | "not computable"
 */
/**
 * Chronological pass over posts. Per date returns:
 *   records: ["Exercise 95x12", ...]  a set beating every earlier session of that exercise
 *   perfRatios: [r, ...]  each WR exercise's best e1RM that day / its prior all-time best
 *                         (only exercises seen before), so ~1.0 = matched your ceiling
 * Performance is the objective "how well did the session go" signal for the
 * sleep -> training correlations.
 */
function chronoPass(posts) {
  const best = new Map();                  // exercise -> {mw, mr, e1} across all history
  const records = {}, perfRatios = {};
  const sorted = [...(posts || [])].map((p) => [parseTs(p.startedAt), p]).filter(([ms]) => ms !== null).sort((a, b) => a[0] - b[0]);
  for (const [ms, post] of sorted) {
    const d = localParts(ms).date;
    for (const ex of post.exerciseData || []) {
      if (ex.exerciseTypes !== "WR") continue;
      const name = ex.exerciseName || "Unknown";
      let pr = null, sessBest = 0;
      for (const s of ex.setsData || []) {
        const one = Number(s.inputOne || 0), two = Number(s.inputTwo || 0);
        if (Number.isNaN(one) || Number.isNaN(two) || one <= 0) continue;
        const e1 = one * (1 + two / 30);
        if (e1 > sessBest) sessBest = e1;
        const b = best.get(name);
        if (b && two > 0 && (one > b.mw || e1 > b.e1 + 0.05)) pr = `${name} ${one}x${two}`;
        if (!b) best.set(name, { mw: one, mr: two, e1 });
        else { if (one > b.mw || (one === b.mw && two > b.mr)) { b.mw = one; b.mr = two; } if (e1 > b.e1) b.e1 = e1; }
      }
      // ratio uses the best BEFORE this session (best.get was read above via `b`, but
      // best is already updated; recompute prior from the pre-update snapshot below)
      if (pr) (records[d] || (records[d] = [])).push(pr);
    }
  }
  // second chronological pass for ratios against the prior-to-that-session best
  const prior = new Map();
  for (const [ms, post] of sorted) {
    const d = localParts(ms).date;
    for (const ex of post.exerciseData || []) {
      if (ex.exerciseTypes !== "WR") continue;
      const name = ex.exerciseName || "Unknown";
      let sessBest = 0;
      for (const s of ex.setsData || []) {
        const one = Number(s.inputOne || 0), two = Number(s.inputTwo || 0);
        if (Number.isNaN(one) || Number.isNaN(two) || one <= 0) continue;
        const e1 = one * (1 + two / 30);
        if (e1 > sessBest) sessBest = e1;
      }
      const p = prior.get(name);
      if (sessBest > 0 && p) (perfRatios[d] || (perfRatios[d] = [])).push(sessBest / p);
      if (sessBest > 0) prior.set(name, Math.max(p || 0, sessBest));
    }
  }
  return { records, perfRatios };
}

export const EFFORT_MIN_SETS = 3;
export const EFFORT_STATES = ["near failure", "moderate", "easy", "capped", "not computable"];
/**
 * Effort of one exercise-session read from rep drop-off at a fixed load, since
 * RIR is almost never logged. sets: the working (non warm-up) sets in logged
 * order as [load, reps]. The load with the most sets is taken (ties go to the
 * heavier one); with fewer than EFFORT_MIN_SETS sets at it the state is "not
 * computable". Over that run, dropoff = reps(last) / reps(first):
 *   "capped"        every set hit the same rep count: a prescribed target, so
 *                   nothing can be read from the run
 *   3 sets          "near failure" <= 0.75, "moderate" <= 0.90, else "easy"
 *   4 or more sets  "near failure" <= 0.65, "moderate" <= 0.85, else "easy"
 * Across 29 studies with sets to failure at a fixed load, reps land near 70% of
 * set 1 on set 2, 55% on set 3 and 50% on set 4, so the cut depends on the set
 * count. Nuzzo 2024 found between-person variation too large for a point
 * estimate, hence coarse states and never a number. Never fed into e1RM.
 */
// claim: rep-dropoff-effort
export function effortState(sets) {
  const byLoad = new Map();
  for (const [kg, reps] of sets) {
    if (!(reps > 0)) continue;
    (byLoad.get(kg) || byLoad.set(kg, []).get(kg)).push(reps);
  }
  let run = null, runKg = -1;
  for (const [kg, reps] of byLoad) {
    if (!run || reps.length > run.length || (reps.length === run.length && kg > runKg)) { run = reps; runKg = kg; }
  }
  if (!run || run.length < EFFORT_MIN_SETS) return "not computable";
  if (run.every((r) => r === run[0])) return "capped";
  const dropoff = run[run.length - 1] / run[0];
  const [nf, mod] = run.length >= 4 ? [0.65, 0.85] : [0.75, 0.90];
  return dropoff <= nf ? "near failure" : dropoff <= mod ? "moderate" : "easy";
}

export function loadWorkouts(posts) {
  const days = {};
  const { records, perfRatios } = chronoPass(posts);
  const presetVol = {};   // presetId -> [day volumes], to normalise volume by routine
  const dayPreset = {};   // date -> preset of the day's largest-volume session
  const dayPresetVol = {};
  for (const post of posts || []) {          // API order, not chronological
    const ms = parseTs(post.startedAt);
    if (ms === null) continue;
    const d = localParts(ms).date;
    const rec = days[d] || (days[d] = {
      wvol: 0, wsets: 0, wexn: 0, wdur: 0, wpr: 0, wcardio: 0, wbody: null, wnames: [], wex: new Map(), wsr: [],
      wstreak: 0, wxp: 0, wrank: 0, wrankNames: [], wfail: 0, wprNames: [],
    });
    rec.wpr += Number(post.prCount) || 0;
    rec.wdur += parseDurationMin(post.sessionDuration) || 0;
    rec.wstreak = Math.max(rec.wstreak, Number(post.streaksCount) || 0);
    rec.wxp += Number(post.experienceGained) || 0;
    // this post's volume, to pick the day's dominant routine
    let postVol = 0;
    for (const ex of post.exerciseData || []) {
      if (ex.exerciseTypes !== "WR") continue;
      for (const s of ex.setsData || []) {
        const one = Number(s.inputOne || 0), two = Number(s.inputTwo || 0);
        if (one > 0 && two > 0 && !Number.isNaN(one) && !Number.isNaN(two)) postVol += one * two;
      }
    }
    if (post.sessionPresetId && postVol > (dayPresetVol[d] || -1)) { dayPreset[d] = post.sessionPresetId; dayPresetVol[d] = postVol; }
    const bw = parseFloat(post.bodyweight || "");
    if (!Number.isNaN(bw) && bw > 0) rec.wbody = bw;
    for (const ex of post.exerciseData || []) {
      const sets = ex.setsData || [];
      if (!sets.length) continue;
      rec.wexn += 1;
      const name = ex.exerciseName || "Unknown";
      rec.wnames.push(name);
      if (ex.rankUpSetId) { rec.wrank += 1; rec.wrankNames.push(name); }
      for (const s of sets) {
        const one = Number(s.inputOne || 0), two = Number(s.inputTwo || 0);
        if (Number.isNaN(one) || Number.isNaN(two)) continue;
        if (s.setType === "failure") rec.wfail += 1;
        if (ex.exerciseTypes === "WR") {
          rec.wsets += 1;
          let ent = rec.wex.get(name);
          if (!ent) { ent = { i: rec.wex.size, v: 0, s: 0, mw: 0, mr: 0, e1: 0, e1w: 0, e1r: 0 }; rec.wex.set(name, ent); }
          ent.s += 1;
          if (one > 0 || two > 0) {
            let flags = 0;
            if (s.setType === "failure") flags |= SET_FAILURE;
            else if (s.setType === "warmup") flags |= SET_WARMUP;
            else if (s.setType === "drop") flags |= SET_DROP;
            const rir = s.rir == null || s.rir === "" ? null : Number(s.rir);
            const tuple = [ent.i, Math.round(one * 4) / 4, Math.round(two), flags];
            if (rir !== null && !Number.isNaN(rir)) { tuple[3] |= SET_RIR; tuple.push(rir); }
            rec.wsr.push(tuple);
          }
          if (one > 0) {
            ent.v += one * two;
            rec.wvol += one * two;
            if (one > ent.mw || (one === ent.mw && two > ent.mr)) { ent.mw = one; ent.mr = two; }
            // mw/mr is the heaviest set; the set behind e1 can be a lighter one with more
            // reps, so it is kept separately (e1w x e1r) for the lift chart caption
            const e1 = one * (1 + two / 30);
            if (e1 > ent.e1) { ent.e1 = pyRound(e1, 1); ent.e1w = one; ent.e1r = two; }
          }
        } else if (ex.exerciseTypes === "DD") {
          rec.wcardio += two / 60;
        }
      }
    }
  }
  for (const [d, rec] of Object.entries(days)) {
    rec.wprNames = (records[d] || []).slice(0, 6);
    rec.wvol = pyRound(rec.wvol);
    rec.wcardio = pyRound(rec.wcardio);
    rec.wdur = pyRound(rec.wdur);   // whole minutes; the volume tooltip prints it as-is
    rec.wnames = rec.wnames.slice(0, 4).join(", ");
    rec.wex = [...rec.wex.entries()].map(([n, e]) => ({ n, v: pyRound(e.v), s: e.s, mw: e.mw, mr: e.mr, e1: e.e1, e1w: e.e1w, e1r: e.e1r }));
    if (!rec.wsr.length) delete rec.wsr;   // keep the page JSON small on cardio-only days
    if (rec.wsets) { const { mus, unc } = fractionalSets(rec.wex); rec.wmus = mus; rec.wunc = unc; }
    // effort per exercise from the day's working sets, in logged order (wsr order)
    if (rec.wsr) rec.wef = rec.wex.map((_, i) => effortState(rec.wsr.filter((t) => t[0] === i && !(t[3] & SET_WARMUP)).map((t) => [t[1], t[2]])));
    rec.wrankNames = rec.wrankNames.slice(0, 4);
    // session performance: mean e1RM-vs-prior-best across exercises, rounded to a %
    const pr = perfRatios[d];
    rec.wperf = pr && pr.length ? pyRound(pr.reduce((a, b) => a + b, 0) / pr.length, 3) : null;
    if (dayPreset[d]) { rec.wpreset = dayPreset[d]; (presetVol[dayPreset[d]] ||= []).push(rec.wvol); }
  }
  // volume relative to the same routine's median (>=4 runs to have a baseline)
  const presetMed = {};
  for (const [p, vols] of Object.entries(presetVol)) {
    if (vols.length < 4) continue;
    const s = [...vols].sort((a, b) => a - b), n = s.length;
    presetMed[p] = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  for (const rec of Object.values(days)) {
    rec.wvolRel = rec.wpreset && presetMed[rec.wpreset] ? pyRound(rec.wvol / presetMed[rec.wpreset], 3) : null;
  }
  return days;
}

/** Time of day as hours relative to midnight: 21:36 -> -2.4, 06:50 -> 6.83 (ts in epoch seconds). */
function relHour(ts) {
  const p = localParts(ts * 1000);
  const h = p.h + p.min / 60;
  return h > 12 ? h - 24 : h;
}
function hm(ts) {
  const p = localParts(ts * 1000);
  return `${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`;
}

function g(src, ...path) {
  let cur = src;
  for (const p of path) cur = cur && typeof cur === "object" ? cur[p] : undefined;
  return cur === undefined ? null : cur;
}

export function minimalRec(d) {
  return { d, lbl: lblShort(d), wd: wdName(d), dow: weekday(d), wk: lblShort(mondayOf(d)) };
}

/** One raw Ultrahuman daily_metrics payload -> ring summary record (null if empty). */
export function ringRec(raw) {
  const mets = g(raw, "data", "metrics") || {};
  const keys = Object.keys(mets);
  if (!keys.length) return null;
  const daystr = keys[0];
  const m = {};
  for (const x of mets[daystr] || []) if (x && x.object) m[x.type] = x.object;
  const sl = m.sleep || {};
  const bt = sl.bedtime_start, wt = sl.bedtime_end;
  const total = g(sl, "total_sleep", "seconds");
  const tib = g(sl, "time_in_bed", "minutes");
  const rec = {
    ...minimalRec(daystr),
    score: g(sl, "sleep_score", "score"),
    rec: g(m.recovery_index, "value"),
    mov: g(m.movement_index, "value"),
    slh: total ? pyRound(total / 3600, 2) : null,
    tib: tib ? pyRound(tib / 60, 2) : null,
    eff: g(sl, "sleep_efficiency", "percentage"),
    rest: g(sl, "restorative_sleep", "percentage"),
    deep: g(sl, "deep_sleep", "minutes"),
    rem: g(sl, "rem_sleep", "minutes"),
    light: g(sl, "light_sleep", "minutes"),
    hrv: g(m.avg_sleep_hrv, "value"),
    rhr: g(m.sleep_rhr, "value"),
    temp: g(sl, "temperature_deviation", "celsius"),
    steps: g(m.steps, "total"),
    alert: g(m.morning_alertness, "value"),
    toss: g(sl, "tosses_and_turns", "count"),
    vo2: g(m.vo2_max, "value"),
    spo2: g(sl, "spo2", "value"),
    bedRel: bt ? pyRound(relHour(bt), 2) : null,
    wakeRel: wt ? pyRound(relHour(wt), 2) : null,
    bed: bt ? hm(bt) : null,
    wake: wt ? hm(wt) : null,
  };
  const segs = g(sl, "sleep_graph", "data") || [];
  const hyp = segs.filter((s) => s.start && s.end).map((s) => [s.start, s.end, HYP_CODES[s.type] || "aw"]);
  if (hyp.length) rec.hyp = hyp;
  if (rec.steps !== null) rec.steps = Math.trunc(rec.steps);
  return rec;
}

/**
 * ring: {date: ringRec}, workouts: loadWorkouts() output, screentime: {date: {pc, pcEve}}
 * -> sorted day list.
 */
export function mergeDays(ring, workouts, screentime) {
  const merged = {};
  for (const [d, r] of Object.entries(ring)) merged[d] = { ...r };
  for (const [d, w] of Object.entries(workouts || {})) {
    if (!merged[d]) merged[d] = minimalRec(d);
    Object.assign(merged[d], w);
  }
  for (const [d, v] of Object.entries(screentime || {})) {
    if (!merged[d]) merged[d] = minimalRec(d);
    Object.assign(merged[d], v);
  }
  const out = Object.keys(merged).sort().map((d) => merged[d]);
  if (out.some((x) => x.wsets)) for (const x of out) x.trained = x.wsets ? 1 : 0;
  addHrvFields(out);
  return out;
}

// Night HRV against the wearer's own history, on a log scale. Raw rMSSD is
// right-skewed and its level differs between people, so every comparison the
// page makes is ln(hrv) against this person's own nights. Per night with hrv > 0:
//   hrvLn    ln(hrv)
//   hrv7     mean hrvLn over the trailing HRV_ROLL recorded nights, this one
//            included (null with fewer than HRV_ROLL_MIN of them)
//   hrvBase  mean hrvLn over the HRV_BASE_N recorded nights before that window
//   hrvSd    population SD of those same nights (both null below HRV_BASE_MIN)
// Recorded nights, not calendar days: the ring loses about one night in five.
export const HRV_ROLL = 7, HRV_ROLL_MIN = 4, HRV_BASE_N = 60, HRV_BASE_MIN = 20;
export function addHrvFields(days) {
  const idx = [];                          // positions with a usable hrv, in date order
  for (let i = 0; i < days.length; i++) {
    if (days[i].hrv > 0) { days[i].hrvLn = pyRound(Math.log(days[i].hrv), 4); idx.push(i); }
  }
  idx.forEach((pos, k) => {
    const x = days[pos];
    const w0 = Math.max(0, k - HRV_ROLL + 1);
    const win = idx.slice(w0, k + 1).map((i) => days[i].hrvLn);
    x.hrv7 = win.length >= HRV_ROLL_MIN ? pyRound(mean(win), 4) : null;
    const base = idx.slice(Math.max(0, w0 - HRV_BASE_N), w0).map((i) => days[i].hrvLn);
    const ok = base.length >= HRV_BASE_MIN;
    x.hrvBase = ok ? pyRound(mean(base), 4) : null;
    x.hrvSd = ok ? pyRound(pstdev(base), 4) : null;
  });
}
