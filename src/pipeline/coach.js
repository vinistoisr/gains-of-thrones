// The coach snapshot: one compact Markdown file per user, rewritten at every
// refresh (coach/<uid>.md) and served at GET /coach. It exists for an assistant
// that reads a file, not the page: a coaching agent (an LLM with a web fetch tool) has the
// file injected into every conversation, so it must carry what a coach needs
// in a few thousand characters and explain its own units and limits inline.
// Everything here is already computed by the pipeline (mergeDays, computeBrief,
// the weekly narrative); this module only selects and formats.
import { daysBetween, fmtF, fmtComma0, fmtSigned, wdName, lblShort, localStamp, TZ } from "./util.js";
import { SET_FAILURE, SET_WARMUP, SET_RIR, SET_DROP } from "./summarize.js";
import { muscleGroup } from "./muscles.js";

export const SESSION_DAYS = 14;     // sessions listed set by set
export const SESSION_MAX = 8;       // at most this many, newest first
export const NIGHTS = 7;            // recovery rows
export const TREND_MAX = 6;         // lifts named per trend state
export const WEEK_ROWS = 5;         // sets-by-week table: four full weeks plus the current one
const MAIN_GROUPS = ["chest", "back", "shoulders", "biceps", "triceps", "quads", "hamstrings/glutes", "calves"];
const SHORT_GROUP = { "hamstrings/glutes": "hams/glutes" };

const ago = (d, today) => {
  const n = daysBetween(d, today);
  return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
};
const num = (x, nd = 0) => (x == null ? "-" : nd ? fmtF(x, nd).replace(/\.0+$/, "") : String(Math.round(x)));
const dateLbl = (d) => `${wdName(d)} ${lblShort(d)}`;

/** One exercise's sets as "45x12, 50x12f" from the day's wsr tuples; bodyweight sets as "bwx10". */
export function setList(day, i) {
  const sets = (day.wsr || []).filter((t) => t[0] === i);
  if (!sets.length) return null;
  return sets.map((t) => {
    const [, lb, reps, flags, rir] = t;
    let s = `${lb > 0 ? num(lb, 1) : "bw"}x${reps}`;
    if (flags & SET_WARMUP) s += "w";
    if (flags & SET_FAILURE) s += "f";
    if (flags & SET_DROP) s += "d";
    if (flags & SET_RIR && rir != null) s += `@${rir}`;
    return s;
  }).join(", ");
}

function sessionBlock(day, today) {
  const parts = [];
  if (day.wdur) parts.push(`${num(day.wdur)} min`);
  if (day.wsets) parts.push(`${day.wsets} sets`);
  if (day.wvol) parts.push(`${fmtComma0(day.wvol)} lb volume`);
  if (day.wcardio) parts.push(`cardio ${num(day.wcardio)} min`);
  const lines = [`### ${dateLbl(day.d)} (${ago(day.d, today)}): ${parts.join(", ") || "logged, no sets"}`];
  (day.wex || []).forEach((e, i) => {
    const sets = setList(day, i);
    const bits = [sets || `${e.s} sets, best ${num(e.mw, 1)}x${e.mr}`];
    if (e.e1) bits.push(`e1RM ${num(e.e1)}`);
    const ef = (day.wef || [])[i];
    if (ef && ef !== "not computable") bits.push(ef);
    lines.push(`- ${e.n} (${muscleGroup(e.n)}): ${bits.join(" | ")}`);
  });
  if (day.wprNames && day.wprNames.length) lines.push(`- Records that day: ${day.wprNames.join("; ")}`);
  if (day.wrankNames && day.wrankNames.length) lines.push(`- Liftoff rank-ups: ${day.wrankNames.join(", ")}`);
  return lines.join("\n");
}

function nightsTable(days, brief) {
  const nights = days.filter((d) => d.score != null).slice(-NIGHTS);
  if (!nights.length) return "No ring nights recorded.";
  const rows = ["| night | asleep | score | recovery | HRV | RHR | bed | wake | deep | REM |", "|---|---|---|---|---|---|---|---|---|---|"];
  for (const n of nights) {
    rows.push(`| ${dateLbl(n.d)} | ${num(n.slh, 2)}h | ${num(n.score)} | ${num(n.rec)} | ${num(n.hrv)} | ${num(n.rhr)} | ${n.bed || "-"} | ${n.wake || "-"} | ${num(n.deep)}m | ${num(n.rem)}m |`);
  }
  const s = brief && brief.sleep;
  if (s && s.base) {
    rows.push(`| 28-night baseline | ${num(s.base.slh, 1)}h | ${num(s.base.score)} | ${num(s.base.rec)} | ${num(s.base.hrv)} | ${num(s.base.rhr, 1)} | | | | |`);
  }
  return rows.join("\n");
}

