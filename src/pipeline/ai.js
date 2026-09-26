// Weekly narrative written by Workers AI from numbers the pipeline computed.
// The model explains; it never computes. Every figure it may use is in `facts`.
import { mean, pstdev, fmtF, daysBetween, weekday, hasNight } from "./util.js";
import { NEED_H, SET_MIN_RETURN, SET_HIGH_FROM, SET_VERY_HIGH_FROM, setStatus } from "./brief.js";
import { fractionalSets } from "./muscles.js";
import { CLAIMS } from "./claims.js";

export const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const avg = (v, nd = 1) => { const w = v.filter((x) => x != null); return w.length ? +fmtF(mean(w), nd) : null; };

/** Compact, model-facing summary of the last week against the prior four. */
export function weeklyFacts(days, brief, today) {
  const nights = days.filter(hasNight);
  const wk = nights.filter((n) => daysBetween(n.d, today) < 7);
  const prior = nights.filter((n) => { const a = daysBetween(n.d, today); return a >= 7 && a < 35; });
  const block = (v) => ({
    nights: v.length,
    sleep_h: avg(v.map((n) => n.slh), 2), score: avg(v.map((n) => n.score)), recovery: avg(v.map((n) => n.rec)),
    hrv_ms: avg(v.map((n) => n.hrv)), rhr_bpm: avg(v.map((n) => n.rhr)),
    [`nights_under_${NEED_H}h`]: v.filter((n) => n.slh != null && n.slh < NEED_H).length,
    bedtime_sd_min: v.length > 1 ? Math.round(pstdev(v.map((n) => n.bedRel)) * 60) : null,
    steps: avg(v.map((n) => n.steps), 0),
  });
  const lifts = days.filter((d) => (d.wvol || 0) > 0);
  const l7 = lifts.filter((d) => daysBetween(d.d, today) < 7);
  const l28 = lifts.filter((d) => daysBetween(d.d, today) < 28);
  // fractional sets from wmus: primary 1.0, each assisting muscle SECONDARY_W (muscles.js)
  const sets = (list) => {
    const out = {};
    for (const d of list) for (const [g, v] of Object.entries(d.wmus || fractionalSets(d.wex).mus)) out[g] = (out[g] || 0) + v;
    return out;
  };
  const sets7 = sets(l7), sets28 = sets(l28);
  const perWeek28 = Object.fromEntries(Object.entries(sets28).map(([g, s]) => [g, +fmtF(s / 4, 1)]));
  // pre-classified so the model states, not judges: the same fsets7 tiers as brief.js setStatus
  // (under SET_MIN_RETURN is the small-return band, SET_MIN_RETURN to SET_HIGH_FROM - 1 most of the return)
  const MAIN = ["chest", "back", "shoulders", "biceps", "triceps", "quads", "hamstrings/glutes", "calves"];
  const TIER = { none: "NOT TRAINED this week", low: `UNDER the ${SET_MIN_RETURN}-set line, small return`,
    ok: `${SET_MIN_RETURN}-${SET_HIGH_FROM - 1}, most of the return per set`, high: `${SET_HIGH_FROM}-${SET_VERY_HIGH_FROM - 1}, high`,
    "very high": `${SET_VERY_HIGH_FROM}+, very high` };
  const muscleStatus = Object.fromEntries(MAIN.map((g) => {
    const s = +fmtF(sets7[g] || 0, 1);
    return [g, `${s} fractional sets: ${TIER[setStatus(s)]}`];
  }));
  const eve = days.filter((d) => d.pcEve != null && daysBetween(d.d, today) < 7).map((d) => d.pcEve);
  return {
    week_ending: today,
    this_week: block(wk),
    prior_4_weeks_avg: block(prior),
    training: {
      sessions_this_week: l7.length, sessions_per_week_last_4: +fmtF(l28.length / 4, 1),
      muscle_status_this_week: muscleStatus,
      fractional_sets_per_week_last_4_by_muscle: perWeek28,
      fractional_sets_note: "a set counts fully for the main muscle and half for each assisting muscle",
      prs_last_28_days: l28.reduce((a, d) => a + (d.wpr || 0), 0),
      liftoff_streak_days: brief?.training?.streak ?? null,
      records_this_week: brief?.training?.prs7 || [],
      exercise_rank_ups_this_week: brief?.training?.rankUps7 || [],
      sets_to_failure_this_week: brief?.training?.failSets7 ?? null,
      share_of_sets_to_failure_this_week_pct: brief?.training?.failShare7 ?? null,
      lifts_stronger_90_day_trend: brief?.training?.progUp ?? null,
      lifts_weaker_90_day_trend: brief?.training?.progDown ?? null,
      lifts_flat_90_day_trend: brief?.training?.progFlat ?? null,
      lifts_with_under_6_sessions: brief?.training?.progNA ?? null,
      top_progressions: (brief?.training?.progress || []).filter((p) => p.state !== "not enough sessions").slice(0, 4)
        .map((p) => `${p.lift}: ${p.state}, e1RM ${p.e1Prev} -> ${p.e1Now} ${brief?.unit || "lb"} over ${p.n} sessions (${p.pct > 0 ? "+" : ""}${p.pct}%)`),
      load_unit: brief?.unit || "lb",
      most_return_per_set_fractional_sets_per_muscle_per_week: `${SET_MIN_RETURN}-${SET_HIGH_FROM - 1}`,
    },
    evening_pc_minutes_this_week_avg: eve.length ? Math.round(mean(eve)) : null,
    short_nights_last_14_days: brief?.sleep?.shortNights14 ?? null,
    nights_recorded_last_14_days: brief?.sleep?.nights14 ?? null,
    [`hours_under_${NEED_H}h_last_14_days`]: brief?.sleep?.hoursBelow14 ?? null,
    ring_nights_missing_total: brief?.ring?.missingNights ?? null,
  };
}

const SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "5 to 12 words naming the single most important change this week with its number, e.g. 'Sleep fell to 6.9 h while chest volume hit 16 sets'. Never generic." },
    body: { type: "string", description: "Two short paragraphs separated by a blank line, 90-140 words total. Paragraph 1: the one or two changes that matter most vs the prior 4 weeks and what they mean for muscle growth. Paragraph 2: training balance (which muscles are at 4 or more fractional sets, which are under that line or at zero) and whether lifts are progressing. Use at most 6 numbers in total; do not list every muscle group." },
    focus: { type: "string", description: "One concrete action for the coming week, 8 to 25 words, starting with a verb, using only numbers from the facts (a current set count, the 4-10 band, or a bedtime), e.g. 'Add one leg session and bring quads from 4 sets up to 10.'" },
  },
  required: ["headline", "body", "focus"],
};

const SYSTEM = `You write a short weekly health note for one person who lifts for hypertrophy (muscle growth) and wears a sleep-tracking ring. Write to them as "you".
Rules:
- Use only the numbers in the facts. Never invent, estimate or extrapolate a figure. If a value is null, do not mention it.
- Compare this week to the prior 4 weeks. Lead with the biggest change and say by how much. Do not recite the whole fact sheet; pick what matters.
- Whenever you cite the baseline, name it explicitly as "the prior 4 weeks" (never "average" alone), because the page also shows a separate week-over-week strip and readers must not confuse the two.
- Only make physiological claims from this list: ${CLAIMS.map((c) => c.text).join(" ")}
- Never use causal verbs (raises, improves, drives, boosts, causes, cuts, predicts). Describe what changed and what it went with, as in "sleep fell to 6.4 h on the nights after late sessions".
- No medical diagnoses, no supplements, no exclamation marks, no praise words like "great" or "amazing". Plain, direct, specific sentences.
- Do not use em dashes. Use hyphens or separate sentences.
- The focus must be a specific action for next week: a muscle group and a set count, or a bedtime.
- If previous headlines are provided, note streaks or reversals ("third week in a row", "reversed last week's drop"). If none are provided, simply do not mention history.`;

/**
 * env.AI (Workers AI binding), facts from weeklyFacts(), previous: [{week_ending, headline}].
 * Returns {week_ending, model, headline, body, focus, generated} or throws.
 */
const REQUIREMENTS = `Write the note now as JSON with exactly these keys:
- "headline": 5 to 12 words naming the single biggest change this week, and it must contain at least one number taken from the facts. Never a generic phrase like "first week" or "weekly update".
- "body": two paragraphs separated by a blank line, 90 to 140 words in total. Paragraph 1: the one or two changes that matter most against the prior 4 weeks, with their numbers, and what they mean for muscle growth. Paragraph 2: training balance - which muscle groups are at 4 or more weekly fractional sets, which are under that line or at zero, and whether estimated 1RMs are progressing. Use at most 6 numbers in the whole body; do not list every muscle group.
- "focus": ONE imperative sentence of 8 to 25 words giving a specific action for next week (a muscle group and set count, or a bedtime). Every number in it must come from the facts: a current set count, the 4-10 band, or a clock time. E.g. "Add one leg session this week and bring quads from 4 sets up to 10 before Thursday."
Shape example (illustrative numbers, do not copy them): {"headline":"Sleep slid to 6.4 h while chest volume doubled to 18 sets","body":"You averaged 6.4 h ...\\n\\nChest and shoulders ...","focus":"Be in bed by 22:45 on the four weeknights and bring quads up to 10 sets."}`;

