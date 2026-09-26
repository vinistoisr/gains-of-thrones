import { test } from "node:test";
import assert from "node:assert/strict";
import fixture from "./fixture.json";
import { loadWorkouts, mergeDays } from "../src/pipeline/summarize.js";
import { computeBrief } from "../src/pipeline/brief.js";
import { renderPage } from "../src/pipeline/render.js";
import { liftZByDate, sets7ByDate, analyseHypotheses } from "../src/pipeline/stats.js";
import { daysBetween } from "../src/pipeline/util.js";

const today = "2026-06-30";
const users = [{ id: "fixture", name: "Fixture Person", workouts: "liftoff" }];
const days = mergeDays(fixture.ring, loadWorkouts(fixture.workouts), fixture.screentime);
const brief = computeBrief(days, today);
const { html, meta, pending } = renderPage({
  users, datasets: { fixture: days }, briefs: { fixture: brief }, narratives: {}, today,
  now: Date.parse("2026-06-30T19:00:00Z"),
});

test("renderPage: the page names the user and has the refresh button", () => {
  assert.ok(html.includes("Fixture Person"));
  assert.ok(html.includes("Refresh now"));
  assert.ok(html.includes("Ultrahuman Ring + Liftoff"));
  assert.equal(meta[0].id, "fixture");
  assert.deepEqual(pending, []);
  assert.ok(!html.includes("__DATA__") && !html.includes("__BRIEF__"), "placeholders filled");
});

test("renderPage: no undefined, NaN or [object leaks into the html", () => {
  for (const bad of ["undefined", "NaN", "[object"]) assert.ok(!html.includes(bad), bad);
});

test("renderPage: fonts are linked from the bucket, not inlined as base64, and Inter is gone", () => {
  assert.ok(!html.includes("data:font/woff2"), "no base64 font in the page");
  assert.ok(!html.includes("Inter var") && !html.includes("InterVariable"), "no leftover Inter font reference");
  assert.equal(html.split("@font-face").length - 1, 2, "two @font-face rules");
  assert.ok(html.includes('src:url(/Sora.woff2) format("woff2")') && html.includes('src:url(/DMSans.woff2) format("woff2")'), "Sora and DM Sans from the bucket");
});

test("renderPage: every average says how many nights it was recorded from, and nothing is called debt", () => {
  const page = html.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g, "");
  assert.ok(page.includes("recorded"));
  assert.ok(page.includes('const TODAY = "2026-06-30"'), "the build date reaches the page for the calendar windows");
  assert.ok(!page.includes("__TODAY__"), "placeholder filled");
  for (const k of ["shortNights14", "nights14", "hoursBelow14", "needH"]) assert.ok(page.includes('"' + k + '":'), k + " embedded");
  assert.ok(page.includes("nights recorded"), "KPI tiles carry the recorded-night count");
  assert.ok(page.includes("Ring coverage, 28 nights to"), "coverage strip");
  assert.ok(page.includes("last 7 days ("), "week strip labels the sample");
  assert.ok(page.includes("vs prior 4 weeks"), "week strip baseline");
  for (const bad of ["Sleep debt", "debt14", "the 7 before", "fmtH(7.5)"]) assert.ok(!page.includes(bad), bad);
});

test("renderPage: a brief that failed to build reaches the page as a banner, not a gap", () => {
  const out = renderPage({
    users: [{ id: "alex", name: "Alex", workouts: "liftoff" }],
    datasets: { alex: days }, briefs: { alex: { error: "brief: boom" } }, narratives: {}, today,
    now: Date.parse("2026-06-30T19:00:00Z"),
  });
  const page = out.html;
  // renderToday() in the page builds the sentence from these two halves and the embedded error
  assert.ok(page.includes('"alex":{"error":"brief: boom"}'), "the error text is embedded for the page");
  assert.ok(page.includes("The daily brief did not build: "), "banner copy, first half");
  assert.ok(page.includes(". The rest of the page is fine."), "banner copy, second half");
  assert.ok(!page.includes("undefined"), "no undefined");
});