function groupsTable(t) {
  const rows = ["| muscle | sets, last 7 days | usual per week (28-day avg) | band | last trained |", "|---|---|---|---|---|"];
  for (const g of t.groups || []) {
    const last = g.lastSetDaysAgo == null ? "never" : g.lastSetDaysAgo === 0 ? "today" : `${g.lastSetDaysAgo}d ago`;
    rows.push(`| ${SHORT_GROUP[g.group] || g.group} | ${num(g.fsets7, 1)} | ${num(g.fsetsWkAvg28, 1)} | ${g.status} | ${last} |`);
  }
  rows.push(`\nBands are fractional sets per week: 0 none, under ${t.setMinReturn} low (small return), ${t.setMinReturn}-${t.setHighFrom - 1} ok (most of the growth per set), ${t.setHighFrom}-${t.setVeryHighFrom - 1} high, ${t.setVeryHighFrom}+ very high (no demonstrated ceiling).`);
  return rows.join("\n");
}

function weeksTable(t) {
  const weeks = ((t.weekly && t.weekly.weeks) || []).slice(-WEEK_ROWS);
  if (!weeks.length) return null;
  const head = MAIN_GROUPS.map((g) => SHORT_GROUP[g] || g);
  const rows = [`| week of | ${head.join(" | ")} | sessions |`, `|---|${head.map(() => "---").join("|")}|---|`];
  for (const w of weeks) {
    const lbl = `${lblShort(w.start)}${w.partial ? " (in progress)" : ""}`;
    rows.push(`| ${lbl} | ${MAIN_GROUPS.map((g) => num(w.mus[g] || 0, 1)).join(" | ")} | ${w.sessions} |`);
  }
  return rows.join("\n");
}

function trendLines(t) {
  const prog = t.progress || [];
  const by = (state) => prog.filter((p) => p.state === state);
  const lift = (p) => `${p.lift} ${fmtSigned(p.slopePerWeek, 1)} lb/wk (e1RM ${num(p.e1Prev)} to ${num(p.e1Now)}, ${p.n} sessions)`;
  const more = (arr) => (arr.length > TREND_MAX ? ` and ${arr.length - TREND_MAX} more` : "");
  const out = [];
  const up = by("stronger"), down = by("weaker"), flat = by("flat"), na = by("not enough sessions");
  out.push(`- Stronger (${up.length}): ${up.length ? up.slice(0, TREND_MAX).map(lift).join("; ") + more(up) : "none"}`);
  out.push(`- Weaker (${down.length}): ${down.length ? down.slice(0, TREND_MAX).map(lift).join("; ") + more(down) : "none"}`);
  out.push(`- Flat (${flat.length}): ${flat.length ? flat.slice(0, TREND_MAX).map((p) => `${p.lift} (e1RM ${num(p.e1Now)})`).join("; ") + more(flat) : "none"}`);
  out.push(`- Fewer than ${t.progMinSessions} sessions in ${t.progDays} days, no read: ${na.length} lifts`);
  const es = t.effortSummary;
  if (es && es.computable) {
    out.push(`- Effort, last 28 days, read from rep drop-off at a fixed load (reps in reserve are rarely logged): near failure ${es.nearFailure}, moderate ${es.moderate}, easy ${es.easy}, capped (same reps every set, unreadable) ${es.capped} of ${es.computable} readable exercise-sessions.`);
  }
  return out.join("\n");
}

/**
 * The snapshot. user: a person from the settings ({id, name, workouts}); origin: the site URL or ""; days: mergeDays output; brief: computeBrief
 * output for that user (or {error}); narrative: the current weekly note or null;
 * today: the refresh date (YYYY-MM-DD); now: epoch ms for the stamp.
 */