// Every numeral the model prints must be a number from the facts sheet. Dates,
// clock times, ordinals ("3rd week") and metric names (e1RM, VO2) are not figures.
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
export function numerals(text) {
  const t = String(text || "")
    .replace(/\d{4}-\d{2}-\d{2}/g, " ")
    .replace(new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, "gi"), " ")
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b`, "gi"), " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d{1,2}\s?(?:am|pm)\b/gi, " ")
    .replace(/\b\d+(?:st|nd|rd|th)\b/gi, " ")
    .replace(/\b(?:e?1RM|VO2|SpO2)\b/gi, " ")
    .replace(/(\d),(?=\d{3}\b)/g, "$1");
  return (t.match(/\d+(?:\.\d+)?/g) || []).map((s) => Math.abs(Number(s)));
}

const TOLERANCE = 0.05;
/** Numbers in `text` that no number in the facts sheet matches within 0.05 (sign ignored). */
export function unverifiableNumbers(text, facts) {
  const known = numerals(JSON.stringify(facts));
  const bad = [];
  for (const n of numerals(text)) {
    if (!known.some((k) => Math.abs(k - n) <= TOLERANCE + 1e-9) && !bad.includes(n)) bad.push(n);
  }
  return bad;
}

/** Leaf values in the facts sheet, nulls excluded (the model is told not to mention them). */
export function countFacts(v) {
  if (v == null) return 0;
  if (Array.isArray(v)) return v.reduce((a, x) => a + countFacts(x), 0);
  if (typeof v === "object") return Object.values(v).reduce((a, x) => a + countFacts(x), 0);
  return 1;
}

const FIELDS = ["headline", "body", "focus"];

export function validate(obj, facts) {
  const problems = [];
  const words = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;
  const h = String(obj.headline || ""), b = String(obj.body || ""), f = String(obj.focus || "");
  if (words(h) < 4 || words(h) > 14) problems.push(`headline has ${words(h)} words (need 5-12)`);
  if (!/\d/.test(h)) problems.push("headline contains no number");
  if (/first week|weekly (update|note|summary)/i.test(h)) problems.push("headline is generic");
  if (words(b) < 70 || words(b) > 180) problems.push(`body has ${words(b)} words (need 90-140)`);
  if (words(f) < 8) problems.push(`focus has ${words(f)} words (need an 8-25 word imperative sentence)`);
  if (facts) {
    for (const k of FIELDS) {
      const bad = unverifiableNumbers(obj[k], facts);
      if (bad.length) problems.push(`${k} uses numbers that are not in the facts: ${bad.join(", ")}`);
    }
  }
  return problems;
}

/**
 * env.AI (Workers AI binding), facts from weeklyFacts(), previous: [{week_ending, headline}].
 * Returns {week_ending, model, headline, body, focus, generated, quality, verified, dropped?} or throws.
 * verified = number of facts fields the note was checked against; dropped names any
 * field removed because it still held a number that is not in the facts after the retry.
 */
export async function writeNarrative(env, facts, previous = []) {
  const model = env.AI_MODEL || DEFAULT_MODEL;
  const history = previous.length
    ? `Previous headlines (newest first): ${JSON.stringify(previous.slice(0, 4))}`
    : "There is no previous note; do not mention history or that this is a first week.";
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${history}\n\nFacts for the week ending ${facts.week_ending}:\n${JSON.stringify(facts)}\n\n${REQUIREMENTS}` },
  ];
  const ask = async () => {
    const res = await env.AI.run(model, { messages, max_tokens: 800, temperature: 0.4, response_format: { type: "json_schema", json_schema: SCHEMA } });
    let obj = res && res.response !== undefined ? res.response : res;
    if (typeof obj === "string") {
      try { obj = JSON.parse(obj); } catch { obj = { headline: "", body: obj.slice(0, 900), focus: "" }; }
    }
    if (!obj || typeof obj !== "object" || !obj.body) throw new Error("model returned no usable narrative");
    return obj;
  };
  let obj = await ask();
  let problems = validate(obj, facts);
  if (problems.length) {
    messages.push({ role: "assistant", content: JSON.stringify(obj) });
    messages.push({ role: "user", content: `That answer fails these requirements: ${problems.join("; ")}. Rewrite the whole note so every requirement holds. Same JSON keys.` });
    const second = await ask();
    if (validate(second, facts).length <= problems.length) { obj = second; problems = validate(second, facts); }
  }
  // after the retry, any field that still prints a number the facts do not hold is dropped
  const dropped = [];
  for (const k of FIELDS) {
    const bad = unverifiableNumbers(obj[k], facts);
    if (bad.length) { dropped.push(`${k}: unverifiable number ${bad.join(", ")}`); obj = { ...obj, [k]: "" }; }
  }
  return {
    week_ending: facts.week_ending, model, generated: new Date().toISOString(),
    headline: String(obj.headline || "").slice(0, 160), body: String(obj.body || "").slice(0, 1200), focus: String(obj.focus || "").slice(0, 300),
    quality: problems.length ? `low: ${problems.join("; ")}` : "ok",
    verified: countFacts(facts),
    ...(dropped.length ? { dropped: dropped.join("; ") } : {}),
  };
}

/** A narrative is due on Sundays (local) once per week, or whenever none exists yet. */
export function narrativeDue(existing, today) {
  if (!existing || !existing.week_ending) return true;
  const age = daysBetween(existing.week_ending, today);
  return weekday(today) === 6 ? age >= 6 : age >= 8;
}