test("renderPage: the This Week strip no longer carries the Sets to failure or Muscles in range tiles", () => {
  const page = html.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g, "");
  assert.ok(!page.includes("Sets to failure"), "Sets to failure tile removed");
  assert.ok(!page.includes("Muscles in range"), "Muscles in range tile removed");
  assert.ok(page.includes("Lifts getting stronger"), "Lifts getting stronger tile kept");
  assert.ok(!page.includes("Lifts progressing"), "old tile label gone");
  assert.ok(page.includes("e1RM is a strength estimate. Size is a separate measure."), "e1RM note under the strip");
  assert.ok(!page.includes('name: "top set"'), "lift chart no longer prints a top set beside the e1RM");
  assert.ok(page.includes("Liftoff PRs, 28 d"), "Liftoff PRs tile kept");
});

test("renderPage: the lift chart defaults to raw load at the modal rep count, with e1RM behind a toggle", () => {
  assert.ok(html.includes(": best load at "), "card title for the default view");
  assert.ok(html.includes("No formula. Sessions with no "), "caption for the default view");
  assert.ok(html.includes("-rep set are left blank."), "caption, second half");
  assert.ok(html.includes('"Load at " + reps + " reps"') && html.includes('"e1RM"'), "the two toggle buttons");
  assert.ok(html.includes('"estimated from " + '), "e1RM tooltip says which set the estimate came from");
  assert.ok(html.includes("function modalReps(") && html.includes("function bestLoadAtReps("), "helpers reach the page");
  assert.ok(!html.includes("__LIFTFN__"), "placeholder filled");
  assert.ok(!html.includes("Best-set estimated 1RM (Epley) per session\" +"), "old default caption is not the first view");
});

test("renderPage: the training strip has its own card and the weekly note says when it was written", () => {
  // the note is written on Sundays and stands all week; the strip is live trailing-7-day data,
  // so they get separate cards with their own dates
  const note = {
    week_ending: "2026-06-27", generated: "2026-06-28T13:00:00.000Z", model: "@cf/test-model",
    headline: "Sleep held at 7.5 h while chest hit 12 sets",
    body: "First paragraph.\n\nSecond paragraph.",
    focus: "Add one leg session with 8 sets of quads before Thursday.",
  };
  const out = renderPage({
    users, datasets: { fixture: days }, briefs: { fixture: brief }, narratives: { fixture: note }, today,
    now: Date.parse("2026-06-30T19:00:00Z"),
  });
  const page = out.html.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g, "");
  assert.ok(page.includes("Training, last 7 days"), "training card header");
  assert.ok(page.includes("written "), "the note header says when it was written");
  assert.ok(page.includes("from that week's numbers"), "and from which numbers");
  assert.ok(page.includes("Last week"), "note header");
  assert.ok(page.includes("waiting for this Sunday's note"), "stale-note line is in the page code");
  assert.ok(!page.includes('"ending " + n.week_ending'), "old header copy is gone");
  const strip = page.indexOf('id="training7"'), noteCard = page.indexOf('id="narrative"');
  assert.ok(strip > 0 && noteCard > strip, "the training card sits above the note");
  assert.ok(page.includes('"week_ending":"2026-06-27"'), "narrative embedded");
  assert.ok(page.includes('"generated":"2026-06-28T13:00:00.000Z"'), "generated timestamp embedded for the header");
  // the strip's date range is computed from the brief's own date, which is today
  assert.equal(brief.generated, today);
  assert.ok(page.includes('"generated":"' + today + '"'), "brief date embedded");
});

test("renderPage: the body map is coloured on fractional sets and the focus list shows the count and the last session", () => {
  const page = html.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g, "");
  assert.ok(page.includes('setsBy[g.group] = g.fsets7 != null ? g.fsets7 : g.sets7'), "map colours on fsets7");
  assert.ok(page.includes('" this week, last trained " + ago'), "count and days since the last set per muscle");
  assert.ok(page.includes('x.last == null ? "never"'), "never-trained wording");
  assert.ok(page.includes('"lastSetDaysAgo":'), "days since the last set embedded in the brief");
  assert.ok(page.includes('"unclassified: " + unclassified'), "unclassified line");
  assert.ok(page.includes("if (unclassified > 0){"), "printed only when there are unclassified sets");
  assert.ok(page.includes('"fsets7":'), "fractional counts embedded in the brief");
  assert.ok(page.includes('"wmus":'), "per-day fractional sets embedded in DAYS");
});

