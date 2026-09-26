// The proactive daily brief (short nights, bedtime target,
// ring charge cadence, hypertrophy habit check, push texts).
import { mean, median, pstdev, pyRound, fmtF, weekday, addDays, daysBetween, mondayOf, hasNight } from "./util.js";
import { GROUPS, muscleGroup, fractionalSets } from "./muscles.js";

// Weekly fractional-set tiers per muscle group. Tiers from Pelland et al. 2025
// meta-regression of 67 studies; between-study marginal means, not this person's curve.
export const SET_MIN_RETURN = 4;         // 1-3 sets: small return; 4-10: most of the return per set
export const SET_HIGH_FROM = 11;         // 11-18: high
export const SET_VERY_HIGH_FROM = 19;    // 19+: very high; not a warning, no demonstrated ceiling
/** Status band for one group's weekly fractional sets: none / low / ok / high / very high. */
export const setStatus = (f7) => (f7 <= 0 ? "none" : f7 < SET_MIN_RETURN ? "low" : f7 < SET_HIGH_FROM ? "ok" : f7 < SET_VERY_HIGH_FROM ? "high" : "very high");

// morning push rules (see the push section of the README)
export const PUSH_LOW_SETS = SET_MIN_RETURN;   // (a) a main group under this many fractional sets in the last 7 days
export const PUSH_Z = 1.5;               // (b) SDs from the trailing mean, both of the last two nights
export const PUSH_RING_BASE = 60;        // (b) recorded nights the mean and SD are built from
export const PUSH_RING_BASE_MIN = 14;    // (b) fewer than this and the rule stays quiet
export const PUSH_PR_DAYS = 60;          // (c) no PR on the lift in this many days before the session
export const EVENING_HOLD_MIN = 20;      // bedtime within this of the target three nights running: no nudge

// AASM/SRS 2015 consensus (Watson et al., Sleep 38(6):843-844): adults should
// sleep 7 or more hours per night on a regular basis. Every "under 7h" figure
// in the brief, the push texts and the page is built from this one constant.
// claim: sleep-7h-floor
export const NEED_H = 7.0;
export const SESSIONS_TARGET = 3;
export const SCREEN_OFF_MIN = 40;
// Half-width of the "your band" HRV band in SDs of his own ln(HRV). A
// convention, not a threshold from the literature: half of his own
// night-to-night SD either side of the 60-night baseline (summarize.js addHrvFields).
export const HRV_BAND_SD = 0.5;

// exercise -> muscle group lives in muscles.js (one table, fractional credit for assists);
// muscleGroup is re-exported so existing callers keep working
export { muscleGroup };
const GROUP_ORDER = [...GROUPS, "other"];
// the main groups the actions, the push rules and the weekly plan pick from
const MAIN = ["quads", "hamstrings/glutes", "calves", "chest", "back", "shoulders", "biceps", "triceps"];

// weekly plan (one ask per ISO week, Mon-Sun, scored on the next week's first refresh)
export const PLAN_TARGET = 4;            // fractional sets the week must reach for a "hit"
export const PLAN_MIN_SETS = 3;          // the ask never drops below this many sets
const PLAN_HISTORY = 8;                  // completed weeks the Today card lists
const WD3 = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const GROUP_NOUN = {
  quads: "a quad exercise", "hamstrings/glutes": "a hamstring or glute exercise", calves: "a calf exercise",
  chest: "a chest exercise", back: "a back exercise", shoulders: "a shoulder exercise",
  biceps: "a biceps exercise", triceps: "a triceps exercise",
};

/** {group: fractionalSets} for one day: the wmus the pipeline emitted, or recomputed from wex. */
const dayMus = (d) => d.wmus || fractionalSets(d.wex).mus;
const isLift = (d) => (d.wvol || 0) > 0;
const fmtSets = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Fractional sets of one group logged in the ISO week that starts on weekStart (a Monday). */
export function weekSets(days, weekStart, group) {
  let n = 0;
  for (const d of days) {
    const k = daysBetween(weekStart, d.d);
    if (k >= 0 && k < 7 && isLift(d)) n += dayMus(d)[group] || 0;
  }
  return n;
}

/** The exercise with the most logged sets whose primary group is `group`, from his own history; null if none. */
export function topExerciseFor(lifts, group) {
  const cnt = {};
  for (const d of lifts) for (const e of d.wex || []) if (muscleGroup(e.n) === group) cnt[e.n] = (cnt[e.n] || 0) + (e.s || 0);
  const best = Object.entries(cnt).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best ? best[0] : null;
}

/**
 * This week's plan: the main group with the fewest fractional sets in the last 7
 * days (ties: the lowest 28-day weekly average), PLAN_TARGET sets in the ISO week,
 * asked as `sets` per session on the usual lifting weekdays still ahead (today
 * counts; the next two days when none remain). groups: the brief's training.groups.
 * Fixed for the week once stored; only the sentence is recomputed each refresh.
 */
