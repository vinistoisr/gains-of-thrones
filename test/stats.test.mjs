import { test } from "node:test";
import assert from "node:assert/strict";
import { lag1, nEff, residualiseByWeekday, blockBootstrapCI, fisherCI, bhGate, pairLag1, pearsonR, rGate, normalCdf,
  liftZByDate, sets7ByDate, analyseHypotheses, statAddDays, STATS_FN_JS } from "../src/pipeline/stats.js";

// seeded series so every known answer is the same on every run
function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const whiteNoise = (n, seed) => { const r = prng(seed); return Array.from({ length: n }, () => gauss(r)); };
const ar1 = (n, phi, seed) => { const r = prng(seed); const out = [gauss(r)]; for (let i = 1; i < n; i++) out.push(phi * out[i - 1] + Math.sqrt(1 - phi * phi) * gauss(r)); return out; };
const dates = (n, from = "2026-01-05") => Array.from({ length: n }, (_, i) => statAddDays(from, i));   // 2026-01-05 is a Monday
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ""} ${a} vs ${b} (tol ${tol})`);

test("pearsonR: exact lines give 1 and -1, a constant series gives null", () => {
  assert.equal(pearsonR([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  assert.equal(pearsonR([1, 2, 3, 4], [8, 6, 4, 2]), -1);
  assert.equal(pearsonR([1, 1, 1], [1, 2, 3]), null);
  assert.equal(pearsonR([1], [2]), null);
});

test("lag1: white noise sits near 0, an AR(1) at 0.5 reads back near 0.5", () => {
  near(lag1(whiteNoise(2000, 1)), 0, 0.06, "white noise");
  near(lag1(ar1(2000, 0.5, 2)), 0.5, 0.06, "AR(1) 0.5");
  assert.equal(lag1([1, 2]), 0, "under 3 values");
  assert.equal(lag1([3, 3, 3, 3]), 0, "no spread");
});

test("lag1 with dates: only neighbours one day apart count, and the estimate is scaled back to n - 1 terms", () => {
  const alt = [1, -1, 1, -1, 1, -1];
  near(lag1(alt), -5 / 6, 1e-9, "alternating, all adjacent");
  near(lag1(alt, dates(6)), -5 / 6, 1e-9, "consecutive dates change nothing");
  // three of the five neighbour pairs are a day apart; each product is -1, scaled by 5/3
  const gapped = ["2026-01-05", "2026-01-06", "2026-01-08", "2026-01-09", "2026-01-11", "2026-01-12"];
  near(lag1(alt, gapped), -5 / 6, 1e-9, "gaps skipped and rescaled");
  assert.equal(lag1(alt, ["2026-01-01", "2026-01-03", "2026-01-05", "2026-01-07", "2026-01-09", "2026-01-11"]), 0, "no adjacent pair at all");
  assert.ok(lag1([1, -1, 1, -1, 1, -1, 1, -1, 1, -1], dates(10)) >= -1, "clamped");
});

test("nEff: white noise keeps n, two AR(1) series at 0.5 keep about 0.6 n, floor 4 and cap n", () => {
  assert.equal(nEff(30, 0, 0), 30);
  assert.equal(nEff(30, 0.5, 0.5), 18);
  assert.equal(nEff(5, 0.9, 0.9), 4, "floor");
  assert.equal(nEff(10, -0.5, 0.5), 10, "a negative product cannot exceed n");
  const n = 1000;
  const px = lag1(whiteNoise(n, 3)), py = lag1(whiteNoise(n, 4));
  near(nEff(n, px, py), n, 0.08 * n, "white noise");
  const ax = lag1(ar1(n, 0.5, 5)), ay = lag1(ar1(n, 0.5, 6));
  const ne = nEff(n, ax, ay);
  assert.ok(ne > 0.5 * n && ne < 0.7 * n, `AR(1) 0.5 pair: ${ne}`);
});

test("residualiseByWeekday: weekday means come off when a weekday has 3+ values, the grand mean otherwise, nulls kept", () => {
  // 21 days from a Monday: three of every weekday, value = weekday index * 10 + a per-week offset
  const rows21 = dates(21).map((d, i) => ({ d, v: (i % 7) * 10 + (i < 7 ? -1 : i < 14 ? 0 : 1) }));
  const res21 = residualiseByWeekday(rows21);
  res21.forEach((r, i) => near(r, i < 7 ? -1 : i < 14 ? 0 : 1, 1e-9, `day ${i}`));
  // 9 days: no weekday reaches 3 values, so every residual is value minus the grand mean
  const rows9 = dates(9).map((d, i) => ({ d, v: i }));
  const res9 = residualiseByWeekday(rows9);
  res9.forEach((r, i) => near(r, i - 4, 1e-9, `day ${i}`));
  // a null stays null and does not enter the means: 28 days, four of every weekday, one Thursday blanked
  const rowsN = dates(28).map((d, i) => ({ d, v: i === 3 ? null : (i % 7) * 10 }));
  const resN = residualiseByWeekday(rowsN);
  assert.equal(resN[3], null);
  resN.forEach((r, i) => { if (i !== 3) near(r, 0, 1e-9, `day ${i}`); });
  // with that Thursday gone the weekday has 3 values left and is still adjusted on its own mean; at 2 it is pooled
  const rowsP = dates(21).map((d, i) => ({ d, v: i === 3 ? null : (i % 7) * 10 }));
  const resP = residualiseByWeekday(rowsP);
  const grandP = rowsP.filter((r) => r.v != null).reduce((a, r) => a + r.v, 0) / 20;
  near(resP[10], 30 - grandP, 1e-9, "two Thursdays left: grand mean");
  near(resP[4], 0, 1e-9, "Fridays still have three");
  assert.deepEqual(residualiseByWeekday([]), []);
});

test("normalCdf and fisherCI: known values, and a small r at n = 20 keeps 0 inside the interval", () => {
  near(normalCdf(0), 0.5, 1e-7);
  near(normalCdf(1.96), 0.975, 3e-4);
  near(normalCdf(-1.96), 0.025, 3e-4);
  const ci = fisherCI(0.5, 30);
  near(ci.lo, 0.17, 0.005, "lo");
  near(ci.hi, 0.73, 0.005, "hi");
  assert.ok(ci.p < 0.01 && ci.p > 0.001, `p ${ci.p}`);
  assert.equal(ci.method, "fisher");
  const wide = fisherCI(0.1, 20);
  assert.ok(wide.lo < 0 && wide.hi > 0, "contains 0");
  assert.ok(wide.p > 0.5);
  const floor = fisherCI(0.3, 4);
  near(floor.lo, Math.tanh(Math.atanh(0.3) - 1.96), 1e-9, "n under 4 is floored at 4");
});

test("rGate: the r whose 95% Fisher interval first excludes zero at that effective count", () => {
  near(rGate(30), 0.360, 0.002);
  near(rGate(18), 0.467, 0.002);
  for (const n of [8, 18, 30, 60]) {
    const g = rGate(n);
    assert.ok(fisherCI(g + 0.002, n).lo > 0, `just over the gate at ${n}`);
    assert.ok(fisherCI(g - 0.002, n).lo < 0, `just under the gate at ${n}`);
  }
  assert.equal(rGate(2), rGate(4), "floored at 4");
});

test("blockBootstrapCI: independent series keep 0 inside, a near-identity pair excludes it, and a seed makes it repeatable", () => {
  const xs = whiteNoise(60, 11), ys = whiteNoise(60, 12);
  const ci = blockBootstrapCI(xs, ys, { block: 7, reps: 500, seed: 1 });
  assert.ok(ci.lo < 0 && ci.hi > 0, `independent: ${ci.lo} ${ci.hi}`);
  assert.ok(ci.p > 0.05, `p ${ci.p}`);
  assert.equal(ci.method, "bootstrap");
  const zs = xs.map((x, i) => x + 0.3 * ys[i]);
  const tight = blockBootstrapCI(xs, zs, { block: 7, reps: 500, seed: 1 });
  assert.ok(tight.lo > 0.5 && tight.hi <= 1, `near identity: ${tight.lo} ${tight.hi}`);
  assert.ok(tight.p < 0.01, `p ${tight.p}`);
  assert.deepEqual(blockBootstrapCI(xs, ys, { seed: 7 }), blockBootstrapCI(xs, ys, { seed: 7 }), "same seed, same interval");
  const other = blockBootstrapCI(xs, ys, { seed: 8 });
  assert.ok(other.lo !== ci.lo || other.hi !== ci.hi, "a different seed resamples differently");
  assert.deepEqual(blockBootstrapCI([1, 2, 3], [1, 2, 3]), { lo: -1, hi: 1, p: 1, method: "bootstrap" }, "under 4 pairs");
});

test("bhGate: [0.01, 0.04, 0.2] at q = 0.10 passes the first two; nulls are not tested", () => {
  assert.deepEqual(bhGate([0.01, 0.04, 0.2], 0.1), [true, true, false]);
  assert.deepEqual(bhGate([0.2, 0.01, 0.04], 0.1), [false, true, true], "order does not matter");
  assert.deepEqual(bhGate([0.01, null, 0.2], 0.1), [true, false, false]);
  assert.deepEqual(bhGate([0.5, 0.6, 0.7], 0.1), [false, false, false]);
  assert.deepEqual(bhGate([0.02, 0.03, 0.04, 0.05], 0.1), [true, true, true, true], "the largest passing p lets the smaller ones through");
  assert.deepEqual(bhGate([], 0.1), []);
});

test("pairLag1: pairs go through the date map, so a gap drops the pair instead of pairing across it", () => {
  const days = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-09", "2026-01-10"].map((d, i) => ({ d, x: i + 1, y: (i + 1) * 10 }));
  const same = pairLag1(days, (d) => d.x, (d) => d.y, 0);
  assert.equal(same.pairs.length, 5);
  assert.equal(same.dropped, 0);
  assert.deepEqual(same.pairs[0], { dx: "2026-01-05", dy: "2026-01-05", x: 1, y: 10 });
  const next = pairLag1(days, (d) => d.x, (d) => d.y, 1);
  assert.deepEqual(next.pairs.map((p) => [p.dx, p.dy, p.x, p.y]), [
    ["2026-01-05", "2026-01-06", 1, 20], ["2026-01-06", "2026-01-07", 2, 30], ["2026-01-09", "2026-01-10", 4, 50]]);
  assert.equal(next.dropped, 2, "Jan 7 has no Jan 8, Jan 10 has no Jan 11");
  assert.ok(next.pairs.every((p) => p.dy !== "2026-01-09" || p.dx === "2026-01-08"), "nothing pairs Jan 7 with Jan 9 by position");
  // a partner day with no y is a gap too; a same-day missing y is not
  const holes = days.map((d) => ({ ...d, y: d.d === "2026-01-06" ? null : d.y }));
  assert.equal(pairLag1(holes, (d) => d.x, (d) => d.y, 1).dropped, 3);
  assert.equal(pairLag1(holes, (d) => d.x, (d) => d.y, 0).dropped, 0);
  assert.equal(pairLag1(holes, (d) => d.x, (d) => d.y, 0).pairs.length, 4);
  // accessors get the context
  const ctx = { z: { "2026-01-06": 0.5 } };
  const viaCtx = pairLag1(days, (d) => d.x, (d, c) => c.z[d.d] ?? null, 1, ctx);
  assert.deepEqual(viaCtx.pairs, [{ dx: "2026-01-05", dy: "2026-01-06", x: 1, y: 0.5 }]);
});

test("liftZByDate and sets7ByDate: per-date means of the lift residuals, and trailing 7-day fractional sets", () => {
  const progress = [
    { lift: "a", resid: [{ d: "2026-06-01", z: 1 }, { d: "2026-06-03", z: -1 }] },
    { lift: "b", resid: [{ d: "2026-06-01", z: 0 }] },
    { lift: "c", resid: [] },
    { lift: "d" },
  ];
  assert.deepEqual(liftZByDate(progress), { "2026-06-01": 0.5, "2026-06-03": -1 });
  assert.deepEqual(liftZByDate(undefined), {});
  const days = dates(10).map((d, i) => ({ d, ...(i === 0 ? { wmus: { chest: 3, triceps: 1.5 } } : i === 3 ? { wmus: { back: 4 } } : i === 8 ? { wmus: { quads: 2 } } : {}) }));
  const s7 = sets7ByDate(days);
  assert.equal(s7[days[0].d], 4.5);
  assert.equal(s7[days[3].d], 8.5);
  assert.equal(s7[days[6].d], 8.5, "day 0 is still inside the 7 days ending on day 6");
  assert.equal(s7[days[7].d], 4, "day 0 has fallen out");
  assert.equal(s7[days[8].d], 6);
  assert.equal(s7[days[9].d], 6);
});

// a synthetic 42-day record: y1 follows x closely, y2 is noise made orthogonal to x (sample r exactly 0
// before the weekday adjustment), and a lag-1 outcome follows the day before
function syntheticDays(seed) {
  const xs = whiteNoise(42, seed + 1), noise = whiteNoise(42, seed + 2), other = whiteNoise(42, seed + 3);
  const mx = xs.reduce((a, b) => a + b, 0) / 42, mo = other.reduce((a, b) => a + b, 0) / 42;
  let sxx = 0, sxo = 0;
  for (let i = 0; i < 42; i++) { sxx += (xs[i] - mx) ** 2; sxo += (xs[i] - mx) * (other[i] - mo); }
  const y2 = other.map((o, i) => o - (sxo / sxx) * xs[i]);
  return dates(42).map((d, i) => ({
    d, x: xs[i], y1: xs[i] + 0.3 * noise[i], y2: y2[i],
    next: i > 0 ? xs[i - 1] + 0.3 * noise[i] : null, flat: 5,
  }));
}
const TIERS = { analytics: ["x", "y1", "y2", "next", "flat"], displayOnly: ["score", "rec"] };
const HYPS = [
  { id: "mech", block: "mechanical", lag: 0, xKey: "x", yKey: "y1", x: (d) => d.x, y: (d) => d.y1 },
  { id: "tight", block: "uncertain", lag: 0, xKey: "x", yKey: "y1", x: (d) => d.x, y: (d) => d.y1 },
  { id: "noise", block: "uncertain", lag: 0, xKey: "x", yKey: "y2", x: (d) => d.x, y: (d) => d.y2 },
  { id: "lagged", block: "uncertain", lag: 1, xKey: "x", yKey: "next", x: (d) => d.x, y: (d) => d.next },
  { id: "flat", block: "uncertain", lag: 0, xKey: "x", yKey: "flat", x: (d) => d.x, y: (d) => d.flat },
  { id: "thin", block: "uncertain", lag: 0, xKey: "x", yKey: "y1", x: (d) => (d.d < "2026-01-10" ? d.x : null), y: (d) => d.y1 },
];

test("analyseHypotheses: cards align with the list, the tight pair clears the gate, noise and a flat series do not", () => {
  const days = syntheticDays(20);
  const res = analyseHypotheses(days, HYPS, {}, TIERS, { q: 0.1, seed: 3 });
  assert.deepEqual(res.cards.map((c) => c.id), HYPS.map((h) => h.id));
  const [mech, tight, noise, lagged, flat, thin] = res.cards;
  assert.equal(mech.r, null, "a mechanical card carries pairs only");
  assert.equal(mech.n, 42);
  assert.ok(tight.r > 0.9 && tight.pass && tight.ci[0] > 0.7, `tight ${tight.r} ${tight.ci}`);
  assert.equal(tight.method, "bootstrap");
  assert.ok(!noise.pass && noise.ci[0] < 0 && noise.ci[1] > 0, `noise ${noise.r} ${noise.ci}`);
  assert.ok(lagged.pass && lagged.n === 41 && lagged.dropped === 1, `lagged ${lagged.r} n ${lagged.n} dropped ${lagged.dropped}`);
  assert.equal(flat.r, null, "no spread");
  assert.equal(flat.pass, false);
  assert.equal(thin.n, 5);
  assert.equal(thin.r, null, "under 8 pairs: no statistics");
  assert.equal(thin.p, null);
  assert.equal(res.gate.tested, 3, "flat and thin are not tested");
  assert.ok(res.gate.medianNEff >= 4 && res.gate.medianNEff <= 42);
  near(res.gate.rGate, rGate(res.gate.medianNEff), 1e-12);
  for (const c of [tight, noise, lagged]) {
    assert.ok(c.nEff >= 4 && c.nEff <= c.n, `nEff ${c.nEff} of ${c.n}`);
    assert.equal(typeof c.slope, "number");
    assert.equal(c.pairs.length, c.n);
  }
  // the same window twice prints the same numbers
  const again = analyseHypotheses(days, HYPS, {}, TIERS, { q: 0.1, seed: 3 });
  assert.deepEqual(again.cards.map((c) => [c.r, c.ci, c.p, c.nEff]), res.cards.map((c) => [c.r, c.ci, c.p, c.nEff]));
  // under 12 pairs the interval comes from Fisher z
  const short = analyseHypotheses(days.slice(0, 10), HYPS, {}, TIERS, { q: 0.1, seed: 3 });
  assert.equal(short.cards[1].method, "fisher");
  assert.equal(short.cards[1].n, 10);
});

test("analyseHypotheses: a display-only key or one outside the analytics tier is refused", () => {
  const days = syntheticDays(21);
  assert.throws(() => analyseHypotheses(days, [{ id: "bad", block: "uncertain", lag: 0, xKey: "score", yKey: "y1", x: (d) => d.x, y: (d) => d.y1 }], {}, TIERS, {}),
    /display-only key: score \(bad\)/);
  assert.throws(() => analyseHypotheses(days, [{ id: "bad2", block: "mechanical", lag: 0, xKey: "x", yKey: "rec", x: (d) => d.x, y: (d) => d.y1 }], {}, TIERS, {}),
    /display-only key: rec \(bad2\)/, "mechanical cards are held to the same tiers");
  assert.throws(() => analyseHypotheses(days, [{ id: "odd", block: "uncertain", lag: 0, xKey: "temp", yKey: "y1", x: (d) => d.x, y: (d) => d.y1 }], {}, TIERS, {}),
    /outside the analytics tier: temp \(odd\)/);
  assert.doesNotThrow(() => analyseHypotheses(days, HYPS, {}, null, {}), "no tiers given: nothing to refuse");
});

test("STATS_FN_JS: the page copy is self-contained source, carries no NaN literal, and runs", () => {
  assert.ok(STATS_FN_JS.startsWith("function statDayMs("), "starts with the first helper");
  for (const name of ["lag1", "nEff", "residualiseByWeekday", "blockBootstrapCI", "fisherCI", "bhGate", "pairLag1", "liftZByDate", "sets7ByDate", "analyseHypotheses", "rGate"]) {
    assert.ok(STATS_FN_JS.includes(`function ${name}(`), name);
  }
  assert.ok(!/\bimport\b|\bexport\b|\brequire\(/.test(STATS_FN_JS), "no module syntax");
  assert.ok(!STATS_FN_JS.includes("NaN"), "the page's leak test looks for the literal");
  const fn = new Function(STATS_FN_JS + "\nreturn { bhGate, nEff, analyseHypotheses, rGate };")();
  assert.deepEqual(fn.bhGate([0.01, 0.04, 0.2], 0.1), [true, true, false]);
  assert.equal(fn.nEff(30, 0.5, 0.5), 18);
  const res = fn.analyseHypotheses(syntheticDays(22), HYPS, {}, TIERS, { q: 0.1, seed: 3 });
  assert.ok(res.cards[1].pass, "the tight pair passes in the page copy");
  assert.ok(!res.cards[2].pass, "the orthogonal pair does not");
});