test("renderPage: footer and captions describe the cloud refresh, not the old PC flow", () => {
  const page = html.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g, "");
  assert.ok(!page.includes("refresh.ps1"), "no refresh.ps1");
  assert.ok(!page.includes("dashboard PC"), "no dashboard PC");
  assert.ok(page.includes("Refreshes in the cloud every 6 hours; Refresh now forces one."), "footer copy");
  // the research captions under the charts and the bedtime line (item 7)
  assert.ok(page.includes("Cardio alongside lifting leaves muscle growth unchanged (Schumann 2022, 43 studies)."), "VO2 note");
  assert.ok(page.includes('"Most of the growth per set comes between " + SET_MIN_RETURN + " and " + (SET_HIGH_FROM - 1) + " fractional sets a week. About a third of your usual volume holds size; none at all loses it. A set counts once for its main muscle'), "muscle legend");
  assert.ok(!page.includes("Below that it only maintains."), "old unsourced legend gone");
  assert.ok(page.includes("Phone use in bed is outside this record."), "screen time note");
  assert.ok(page.includes("Last coffee by early afternoon."), "bedtime line");
  assert.ok(page.includes("8-10k is where the observed benefit levels off for adults under 60 (Paluch 2022, observational)."), "steps note");
  assert.ok(!page.includes(String.fromCharCode(0x2014)), "no em dash anywhere in the page");
});

test("renderPage: the body map bands on the 4 / 11 / 19 tiers and the old 10-20 copy is gone", () => {
  const page = html.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g, "");
  assert.ok(page.includes("most of the return"), "legend wording");
  assert.ok(page.includes('["--m-low","1-3 sets, small return"],["--m-ok","4-10, most of the return"],["--m-high","11-18"],["--m-vhigh","19+"]'), "legend tiers");
  for (const bad of ["Over 20", "Under 10 sets", "10-20", "10 to 20", "growth range"]) assert.ok(!page.includes(bad), bad);
  // the page's tier lines are the same numbers brief.js exports
  const m = /const SET_MIN_RETURN = (\d+), SET_HIGH_FROM = (\d+), SET_VERY_HIGH_FROM = (\d+);/.exec(page);
  assert.ok(m, "tier constants in the page");
  assert.deepEqual(m.slice(1).map(Number), [brief.training.setMinReturn, brief.training.setHighFrom, brief.training.setVeryHighFrom]);
  assert.ok(page.includes('sets < SET_MIN_RETURN ? "--m-low" : sets < SET_HIGH_FROM ? "--m-ok" : sets < SET_VERY_HIGH_FROM ? "--m-high" : "--m-vhigh"'), "mColor bands");
  // the Graphite restyle has one dark palette, defined once on :root
  assert.equal(page.split("--m-vhigh:#").length - 1, 1, "one --m-vhigh definition");
  assert.ok(page.includes('"Muscles at " + minLine + "+ sets"'), "training strip cell");
  assert.ok(page.includes('atLine + " of " + MAIN8.length'), "n of 8 main groups");
  // claim markers the checker found missing
  assert.ok(page.includes("// claim: e1rm-strength-signal"), "e1RM marker");
  assert.ok(!page.includes(String.fromCharCode(0x2014)), "no em dash");
});

test("renderPage: the lift chart reads effort from rep drop-off and DAYS carry wef", () => {
  const page = html.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g, "");
  assert.ok(page.includes('"wef":'), "per-day effort states embedded in DAYS");
  assert.ok(page.includes('"effortSummary":'), "effort summary embedded in the brief");
  assert.ok(page.includes('"Effort read from rep drop-off at a fixed load: " + nf + " of " + read + " sessions near failure, " + capped + " capped at a rep target."'), "chart line");
  assert.ok(page.includes('value: "effort: " + p.ef'), "effort state in the session tooltip");
  assert.ok(page.includes('" -> " + run.reps[run.reps.length - 1] + " reps at " + run.load + " " + UNIT()'), "tooltip detail");
  assert.ok(!page.includes(String.fromCharCode(0x2014)), "no em dash anywhere in the page");
});