export function makePlan(days, today, groups) {
  const cand = (groups || []).filter((g) => MAIN.includes(g.group));
  if (!cand.length) return null;
  // every main group under the weekly target, lowest first, at most three; the
  // first one is the group the week is scored on (state/plan.json)
  const low = cand.filter((g) => g.fsets7 < PLAN_TARGET)
    .sort((a, b) => a.fsets7 - b.fsets7 || a.fsetsWkAvg28 - b.fsetsWkAvg28).slice(0, 3);
  const picks = low.length ? low : [cand.reduce((a, g) => (g.fsets7 < a.fsets7 || (g.fsets7 === a.fsets7 && g.fsetsWkAvg28 < a.fsetsWkAvg28) ? g : a))];
  const pick = picks[0];
  const lifts = days.filter(isLift);
  const weekStart = mondayOf(today);
  const wd = weekday(today);
  let planned = usualLiftDays(lifts, today).filter((x) => x >= wd).slice(0, 2).sort((a, b) => a - b);
  if (!planned.length) planned = [wd + 1, wd + 2].filter((x) => x <= 6);
  if (!planned.length) planned = [wd];
  // sets per planned session: the remainder of the target spread over the days, never under PLAN_MIN_SETS
  const done = weekSets(days, weekStart, pick.group);
  const sets = Math.max(PLAN_MIN_SETS, Math.ceil((PLAN_TARGET - done) / planned.length));
  const items = picks.map((g) => ({ group: g.group, exercise: topExerciseFor(lifts, g.group), fsets7: g.fsets7 }));
  return { weekStart, group: pick.group, exercise: items[0].exercise, sets, target: PLAN_TARGET, days: planned, createdAt: today, items };
}

/**
 * The one sentence for a plan as of today: the ask with its days, the missed
 * branch once a planned day went by with no session, done once the week's
 * target is reached. Returns {text, push, state: "open" | "missed" | "done", done, when, todo}
 * where todo is one {group, exercise, sets, week} per group for the plan bar boxes.
 */
export function planSentence(plan, days, today) {
  const wd = weekday(today);
  // plans stored before items existed carry one group only
  const items = plan.items && plan.items.length ? plan.items : [{ group: plan.group, exercise: plan.exercise, fsets7: null }];
  const name = (it) => it.exercise || GROUP_NOUN[it.group] || `a ${it.group} exercise`;
  const what = items.map((it) => `${plan.sets} sets of ${name(it)}`).join(" and ");
  const gaps = items.map((it) => (it.fsets7 == null ? it.group : `${it.group} ${fmtSets(it.fsets7)}`)).join(", ");
  const done = weekSets(days, plan.weekStart, plan.group);
  // todo: the same ask as boxes for the plan bar, with this ISO week's sets per group so far
  const todo = items.map((it) => ({ group: it.group, exercise: name(it), sets: plan.sets,
    week: pyRound(weekSets(days, plan.weekStart, it.group), 1) }));
  // text is the page sentence; push is the same ask in at most two sentences for the morning notification
  if (done >= plan.target) {
    const t = `Done: ${plan.group} at ${fmtSets(done)} of ${plan.target} sets this week. Checked Sunday.`;
    return { text: t, push: t, state: "done", done, when: null, todo };
  }
  const sessionDays = new Set(days.filter(isLift).map((d) => d.d));
  const missed = plan.days.filter((x) => x < wd && !sessionDays.has(addDays(plan.weekStart, x)));
  if (missed.length) {
    const t = `Missed ${WD3[missed[0]]}. Tonight, 15 minutes: ${what}.`;
    return { text: t, push: t, state: "missed", done, when: "Tonight", todo };
  }
  const ahead = plan.days.filter((x) => x >= wd);
  const lead = `Under ${plan.target} sets in the last 7 days: ${gaps}.`;
  const shortLead = `${capFirst(gaps)} sets in the last 7 days.`;
  if (!ahead.length) return { text: `${lead} Still open: ${what} before Sunday night. Checked Sunday.`, push: `${shortLead} ${capFirst(what)} before Sunday night.`, state: "open", done, when: "By Sunday", todo };
  const on = ahead.map((x) => WD3[x]).join(" and ");
  return { text: `${lead} Add ${what} on ${on}. Checked Sunday.`, push: `${shortLead} Add ${what} on ${on}.`, state: "open", done,
    when: ahead[0] === wd ? "Today" : on, todo };
}

/** Score a stored week from the set log: {achieved, result: "hit" | "miss"}. */
export function evaluatePlan(plan, days) {
  const achieved = pyRound(weekSets(days, plan.weekStart, plan.group), 1);
  return { achieved, result: achieved >= plan.target ? "hit" : "miss" };
}

/**
 * Consecutive completed ISO weeks, ending last week, in which every main group
 * reached PLAN_TARGET fractional sets. Only weeks fully inside the data window count.
 */
export function streak4(days, today) {
  if (!days.length || !days.some(isLift)) return 0;
  const first = days[0].d;
  let ws = addDays(mondayOf(today), -7), n = 0;
  while (ws >= first) {
    if (!MAIN.every((g) => weekSets(days, ws, g) >= PLAN_TARGET)) break;
    n++; ws = addDays(ws, -7);
  }
  return n;
}