export function coachMarkdown({ user, days, brief, narrative, today, origin = "", now = Date.now() }) {
  const name = (user && user.name) || (user && user.id) || "User";
  const t = brief && brief.training;
  const s = brief && brief.sleep;
  const out = [];
  out.push(`# ${name}: training and recovery snapshot`);
  const log = user && user.workouts === "hevy" ? "Hevy" : "Liftoff";
  const from = `${origin ? ` from ${origin.replace(/^https:\/\//, "")}` : ""} (Ultrahuman ring${user && user.workouts ? ` + ${log} workout log` : ""})`;
  out.push(`Generated ${localStamp(now).replace("T", " ").slice(0, 16)} ${TZ}${from}, data through ${today}. This file is rewritten after every refresh; if the stamp is more than a day old, say so before using the numbers.`);
  out.push(`Units: loads in lb (Liftoff as logged; Hevy converted from kg); e1RM = Epley estimate from the best set; sets are listed as load x reps in logged order (w = warm-up, f = taken to failure, d = drop set, @n = logged reps in reserve); fractional sets count 1.0 for the prime mover and 0.5 for each assisting muscle. Muscle group in brackets is the pipeline's mapping of the exercise name.`);
  if (brief && brief.error) out.push(`\nThe daily brief failed this refresh (${brief.error}); the sessions and nights below are still current.`);

  // ---- where things stand
  out.push("\n## Where things stand");
  const lifts = days.filter((d) => (d.wvol || 0) > 0 || d.wsets);
  if (t) {
    if (t.lastLift) out.push(`- Last session: ${dateLbl(t.lastLift)} (${ago(t.lastLift, today)}): ${t.lastLiftNames || "see below"}. Sessions in the last 7 days: ${t.sessions7} (28-day average ${num(t.sessionsWkAvg28, 1)}/week, target ${t.target}).`);
    else out.push("- No lifting sessions logged.");
    if (t.streak) out.push(`- Liftoff streak: ${t.streak} days (Liftoff's counter, grace days included).`);
    if (t.prs7 && t.prs7.length) out.push(`- Records in the last 7 days: ${t.prs7.join("; ")}.`);
    if (t.plan && t.plan.sentence) out.push(`- This week's plan: ${t.plan.sentence} (${t.plan.state || "in progress"}, ${num(t.plan.done, 1)} of ${t.plan.target} sets so far).`);
    if (t.planHistory && t.planHistory.length) out.push(`- Past weeks' plans: ${t.planHistory.map((w) => `week of ${lblShort(w.weekStart)} ${SHORT_GROUP[w.group] || w.group} ${num(w.achieved, 1)}/${w.target} ${w.result}`).join("; ")}.`);
  }
  if (s) {
    out.push(`- Last recorded night (${dateLbl(s.night)}${s.fresh ? "" : ", not last night: the ring missed it"}): ${num(s.slh, 2)}h asleep, sleep score ${num(s.score)}, recovery ${num(s.rec)}, HRV ${num(s.hrv)} ms (${s.hrvState ? s.hrvState + " own band" : "no band yet"}), resting HR ${num(s.rhr)}, bed ${s.bed || "-"}, wake ${s.wake || "-"}.`);
    out.push(`- Sleep debt: ${num(s.hoursBelow14, 1)}h under ${num(s.needH)}h in total across ${s.shortNights14} of ${s.nights14} recorded nights in the last 14 days; ${s.short7} of ${s.nights7} short in the last 7. Bedtime spread over 28 nights: SD ${num(s.bedSdMin)} min.`);
  }
  if (brief && brief.bedtime) out.push(`- Tonight: bed by ${brief.bedtime.target}, screens off ${brief.bedtime.screensOff}, for ${num(s ? s.needH : 7)}h asleep before a ${brief.bedtime.wake} ${brief.bedtime.wakeDayType} wake.`);
  if (brief && brief.ring && brief.ring.chargeDue) out.push(`- Ring charge due: ${brief.ring.sinceGapDays} days since it last missed a night; it usually needs charging every ${num(brief.ring.cadenceDays)} days.`);
  // computeBrief flags untrained muscles for a ring-only user too; that is noise here
  for (const a of (brief && brief.actions) || []) if (lifts.length || a.tag !== "training") out.push(`- Flag (${a.tag}): ${a.text}`);

  // ---- sessions
  out.push(`\n## Sessions, last ${SESSION_DAYS} days`);
  const recent = lifts.filter((d) => daysBetween(d.d, today) < SESSION_DAYS).slice(-SESSION_MAX).reverse();
  if (recent.length) for (const d of recent) out.push(sessionBlock(d, today));
  else out.push(lifts.length ? `No sessions in the last ${SESSION_DAYS} days; the last one was ${dateLbl(lifts[lifts.length - 1].d)}.` : "No sessions logged.");

  // ---- volume
  if (t && lifts.length && t.groups && t.groups.length) {
    out.push("\n## Weekly sets by muscle");
    out.push(groupsTable(t));
    const wt = weeksTable(t);
    if (wt) { out.push("\nFractional sets by ISO week (Mon-Sun):"); out.push(wt); }
    out.push(`\n## Lift trends, last ${t.progDays} days (e1RM slope, 95% CI decides the state)`);
    out.push(trendLines(t));
  }

  // ---- recovery
  out.push(`\n## Recovery, last ${NIGHTS} recorded nights`);
  out.push(nightsTable(days, brief));

  // ---- narrative
  if (narrative && narrative.headline) {
    out.push(`\n## Weekly note (written by the dashboard's model, week ending ${narrative.week_ending || "?"})`);
    out.push(`${narrative.headline}. ${narrative.body || ""}`.trim());
    if (narrative.focus) out.push(`Focus: ${narrative.focus}`);
  }
  return out.join("\n") + "\n";
}