test("renderPage: every load label comes from the person's unit, none is hardcoded", () => {
  const page = html.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g, "");
  const script = page.slice(page.indexOf("<script"));
  // no load, e1RM or volume label is a fixed "lb" or "kg" in the page code
  assert.deepEqual(script.match(/"[^"\n]*\s(lb|kg)\b[^"\n]*"/g)?.filter((x) => !/settings: kg or lb|className|t\.label|at 60 kg/.test(x)) || [], [], "a fixed unit in a string");
  assert.deepEqual(page.match(/toFixed\(1\) \+ "t"/g), null, "volume formatted as tonnes");
  assert.ok(page.includes('function UNIT(){'), "UNIT() reads the viewed person's unit");
  assert.ok(page.includes('yAxis(svg, niceTicks(lo, hi, 4), y, v => v + " " + UNIT());'), "lift chart axis");
  assert.ok(page.includes('ul.textContent = UNIT();'), "volume axis label");
  assert.ok(page.includes('"--c-bw", UNIT(), null'), "bodyweight chart");
  assert.ok(page.includes('["wvol", "Vol " + UNIT()]') && page.includes('["wbody", "BW " + UNIT()]'), "table headers");
  assert.equal(meta[0].u, "lb", "an lb person by default");
  const kg = renderPage({ users: [{ id: "k", name: "K", workouts: "hevy", units: "kg" }], datasets: { k: days }, briefs: { k: brief }, narratives: {}, today });
  assert.equal(kg.meta[0].u, "kg");
  assert.ok(kg.html.includes('"u":"kg"'), "the unit reaches the page data");
  assert.ok(!page.includes(String.fromCharCode(0x2014)), "no em dash");
});

test("renderPage: the Sets per muscle, by week chart is in the page with its caption and reads", () => {
  const page = html.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g, "");
  assert.ok(page.includes("Sets per muscle, by week"), "chart title");
  assert.ok(page.includes("Fractional sets (assists count half). Always the last 12 weeks."), "caption says it ignores the window");
  assert.ok(page.includes('id="c-setswk"'), "card slot next to Training volume");
  assert.ok(page.includes("chartSetsWeek();"), "called from renderAll");
  assert.ok(page.includes('"weekly":{"weeks":['), "weekly block embedded in the brief");
  assert.ok(page.includes('": last full week " + fmtSets(s.lastFull) + " sets, " + (s.read === "steady" ? "level with" : s.read)'), "ordinal read copy");
  assert.ok(!page.includes("sweet spot"), "no ratio with a coloured sweet spot");
});

test("renderPage: the plan sentence is pinned above the hero; Past calls appears with a two-week store", () => {
  const page = html.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g, "");
  assert.ok(page.includes("Checked Sunday"), "the sentence is embedded in the brief");
  const bar = page.indexOf('id="planbar"'), hero = page.indexOf('id="hero"');
  assert.ok(bar > 0 && hero > bar, "the plan bar sits above the hero card");
  assert.ok(page.includes('"planHistory":[]'), "no store: empty history");
  const store = { weeks: [
    { weekStart: "2026-06-15", group: "calves", exercise: null, sets: 3, target: 4, days: [1, 5], createdAt: "2026-06-15", achieved: 0, result: "miss" },
    { weekStart: "2026-06-22", group: "quads", exercise: "Leg Press", sets: 3, target: 4, days: [1, 5], createdAt: "2026-06-22", achieved: 4, result: "hit" },
  ] };
  const out = renderPage({
    users, datasets: { fixture: days }, briefs: { fixture: computeBrief(days, today, store) }, narratives: {}, today,
    now: Date.parse("2026-06-30T19:00:00Z"),
  });
  const p2 = out.html.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g, "");
  assert.ok(p2.includes("Past calls"), "Past calls panel code");
  assert.ok(p2.includes('"week of "'), "row label");
  assert.ok(p2.includes("Every muscle at 4+ sets: "), "streak line");
  assert.ok(p2.includes('"weekStart":"2026-06-22","group":"quads","achieved":4,"target":4,"result":"hit"'), "history embedded");
  assert.ok(p2.includes('"streak4":'), "streak embedded");
  assert.ok(!p2.includes(String.fromCharCode(0x2014)), "no em dash");
});