function hmRel(hoursRel) {
  const m = ((Math.round(hoursRel * 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function minutesOfDay(hoursRel) {
  return ((Math.round(hoursRel * 60) % 1440) + 1440) % 1440;
}
function fmtHm(h) {
  if (h == null) return "-";
  const m = Math.round(h * 60);
  return m % 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${Math.floor(m / 60)}h`;
}
const meanN = (v) => { const w = v.filter((x) => x != null); return w.length ? mean(w) : null; };
const capFirst = (s) => s[0].toUpperCase() + s.slice(1);

/**
 * (a) His usual lifting weekdays: the two or three weekdays with the most
 * sessions in the last 8 weeks. A weekday counts when it has at least 2
 * sessions and at least half the busiest day's count; the top 3 are kept.
 * Returns weekday numbers (0 = Monday, util.weekday).
 */
export function usualLiftDays(lifts, today) {
  const cnt = Array(7).fill(0);
  for (const d of lifts) { const age = daysBetween(d.d, today); if (age >= 0 && age < 56) cnt[weekday(d.d)]++; }
  const top = Math.max(...cnt);
  return cnt.map((c, wd) => [c, wd]).filter(([c]) => c >= 2 && c * 2 >= top)
    .sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, wd]) => wd);
}

/**
 * (b) A ring metric more than PUSH_Z SDs from its trailing mean on each of the
 * last two recorded nights, same side both nights. The mean and SD come from
 * the PUSH_RING_BASE recorded nights before those two. hrvLn (log HRV) is
 * tested when the records carry it, else raw hrv; then rhr, then temp. Returns
 * [tag, title, sentence] or null.
 */
export function ringOutlier(nights, today) {
  if (!nights.length || daysBetween(nights[nights.length - 1].d, today) > 1) return null;
  const hasLn = nights.some((n) => n.hrvLn != null);
  const metrics = [
    [hasLn ? "hrvLn" : "hrv", "HRV", (v) => `${Math.round(v)} ms`, hasLn ? (v) => Math.exp(v) : (v) => v],
    ["rhr", "Resting HR", (v) => String(Math.round(v)), (v) => v],
    ["temp", "Skin temperature", (v) => `${v >= 0 ? "+" : ""}${fmtF(v, 1)} C`, (v) => v],
  ];
  for (const [k, label, fmt, shown] of metrics) {
    const rec = nights.filter((n) => n[k] != null);
    if (rec.length < 2 + PUSH_RING_BASE_MIN) continue;
    const two = rec.slice(-2);
    if (daysBetween(two[0].d, today) > 2) continue;              // the pair must be recent, not from before a ring gap
    const base = rec.slice(-2 - PUSH_RING_BASE, -2).map((n) => n[k]);
    const m = mean(base), sd = pstdev(base);
    if (!(sd > 0)) continue;
    const z = two.map((n) => (n[k] - m) / sd);
    const high = z.every((v) => v > PUSH_Z), low = z.every((v) => v < -PUSH_Z);
    if (!high && !low) continue;
    const dir = high ? "high" : "low";
    const [a, b] = two.map((n) => fmt(shown(n[k])));
    return ["ring", `${label} ${dir} two nights running`,
      `${label} has been ${dir} two nights running (${a} and ${b} vs your usual ${fmt(shown(m))}).`];
  }
  return null;
}

/**
 * (c) Yesterday's session logged a record (our own detection, wprNames) or a
 * Liftoff rank-up on a lift that had neither in the PUSH_PR_DAYS before it,
 * and that was already being logged before that window (so a new exercise's
 * second session does not count). Returns [tag, title, sentence] or null.
 */
export function firstPrInDays(lifts, today, unit = "lb") {
  const last = lifts[lifts.length - 1];
  if (!last || daysBetween(last.d, today) > 1) return null;
  const nameOf = (s) => s.replace(/ \S+x\S+$/, "");               // "Bench Press 95x12" -> "Bench Press"
  const setOf = (s) => { const m = /(\S+)x(\S+)$/.exec(s); return m ? `${m[1]} ${unit} x ${m[2]}` : null; };
  const prior = lifts.filter((d) => d.d < last.d && daysBetween(d.d, last.d) <= PUSH_PR_DAYS);
  const had = new Set(prior.flatMap((d) => [...(d.wprNames || []).map(nameOf), ...(d.wrankNames || [])]));
  const cands = [...(last.wprNames || []).map((s) => [nameOf(s), setOf(s)]), ...(last.wrankNames || []).map((n) => [n, null])];
  for (const [n, set] of cands) {
    if (had.has(n)) continue;
    if (!lifts.some((d) => daysBetween(d.d, last.d) > PUSH_PR_DAYS && (d.wex || []).some((x) => x.n === n))) continue;
    const e = (last.wex || []).find((x) => x.n === n);
    const top = set || (e && e.mw ? `${e.mw} ${unit} x ${e.mr}` : null);
    return ["pr", `First PR on ${n} in ${PUSH_PR_DAYS}+ days`, `First PR on ${n} in ${PUSH_PR_DAYS}+ days${top ? `: ${top}.` : "."}`];
  }
  return null;
}

export const TREND_DAYS = 90;
export const TREND_MIN_SESSIONS = 6;
// two-tailed 95% t critical values by degrees of freedom (n - 2); 1.96 beyond 30
const T95 = { 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179,
  13: 2.160, 14: 2.145, 15: 2.131, 16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.080, 22: 2.074,
  23: 2.069, 24: 2.064, 25: 2.060, 26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042 };
export const tCrit95 = (df) => (df <= 30 ? (T95[df] ?? 2.776) : 1.96);

/**
 * One lift's 90-day trend. sessions: [{d, e1}] in date order, one per session day
 * (best-set e1RM). Ordinary least squares of e1 on days since the first session;
 * the slope's 95% CI (t, n-2 df) decides the state so a single extra rep cannot
 * flip a lift. Returns {n, slopePerWeek, ci: [lo, hi], state, e1Now, e1Prev, resid}
 * where resid is each session's residual in units of the residual SD.
 */
export function liftTrend(sessions) {
  const n = sessions.length;
  const out = { n, slopePerWeek: null, ci: null, state: "not enough sessions", e1Now: null, e1Prev: null, resid: [] };
  if (!n) return out;
  out.e1Now = pyRound(sessions[n - 1].e1);
  out.e1Prev = pyRound(sessions[0].e1);
  if (n < 3) return out;
  const x = sessions.map((s) => daysBetween(sessions[0].d, s.d)), y = sessions.map((s) => s.e1);
  const mx = mean(x), my = mean(y);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  if (!sxx) return out;
  const slope = sxy / sxx, icpt = my - slope * mx;
  let sse = 0;
  const res = x.map((xi, i) => { const r = y[i] - (icpt + slope * xi); sse += r * r; return r; });
  const df = n - 2;
  const sd = Math.sqrt(sse / df);
  const se = sd / Math.sqrt(sxx);
  const t = tCrit95(df);
  out.slopePerWeek = pyRound(slope * 7, 2);
  out.ci = [pyRound((slope - t * se) * 7, 2), pyRound((slope + t * se) * 7, 2)];
  out.resid = sessions.map((s, i) => ({ d: s.d, z: sd ? pyRound(res[i] / sd, 2) : 0 }));
  if (n >= TREND_MIN_SESSIONS) out.state = out.ci[0] > 0 ? "stronger" : out.ci[1] < 0 ? "weaker" : "flat";
  return out;
}

export const WEEKLY_WEEKS = 12;
export const WEEKLY_MEDIAN_WEEKS = 4;
// the smallest weekly dose with a measured return, the faint reference line on the chart
// claim: sets-growth-range
export const WEEKLY_MIN_DOSE = 4;

/**
 * Fractional sets per muscle group by ISO week (Mon-Sun), the last `weeks`
 * weeks ending with the week that holds `today` (default: the last day in the
 * list). Oldest first. Each entry: {start, end, partial, sessions, mus:
 * {group: fractionalSets}}; partial is true while today is inside the week.
 * Weeks with no session carry an empty mus.
 */
export function weeklySets(days, weeks = WEEKLY_WEEKS, today = null) {
  const last = today || (days.length ? days[days.length - 1].d : null);
  if (!last) return [];
  const curMon = mondayOf(last);
  const out = [];
  for (let k = weeks - 1; k >= 0; k--) {
    const start = addDays(curMon, -7 * k);
    out.push({ start, end: addDays(start, 6), partial: k === 0, sessions: 0, mus: {} });
  }
  const byStart = Object.fromEntries(out.map((w) => [w.start, w]));
  for (const d of days) {
    if (!(d.wvol || 0) && !d.wsets) continue;
    const w = byStart[mondayOf(d.d)];
    if (!w) continue;
    w.sessions++;
    for (const [g, v] of Object.entries(dayMus(d))) w.mus[g] = pyRound((w.mus[g] || 0) + v, 2);
  }
  return out;
}

/**
 * Ordinal read of one full week's sets against a median: "well below" under
 * 50% of the median, "below" under 75%, "above" over 125%, else "steady".
 * A zero median reads steady at zero and above otherwise.
 */
export function setsRead(sets, med) {
  if (!(med > 0)) return sets > 0 ? "above" : "steady";
  const r = sets / med;
  return r < 0.5 ? "well below" : r < 0.75 ? "below" : r > 1.25 ? "above" : "steady";
}

/** "below" | "in" | "above" the night's own band, null without a baseline. */
export function hrvState(n) {
  if (!n || n.hrvLn == null || n.hrvBase == null || n.hrvSd == null) return null;
  const half = HRV_BAND_SD * n.hrvSd;
  return n.hrvLn < n.hrvBase - half ? "below" : n.hrvLn > n.hrvBase + half ? "above" : "in";
}

/**
 * days: merged day list (mergeDays); today: YYYY-MM-DD local; planStore
 * (optional): {weeks: [...]} from state/plan.json. With a store the current
 * week's plan is the stored one (only its sentence is recomputed) and
 * training.planHistory lists the scored weeks; without one the plan is built
 * fresh and the history is empty.
 */
export function computeBrief(days, today, planStore = null, unit = "lb") {
  const nights = days.filter(hasNight);
  const out = { generated: today, hasSleep: nights.length > 0, unit };
  if (!nights.length) { out.push = {}; return out; }
  const last = nights[nights.length - 1];
  const base = nights.length > 8 ? nights.slice(-29, -1) : nights.slice(0, -1);
  const b = {};
  for (const k of ["slh", "score", "rec", "hrv", "rhr"]) b[k] = meanN(base.map((n) => n[k]));
  // calendar windows over recorded nights only: the ring loses about one night in
  // five to charging, so every count says how many nights it is built from
  const slept = nights.filter((n) => n.slh != null);
  const recent14 = slept.filter((n) => daysBetween(n.d, today) < 14);
  const nights14 = recent14.length;
  const shortNights14 = recent14.filter((n) => n.slh < NEED_H).length;
  // sum of shortfalls: a long night never repays a short one
  const hoursBelow14 = recent14.reduce((a, n) => a + Math.max(0, NEED_H - n.slh), 0);
  const week = slept.filter((n) => daysBetween(n.d, today) < 7);
  const short7 = week.filter((n) => n.slh < NEED_H).length;
  const needLbl = fmtHm(NEED_H);
  const lastIsFresh = daysBetween(last.d, today) <= 1;

  out.sleep = {
    night: last.d, fresh: lastIsFresh,
    slh: last.slh, score: last.score, rec: last.rec, hrv: last.hrv, rhr: last.rhr,
    hrvLn: last.hrvLn ?? null, hrv7: last.hrv7 ?? null, hrvBase: last.hrvBase ?? null, hrvSd: last.hrvSd ?? null,
    hrvState: hrvState(last),
    bed: last.bed ?? null, wake: last.wake ?? null,
    base: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v == null ? null : pyRound(v, 1)])),
    needH: NEED_H, shortNights14, nights14, hoursBelow14: pyRound(hoursBelow14, 1), short7, nights7: week.length,
    bedSdMin: nights.length >= 5 ? Math.round(pstdev(nights.slice(-28).map((n) => n.bedRel)) * 60) : null,
    wakeSdMin: nights.length >= 5 ? Math.round(pstdev(nights.slice(-28).map((n) => n.wakeRel)) * 60) : null,
  };

  // tonight's bedtime target: expected wake for tomorrow's day type
  const tomorrow = addDays(today, 1);
  const weekend = weekday(tomorrow) >= 5;
  const sameType = nights.slice(-56).filter((n) => (weekday(n.d) >= 5) === weekend);
  const wakeRef = sameType.length >= 4 ? sameType.slice(-14) : nights.slice(-14);
  const wakeRel = median(wakeRef.map((n) => n.wakeRel));
  const effs = nights.slice(-28).filter((n) => n.eff).map((n) => n.eff);
  const eff = effs.length ? median(effs) : 89;
  const tibNeeded = NEED_H / (eff / 100);
  const targetRel = wakeRel - tibNeeded;
  const targetMin = minutesOfDay(targetRel);
  let nudgeMin = targetMin - SCREEN_OFF_MIN;
  if (targetMin < 12 * 60) nudgeMin = 23 * 60 + 20;
  nudgeMin = Math.max(20 * 60 + 30, Math.min(23 * 60 + 20, nudgeMin));
  out.bedtime = {
    target: hmRel(targetRel), wake: hmRel(wakeRel), wakeDayType: weekend ? "weekend" : "weekday",
    tibNeeded: pyRound(tibNeeded, 2), eff: Math.round(eff),
    screensOff: `${String(Math.floor(nudgeMin / 60)).padStart(2, "0")}:${String(nudgeMin % 60).padStart(2, "0")}`,
    nudgeMinutes: nudgeMin,
  };

  // ring gaps (nights with no sleep record); only dates before today count
  const have = new Set(nights.map((n) => n.d));
  const first = nights[0].d;
  const spanEnd = daysBetween(today, last.d) > 0 ? last.d : today;
  const gaps = [];
  for (let i = 0; i <= daysBetween(first, spanEnd); i++) {
    const d = addDays(first, i);
    if (!have.has(d) && d < today) gaps.push(d);
  }
  const gapStarts = gaps.filter((g, i) => i === 0 || daysBetween(gaps[i - 1], g) > 1);
  let cadence = null;
  if (gapStarts.length >= 3) cadence = median(gapStarts.slice(1).map((g, i) => daysBetween(gapStarts[i], g)));
  // measured from the last missing night (the end of the last gap run), not its
  // start: after a multi-night gap the ring went back on when the run ended
  const sinceGap = gaps.length ? daysBetween(gaps[gaps.length - 1], today) : null;
  const chargeDue = !!(cadence && sinceGap != null && sinceGap >= cadence - 1);
  out.ring = { missingNights: gaps.length, sinceGapDays: sinceGap, cadenceDays: cadence, chargeDue, lastNightMissing: !lastIsFresh };
  const sinceGapLbl = `${sinceGap} day${sinceGap === 1 ? "" : "s"}`;

  // training / hypertrophy habits
  const lifts = days.filter((d) => (d.wvol || 0) > 0);
  const within = (d, n) => daysBetween(d.d, today) < n;
  const l7 = lifts.filter((d) => within(d, 7));
  const l28 = lifts.filter((d) => within(d, 28));
  // sets7/sets28: direct sets, primary group only. fsets7/fsets28: fractional,
  // primary 1.0 plus each assisting group at SECONDARY_W (muscles.js), from wmus.
  const sets7 = {}, sets28 = {}, fsets7 = {}, fsets28 = {};
  for (const d of l7) for (const e of d.wex || []) { const g = muscleGroup(e.n); sets7[g] = (sets7[g] || 0) + (e.s || 0); }
  for (const d of l28) for (const e of d.wex || []) { const g = muscleGroup(e.n); sets28[g] = (sets28[g] || 0) + (e.s || 0); }
  for (const d of l7) for (const [g, v] of Object.entries(dayMus(d))) fsets7[g] = (fsets7[g] || 0) + v;
  for (const d of l28) for (const [g, v] of Object.entries(dayMus(d))) fsets28[g] = (fsets28[g] || 0) + v;
  const groups = [];
  for (const g of GROUP_ORDER) {
    if (["other", "forearms", "core"].includes(g) && !sets28[g] && !sets7[g] && !fsets28[g] && !fsets7[g]) continue;
    const wkAvg = (sets28[g] || 0) / 4;
    const s7 = sets7[g] || 0;
    const f7 = fsets7[g] || 0;
    // status is banded on the fractional count; 0 this week is "none" even if trained earlier in the month
    let status = setStatus(f7);
    if (["core", "forearms", "other"].includes(g)) status = "info";
    // days since the last day whose wmus had this group above 0; null if never
    let lastSetDaysAgo = null;
    for (let i = lifts.length - 1; i >= 0; i--) {
      if ((dayMus(lifts[i])[g] || 0) > 0) { lastSetDaysAgo = daysBetween(lifts[i].d, today); break; }
    }
    groups.push({ group: g, sets7: s7, setsWkAvg28: pyRound(wkAvg, 1), fsets7: f7, fsetsWkAvg28: pyRound((fsets28[g] || 0) / 4, 1), status, lastSetDaysAgo });
  }
  // per-lift 90-day e1RM trend (liftTrend): stronger / flat / weaker / not enough sessions
  const series = {};
  // effort per lift over the same window, from the pipeline's rep drop-off read
  // (summarize.js effortState, day.wef aligned with day.wex). n counts the
  // sessions with a read, capped included; "not computable" ones are left out.
  const effortOf = (d, i) => (d.wef || [])[i] || "not computable";
  const EFFORT_KEY = { "near failure": "nearFailure", moderate: "moderate", easy: "easy", capped: "capped" };
  const effort = {};
  for (const d of lifts) {
    if (!within(d, TREND_DAYS)) continue;
    (d.wex || []).forEach((e, i) => {
      if (e.e1) (series[e.n] ||= []).push({ d: d.d, e1: e.e1 });
      const k = EFFORT_KEY[effortOf(d, i)];
      const ef = effort[e.n] ||= { n: 0, nearFailure: 0, moderate: 0, easy: 0, capped: 0 };
      if (k) { ef.n++; ef[k]++; }
    });
  }
  const prog = [];
  for (const [n, sessions] of Object.entries(series)) {
    const t = liftTrend(sessions);
    // pct: first to last session in the window, kept for the weekly note's wording
    const pct = t.e1Prev ? pyRound((t.e1Now - t.e1Prev) / t.e1Prev * 100, 1) : null;
    prog.push({ lift: n, ...t, pct, effort: effort[n] || { n: 0, nearFailure: 0, moderate: 0, easy: 0, capped: 0 } });
  }
  // last 28 days, every exercise-session: hardShare = near failure or moderate as a
  // share of the sessions with a read (capped included), cappedShare likewise
  const es = { sessions: 0, computable: 0, nearFailure: 0, moderate: 0, easy: 0, capped: 0 };
  for (const d of l28) (d.wex || []).forEach((_, i) => {
    es.sessions++;
    const k = EFFORT_KEY[effortOf(d, i)];
    if (k) { es.computable++; es[k]++; }
  });
  const effortSummary = {
    ...es,
    hardShare: es.computable ? pyRound((es.nearFailure + es.moderate) / es.computable * 100) : null,
    cappedShare: es.computable ? pyRound(es.capped / es.computable * 100) : null,
  };
  const RANK = { stronger: 0, weaker: 0, flat: 1, "not enough sessions": 2 };
  prog.sort((a, b) => RANK[a.state] - RANK[b.state] || Math.abs(b.slopePerWeek || 0) - Math.abs(a.slopePerWeek || 0));
  const up = prog.filter((p) => p.state === "stronger").length, flat = prog.filter((p) => p.state === "flat").length,
    down = prog.filter((p) => p.state === "weaker").length, na = prog.filter((p) => p.state === "not enough sessions").length;
  const lastLift = lifts.length ? lifts[lifts.length - 1].d : null;
  const prs7 = l7.flatMap((d) => d.wprNames || []);
  const rank7 = l7.flatMap((d) => d.wrankNames || []);
  const sets7Total = l7.reduce((a, d) => a + (d.wsets || 0), 0);
  const fail7 = l7.reduce((a, d) => a + (d.wfail || 0), 0);
  const yday = lifts.find((d) => d.d === addDays(today, -1));
  out.training = {
    streak: lastLift ? (lifts[lifts.length - 1].wstreak || null) : null,
    prs7, rankUps7: rank7, liftoffPrs7: l7.reduce((a, d) => a + (d.wpr || 0), 0),
    failSets7: fail7, failShare7: sets7Total ? pyRound(fail7 / sets7Total * 100) : null,
    ydayPrs: yday ? (yday.wprNames || []) : [],
    sessions7: l7.length, sessionsWkAvg28: pyRound(l28.length / 4, 1), target: SESSIONS_TARGET,
    daysSinceLift: lastLift ? daysBetween(lastLift, today) : null,
    lastLift, lastLiftNames: lastLift ? (lifts[lifts.length - 1].wnames || "") : "",
    groups, setMinReturn: SET_MIN_RETURN, setHighFrom: SET_HIGH_FROM, setVeryHighFrom: SET_VERY_HIGH_FROM,
    progress: prog, progUp: up, progFlat: flat, progDown: down, progNA: na, progDays: TREND_DAYS, progMinSessions: TREND_MIN_SESSIONS,
    effortSummary,
    prs28: l28.reduce((a, d) => a + (d.wpr || 0), 0),
    records28: l28.reduce((a, d) => a + (d.wprNames || []).length, 0),
    bodyweightTracked: new Set(l28.filter((d) => d.wbody).map((d) => d.wbody)).size > 1,
  };
  // the week's one ask (makePlan / planSentence) and the record of past weeks
  const stored = planStore && Array.isArray(planStore.weeks) ? planStore.weeks : null;
  const weekStart = mondayOf(today);
  const plan = lifts.length ? ((stored && stored.find((w) => w.weekStart === weekStart)) || makePlan(days, today, groups)) : null;
  if (plan) {
    const s = planSentence(plan, days, today);
    out.training.plan = { ...plan, sentence: s.text, push: s.push, state: s.state, done: pyRound(s.done, 1), when: s.when, todo: s.todo };
  } else out.training.plan = null;
  out.training.planHistory = (stored || []).filter((w) => w.result && w.weekStart < weekStart).slice(-PLAN_HISTORY)
    .map((w) => ({ weekStart: w.weekStart, group: w.group, achieved: w.achieved, target: w.target, result: w.result }));
  out.training.streak4 = streak4(days, today);

  // sets per muscle by ISO week, for the "Sets per muscle, by week" chart: the two
  // main groups with the lowest fsetsWkAvg28 and the one with the highest (ties keep
  // GROUP_ORDER), each with an ordinal read of the last full week against the
  // median of the WEEKLY_MEDIAN_WEEKS full weeks before it
  const MAIN_GROUPS = ["quads", "hamstrings/glutes", "calves", "chest", "back", "shoulders", "biceps", "triceps"];
  const weeks = weeklySets(lifts, WEEKLY_WEEKS, today);
  const mainG = groups.filter((g) => MAIN_GROUPS.includes(g.group));
  const asc = [...mainG].sort((a, b) => a.fsetsWkAvg28 - b.fsetsWkAvg28);
  const desc = [...mainG].sort((a, b) => b.fsetsWkAvg28 - a.fsetsWkAvg28);
  const picks = [];
  for (const g of asc.slice(0, 2)) picks.push({ group: g.group, role: "low" });
  if (desc.length && !picks.some((p) => p.group === desc[0].group)) picks.push({ group: desc[0].group, role: "ref" });
  const full = weeks.filter((w) => !w.partial);
  const lastFull = full[full.length - 1] || null;
  const medWeeks = full.slice(-1 - WEEKLY_MEDIAN_WEEKS, -1);
  for (const p of picks) {
    const n = lastFull ? (lastFull.mus[p.group] || 0) : 0;
    const m = medWeeks.length ? median(medWeeks.map((w) => w.mus[p.group] || 0)) : 0;
    p.lastFull = pyRound(n, 1); p.median = pyRound(m, 1); p.read = setsRead(n, m);
  }
  out.training.weekly = { weeks, picks, medianWeeks: WEEKLY_MEDIAN_WEEKS, minDose: WEEKLY_MIN_DOSE };

  // actions (ranked, max 3)
  const actions = [];
  if (hoursBelow14 >= 5) {
    actions.push(["sleep", `${fmtF(hoursBelow14, 1)}h under ${needLbl} across ${shortNights14} of ${nights14} recorded nights in the last 14 days.`]);
  } else if (short7 >= 3) {
    actions.push(["sleep", `${short7} of ${week.length} recorded nights under ${needLbl} in the last 7 days. Bed by ${out.bedtime.target} tonight.`]);
  }
  // both lists are banded on fsets7 (setStatus), the same count the body map and the push rule use
  const untrained = groups.filter((g) => g.status === "none" && MAIN.includes(g.group)).map((g) => g.group);
  const low = groups.filter((g) => g.status === "low" && MAIN.includes(g.group)).map((g) => g.group);
  if (untrained.length) {
    // claim: sets-growth-range, sets-maintenance-dose
    actions.push(["training", `No sets for ${untrained.join(", ")} in the last 7 days. Most of the growth per set comes between ${SET_MIN_RETURN} and ${SET_HIGH_FROM - 1} fractional sets a week; about a third of your usual volume holds size, and none at all loses it.`]);
  } else if (low.length) {
    // claim: sets-growth-range
    actions.push(["training", `Under ${SET_MIN_RETURN} weekly sets counting assists for ${low.join(", ")}: the small-return band.`]);
  }
  if (lastLift && l7.length < SESSIONS_TARGET && daysBetween(lastLift, today) >= 3) {
    actions.push(["training", `${daysBetween(lastLift, today)} days since the last session (${l7.length} in the last 7 days, target ${SESSIONS_TARGET}).`]);
  }
  if (chargeDue) {
    actions.push(["ring", `Charge the ring tonight: ${sinceGapLbl} since it last missed a night, and it usually needs charging every ${fmtF(cadence, 0)} days or so.`]);
  }
  if (down && down >= Math.max(1, up)) {
    actions.push(["training", `${down} lift(s) with a falling best e1RM over the last ${TREND_DAYS} days, ${up} rising. Progression has stalled - add a rep or ${unit === "kg" ? "1 kg" : "2.5 lb"} next session.`]);
  }
  out.actions = actions.slice(0, 3).map(([tag, text]) => ({ tag, text }));

  // push texts. The morning push exists only when a rule fires: a fixed daily
  // brief gets ignored within a month. Rules, in the order they win:
  //   (b) a ring metric outside its usual range two nights running
  //   (a) a planned day of the week's plan carries the plan sentence; otherwise a usual
  //       lifting weekday with a main muscle group under PUSH_LOW_SETS fractional sets this week
  //   (c) yesterday's session set the first record on a lift in PUSH_PR_DAYS days
  // The first rule gives the title and tag; one more rule may add its sentence.
  const fired = [];
  const ringFlag = ringOutlier(nights, today);
  if (ringFlag) fired.push(ringFlag);
  const wkPlan = out.training.plan;
  if (wkPlan && wkPlan.state !== "done" && wkPlan.days.includes(weekday(today))) {
    fired.push(["lift", "Lifting day", wkPlan.push || wkPlan.sentence]);
  } else if (usualLiftDays(lifts, today).includes(weekday(today))) {
    // fractional count (fsets7), the same one status and the body map are banded on, so a
    // group with 3 direct sets and 9 counting assists is not "low"
    const cand = groups.filter((g) => MAIN.includes(g.group) && g.fsets7 < PUSH_LOW_SETS);
    if (cand.length) {
      const lowest = cand.reduce((a, g) => (g.fsets7 < a.fsets7 ? g : a));   // ties keep GROUP_ORDER
      const n = pyRound(lowest.fsets7, 1);
      fired.push(["lift", "Lifting day", `${capFirst(lowest.group)}: ${n} ${n === 1 ? "set" : "sets"} this week counting assists. Add 3 sets today.`]);
    }
  }
  const prFlag = firstPrInDays(lifts, today, unit);
  if (prFlag) fired.push(prFlag);
  let morning = null;
  if (fired.length) {
    const [tag, title, sentence] = fired[0];
    let body = sentence;
    if (fired[1] && `${body} ${fired[1][2]}`.length <= 240) body = `${body} ${fired[1][2]}`;
    morning = { title, body, tag: `morning-${tag}`, rules: fired.map((f) => f[0]) };
  }

  // bedtime nudge: skipped while the habit holds (last 3 recorded bedtimes all
  // within EVENING_HOLD_MIN of the target)
  const last3 = nights.filter((n) => n.bedRel != null).slice(-3);
  const holding = last3.length === 3 && last3.every((n) => Math.abs(n.bedRel - targetRel) * 60 <= EVENING_HOLD_MIN);
  let evening = null;
  if (!holding) {
    const evTitle = `Bed by ${out.bedtime.target} tonight`;
    let evBody = `Screens off ${out.bedtime.screensOff} for ${needLbl} asleep before a ${out.bedtime.wake} wake. Last 7 days: ${short7} of ${week.length} recorded nights under ${needLbl}; last 14 days: ${fmtF(hoursBelow14, 1)}h short in total.`;
    if (chargeDue) evBody += ` Charge the ring first (${sinceGapLbl} since the last missing night).`;
    evening = { title: evTitle, body: evBody.slice(0, 240), tag: "evening", atMinutes: nudgeMin };
  }
  out.push = { morning, evening, eveningHolding: holding };
  return out;
}