test("renderPage: the correlation section is a fixed list with its statistics, not a ranked leaderboard", () => {
  const page = html.replace(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g, "");
  assert.ok(page.includes('<h2 class="sec" id="sec-drv">Correlations</h2>'), "section renamed");
  assert.ok(page.includes('<h2 class="sec" id="sec-strain">Sleep and HRV vs the next workout</h2>'), "sleep-vs-training section renamed");
  assert.ok(page.includes('<a href="#sec-drv">Correlations</a><a href="#sec-strain">Next workout</a>'), "nav labels");
  for (const s of ["What moves your scores", "How sleep affects your training", "Sleep the night before vs the session", "Relationship strength",
    "Weak links are hidden", "weak or unproven links", "renderDrivers(", "renderSleepTraining(", "DRIVERS_ALL", "vs your best", "dindex"]) {
    assert.ok(!page.includes(s), s + " is gone");
  }
  for (const s of ["did not clear the false-discovery gate at this data density (q = 0.10)", "\", about \" + Math.round(c.nEff) + \" effective\"",
    "\" pairs (\" + c.dropped + \" days lacked one side)\"", "Lifting and the weekdays you lift on are confounded here.",
    "A correlation needs about r = ", "to be named at this sample size", "Weekday averages removed first",
    " vs ", "went with", "No statistics: the two share a clock.", "Shown as is, no statistics.", "7-day block bootstrap",
    "Fisher z at the effective count (under 12 pairs)"]) {
    assert.ok(page.includes(s), s);
  }
  for (const fn of ["analyseHypotheses", "blockBootstrapCI", "bhGate", "residualiseByWeekday", "pairLag1", "lag1", "nEff", "fisherCI"]) {
    assert.ok(page.includes("function " + fn + "("), fn + " reaches the page");
  }
  assert.ok(!page.includes("__STATSFN__"), "placeholder filled");
  assert.ok(page.includes("renderCorrelations(win);"), "one call from renderAll");
  // no causal verbs anywhere in the section's code or copy, and no em dash
  const a = page.indexOf("/* =============== what goes with what"), b = page.indexOf("/* =============== tiles");
  assert.ok(a > 0 && b > a, "section markers");
  const sec = page.slice(a, b);
  const m = sec.match(/\b(raises?|raising|improves?|improving|drives?|driving|boosts?|boosting|causes?|causing|predicts?|predicting)\b/i);
  assert.equal(m, null, `section uses "${m && m[0]}"`);
  assert.ok(!sec.includes(String.fromCharCode(0x2014)), "no em dash");
  assert.ok(!sec.includes("NaN"), "no NaN literal in the injected statistics");
});

test("renderPage: the hypothesis list evaluates in node, refuses display-only keys, and the fixture leaves cards under the gate", () => {
  const defs = html.slice(html.indexOf("/* corr-defs:start"), html.indexOf("/* corr-defs:end */"));
  assert.ok(defs.length > 100, "defs block present");
  const { ANALYTICS, DISPLAY_ONLY, CORR_HYPOTHESES } = new Function(defs + "\nreturn { ANALYTICS, DISPLAY_ONLY, CORR_HYPOTHESES };")();
  assert.equal(CORR_HYPOTHESES.length, 10);
  assert.deepEqual(CORR_HYPOTHESES.filter((h) => h.block === "mechanical").map((h) => h.id), ["bed-sleep", "pc-bed"]);
  assert.deepEqual(CORR_HYPOTHESES.filter((h) => h.block === "uncertain").map((h) => h.id),
    ["sleep-lift", "hrv-lift", "bed-hrv", "sets7-hrv", "steps-sleep", "steps-hrv", "pc-sleep", "lift-rhr"]);
  for (const k of ["score", "rec", "deep", "rem", "spo2", "rest", "mov", "wperf"]) assert.ok(DISPLAY_ONLY.includes(k), k + " is display-only");
  for (const k of ["hrvLn", "rhr", "slh", "eff", "steps", "pc", "pcEve", "wsets", "wvol", "wmus", "liftZ"]) assert.ok(ANALYTICS.includes(k), k + " is analytics");
  for (const h of CORR_HYPOTHESES) {
    assert.ok(ANALYTICS.includes(h.xKey) && ANALYTICS.includes(h.yKey), h.id + " reads analytics keys only");
    assert.ok(h.lag === 0 || h.lag === 1, h.id);
    assert.equal(typeof h.x, "function"); assert.equal(typeof h.y, "function");
    assert.ok(h.title && h.why && !/\b(raises?|improves?|drives?|boosts?|causes?|predicts?)\b/i.test(h.title + " " + h.why), h.id + " copy");
  }
  assert.ok(CORR_HYPOTHESES.every((h) => h.yKey !== "wperf" && h.xKey !== "wperf"), "wperf is no longer an outcome");
  assert.equal(CORR_HYPOTHESES.filter((h) => h.yKey === "liftZ").length, 2, "the session outcome is the lift residual z");
  const ctx = { liftZ: liftZByDate(brief.training.progress), sets7: sets7ByDate(days) };
  assert.ok(Object.keys(ctx.liftZ).length >= 3, "the fixture brief carries per-session residuals");
  const tiers = { analytics: ANALYTICS, displayOnly: DISPLAY_ONLY };
  const opts = { q: 0.10, minPairs: 8, bootstrapFrom: 12, block: 7, reps: 500, seed: 20260907 };
  const win = days.slice(-30);
  const res = analyseHypotheses(win, CORR_HYPOTHESES, ctx, tiers, opts);
  assert.equal(res.cards.length, 10);
  const tested = res.cards.filter((c) => c.block === "uncertain" && c.r != null);
  assert.ok(tested.length >= 4, `fixture tests ${tested.length} cards`);
  assert.ok(tested.some((c) => !c.pass), "at least one card sits under the gate");
  for (const c of tested) {
    assert.ok(c.nEff >= 4 && c.nEff <= c.n, `${c.id}: nEff ${c.nEff} of ${c.n}`);
    assert.ok(c.ci[0] <= c.ci[1] && c.p >= 0 && c.p <= 1, c.id);
  }
  for (const c of res.cards.filter((c) => c.block === "mechanical")) assert.equal(c.r, null, c.id + " has no statistics");
  assert.ok(res.gate.rGate > 0.2 && res.gate.rGate < 0.7, `gate ${res.gate.rGate}`);
  for (const c of res.cards) for (const p of c.pairs) assert.equal(daysBetween(p.dx, p.dy), c.lag, c.id + " pairs are exactly lag days apart");
  // the same window twice prints the same numbers
  const again = analyseHypotheses(win, CORR_HYPOTHESES, ctx, tiers, opts);
  assert.deepEqual(again.cards.map((c) => [c.r, c.ci, c.p]), res.cards.map((c) => [c.r, c.ci, c.p]));
  // the whole fixture clears one card (an 8-session Fisher interval), so the gate is not a blanket refusal
  const all = analyseHypotheses(days, CORR_HYPOTHESES, ctx, tiers, opts);
  assert.ok(all.cards.some((c) => c.pass), "one card passes on the full fixture");
  // a display-only key is refused before anything is computed
  const bad = [{ id: "bad", block: "uncertain", lag: 0, xKey: "score", yKey: "slh", x: (d) => d.score, y: (d) => d.slh }];
  assert.throws(() => analyseHypotheses(days, bad, ctx, tiers, opts), /display-only key: score/);
});
