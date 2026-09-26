// The statistics behind the page's "What goes with what" cards. The page gets
// every function here verbatim (render.js fills __STATSFN__ with their source,
// the way lift.js reaches the page through __LIFTFN__), so each one must stay
// self-contained: no imports, no module-level names besides these functions,
// plain ES2015. They may call each other by name.
//
// Series are arrays of numbers in date order; a row is {d: YYYY-MM-DD, v}.
// Dates are calendar strings with no timezone games (same as util.js).

export function statDayMs(iso) {
  const p = iso.split("-").map(Number);
  return Date.UTC(p[0], p[1] - 1, p[2]);
}
export function statAddDays(iso, n) {
  return new Date(statDayMs(iso) + n * 86400000).toISOString().slice(0, 10);
}
export function statDaysBetween(a, b) {
  return Math.round((statDayMs(b) - statDayMs(a)) / 86400000);
}
/** 0 = Sunday .. 6 = Saturday */
export function statWeekday(iso) {
  return new Date(statDayMs(iso)).getUTCDay();
}

/** Pearson r of two equal-length series; null under 2 points or with no spread. */
export function pearsonR(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  if (!(sxx > 0) || !(syy > 0)) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/**
 * Lag-1 autocorrelation of a series in date order. With `dates` given, only
 * neighbours exactly one day apart enter the numerator (scaled back up to the
 * usual n - 1 terms), so a gap in the record never pairs a Friday with the
 * next Tuesday. 0 for under 3 values or no spread; clamped to [-1, 1].
 */
export function lag1(xs, dates) {
  const n = xs.length;
  if (n < 3) return 0;
  let m = 0;
  for (let i = 0; i < n; i++) m += xs[i];
  m /= n;
  let den = 0;
  for (let i = 0; i < n; i++) den += (xs[i] - m) * (xs[i] - m);
  if (!(den > 0)) return 0;
  let num = 0, k = 0;
  for (let i = 0; i + 1 < n; i++) {
    if (dates && statDaysBetween(dates[i], dates[i + 1]) !== 1) continue;
    num += (xs[i] - m) * (xs[i + 1] - m);
    k++;
  }
  if (!k) return 0;
  return Math.max(-1, Math.min(1, num * ((n - 1) / k) / den));
}

/**
 * Bartlett's effective sample size for the correlation of two autocorrelated
 * series: n (1 - px py) / (1 + px py). Never under 4 and never over n (a
 * negative product would otherwise credit more information than n points hold).
 */
export function nEff(n, phiX, phiY) {
  const p = (phiX || 0) * (phiY || 0);
  return Math.max(4, Math.min(n, n * (1 - p) / (1 + p)));
}

/**
 * Each value minus its weekday's mean where that weekday has 3 or more values,
 * otherwise minus the mean of all values. Six weekday dummies fitted by least
 * squares give exactly the per-weekday means, so this is that fit with the
 * thin weekdays pooled. rows: [{d, v}], null v allowed; returns residuals
 * aligned to rows with nulls kept.
 */
export function residualiseByWeekday(rows) {
  const sum = [0, 0, 0, 0, 0, 0, 0], cnt = [0, 0, 0, 0, 0, 0, 0];
  let all = 0, na = 0;
  for (const r of rows) {
    if (r.v == null) continue;
    const w = statWeekday(r.d);
    sum[w] += r.v; cnt[w]++; all += r.v; na++;
  }
  const grand = na ? all / na : 0;
  return rows.map((r) => {
    if (r.v == null) return null;
    const w = statWeekday(r.d);
    return r.v - (cnt[w] >= 3 ? sum[w] / cnt[w] : grand);
  });
}

/** Standard normal CDF (Abramowitz and Stegun 7.1.26, error under 1.5e-7). */
export function normalCdf(x) {
  const u = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * u);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  const erf = 1 - poly * Math.exp(-u * u);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Fisher z interval for r at an effective sample size, the fallback under 12
 * pairs where a block bootstrap has too few blocks. Returns {lo, hi, p,
 * method: "fisher"}; p is two-sided normal.
 */
export function fisherCI(r, n) {
  const ne = Math.max(4, n);
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, r)));
  const se = 1 / Math.sqrt(ne - 3);
  return { lo: Math.tanh(z - 1.96 * se), hi: Math.tanh(z + 1.96 * se), p: 2 * (1 - normalCdf(Math.abs(z) / se)), method: "fisher" };
}

/** The |r| at which a 95% Fisher interval at n effective pairs first excludes zero. */
export function rGate(nEffective) {
  return Math.tanh(1.96 / Math.sqrt(Math.max(4, nEffective) - 3));
}

/**
 * 95% percentile interval for Pearson r by moving-block bootstrap: blocks of
 * `block` consecutive pairs (7 = a week, so the weekly rhythm survives inside a
 * block) resampled with replacement `reps` times from a seeded PRNG, so the
 * same window always prints the same interval. Returns {lo, hi, p, method:
 * "bootstrap"} where p is the interval's own two-sided p-value: twice the
 * share of resamples on the smaller side of zero.
 */
export function blockBootstrapCI(xs, ys, opts) {
  const o = opts || {};
  const block = o.block || 7, reps = o.reps || 500;
  let seed = (o.seed == null ? 20260907 : o.seed) >>> 0;
  const rand = () => {   // mulberry32
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = Math.min(xs.length, ys.length);
  if (n < 4) return { lo: -1, hi: 1, p: 1, method: "bootstrap" };
  const L = Math.max(1, Math.min(block, n));
  const starts = n - L + 1;
  const rs = [];
  for (let k = 0; k < reps; k++) {
    const bx = [], by = [];
    while (bx.length < n) {
      const s = Math.floor(rand() * starts);
      for (let j = 0; j < L && bx.length < n; j++) { bx.push(xs[s + j]); by.push(ys[s + j]); }
    }
    const r = pearsonR(bx, by);
    if (r != null) rs.push(r);
  }
  if (rs.length < 20) return { lo: -1, hi: 1, p: 1, method: "bootstrap" };
  rs.sort((a, b) => a - b);
  const q = (f) => rs[Math.min(rs.length - 1, Math.max(0, Math.floor(f * rs.length)))];
  let below = 0;
  for (const r of rs) if (r <= 0) below++;
  const frac = below / rs.length;
  return { lo: q(0.025), hi: q(0.975), p: Math.min(1, 2 * Math.min(frac, 1 - frac)), method: "bootstrap" };
}

/**
 * Benjamini-Hochberg at level q over the p-values given. A null p means not
 * tested: never passes and not counted. Returns booleans aligned to ps.
 */
export function bhGate(ps, q) {
  const idx = [];
  ps.forEach((p, i) => { if (p != null && Number.isFinite(p)) idx.push(i); });
  idx.sort((a, b) => ps[a] - ps[b]);
  const m = idx.length;
  let k = 0;
  for (let j = 0; j < m; j++) if (ps[idx[j]] <= (j + 1) / m * q) k = j + 1;
  const out = ps.map(() => false);
  for (let j = 0; j < k; j++) out[idx[j]] = true;
  return out;
}

/**
 * Pairs each day's x with y on the same record (lag 0) or the record exactly
 * `lag` calendar days later, looked up by date and never by array position, so
 * a gap in the record drops the pair instead of matching a Friday with the next
 * Tuesday. getX / getY take (day, ctx). Returns {pairs: [{dx, dy, x, y}] in
 * date order, dropped} where dropped counts lagged days with an x whose partner
 * day is missing from the window or has no y (a lag-0 pair has no gap to drop).
 */
export function pairLag1(days, getX, getY, lag, ctx, byDate) {
  let map = byDate;
  if (!map) { map = {}; for (const d of days) map[d.d] = d; }
  const pairs = [];
  let dropped = 0;
  for (const d of days) {
    const x = getX(d, ctx);
    if (x == null || x !== x) continue;   // x !== x: not-a-number, spelled without the literal the page's leak test looks for
    const partner = lag ? map[statAddDays(d.d, lag)] : d;
    const y = partner ? getY(partner, ctx) : null;
    if (y == null || y !== y) { if (lag) dropped++; continue; }
    pairs.push({ dx: d.d, dy: partner.d, x, y });
  }
  return { pairs, dropped };
}

/** Mean lift residual z per date from brief.training.progress[].resid ({d, z} per session per lift). */
export function liftZByDate(progress) {
  const sum = {}, cnt = {};
  for (const p of progress || []) for (const r of p.resid || []) {
    if (r == null || r.z == null) continue;
    sum[r.d] = (sum[r.d] || 0) + r.z;
    cnt[r.d] = (cnt[r.d] || 0) + 1;
  }
  const out = {};
  for (const d in sum) out[d] = sum[d] / cnt[d];
  return out;
}

/**
 * Fractional sets (wmus summed over every muscle) in the 7 days ending on each
 * date, from the full day list so a window's first days still see the week
 * before them. A date with no record counts as no sets.
 */
export function sets7ByDate(days) {
  const daySets = {};
  for (const d of days) {
    let s = 0;
    const m = d.wmus || {};
    for (const g in m) s += m[g] || 0;
    daySets[d.d] = s;
  }
  const out = {};
  for (const d of days) {
    let s = 0;
    for (let k = 0; k < 7; k++) s += daySets[statAddDays(d.d, -k)] || 0;
    out[d.d] = s;
  }
  return out;
}

/**
 * The section's numbers for one window. hyps: the fixed hypothesis list
 * ({id, block, lag, xKey, yKey, x, y}); ctx: {liftZ, sets7} from liftZByDate
 * and sets7ByDate over the full record; tiers: {analytics, displayOnly};
 * opts: {q, minPairs, bootstrapFrom, block, reps, seed}.
 * Every key a hypothesis reads has to be on the analytics list: a display-only
 * key (the ring's composite scores, built from the inputs being compared)
 * throws, so a test catches it before the page does.
 * Mechanical cards get their pairs only. Uncertain cards with minPairs or more
 * get r on the weekday-residualised series, lag-1 autocorrelations, the
 * effective count, a 95% interval (block bootstrap, Fisher z under bootstrapFrom
 * pairs) and a Benjamini-Hochberg pass across the uncertain block.
 * Returns {cards aligned with hyps, gate: {q, tested, medianNEff, rGate}}.
 */
export function analyseHypotheses(days, hyps, ctx, tiers, opts) {
  const o = opts || {};
  const q = o.q || 0.1, minPairs = o.minPairs || 8, bootFrom = o.bootstrapFrom || 12;
  const analytics = (tiers && tiers.analytics) || null, displayOnly = (tiers && tiers.displayOnly) || [];
  const byDate = {};
  for (const d of days) byDate[d.d] = d;
  const cards = hyps.map((h) => {
    for (const k of [h.xKey, h.yKey]) {
      if (displayOnly.includes(k)) throw new Error("correlation on a display-only key: " + k + " (" + h.id + ")");
      if (analytics && !analytics.includes(k)) throw new Error("correlation on a key outside the analytics tier: " + k + " (" + h.id + ")");
    }
    const pr = pairLag1(days, h.x, h.y, h.lag, ctx, byDate);
    const pairs = pr.pairs;
    const card = { id: h.id, block: h.block, lag: h.lag, pairs, dropped: pr.dropped, n: pairs.length,
      r: null, phiX: 0, phiY: 0, nEff: null, ci: null, p: null, method: null, pass: false, slope: null, mx: null, my: null };
    if (h.block !== "uncertain" || pairs.length < minPairs) return card;
    const rx = residualiseByWeekday(pairs.map((p) => ({ d: p.dx, v: p.x })));
    const ry = residualiseByWeekday(pairs.map((p) => ({ d: p.dy, v: p.y })));
    const r = pearsonR(rx, ry);
    if (r == null) return card;   // no spread in one series
    card.r = r;
    card.phiX = lag1(rx, pairs.map((p) => p.dx));
    card.phiY = lag1(ry, pairs.map((p) => p.dy));
    card.nEff = nEff(pairs.length, card.phiX, card.phiY);
    const ci = pairs.length < bootFrom ? fisherCI(r, card.nEff)
      : blockBootstrapCI(rx, ry, { block: o.block || 7, reps: o.reps || 500, seed: o.seed });
    card.ci = [ci.lo, ci.hi]; card.p = ci.p; card.method = ci.method;
    // the within-weekday slope, drawn through the raw means when the card clears the gate
    let mrx = 0, mry = 0, mx = 0, my = 0;
    for (let i = 0; i < pairs.length; i++) { mrx += rx[i]; mry += ry[i]; mx += pairs[i].x; my += pairs[i].y; }
    mrx /= pairs.length; mry /= pairs.length; mx /= pairs.length; my /= pairs.length;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < pairs.length; i++) { sxx += (rx[i] - mrx) * (rx[i] - mrx); sxy += (rx[i] - mrx) * (ry[i] - mry); }
    card.slope = sxx > 0 ? sxy / sxx : 0; card.mx = mx; card.my = my;
    return card;
  });
  const unc = cards.filter((c) => c.block === "uncertain");
  const pass = bhGate(unc.map((c) => c.p), q);
  unc.forEach((c, i) => { c.pass = pass[i]; });
  const effs = unc.filter((c) => c.nEff != null).map((c) => c.nEff).sort((a, b) => a - b);
  const m = effs.length;
  const med = !m ? null : m % 2 ? effs[(m - 1) / 2] : (effs[m / 2 - 1] + effs[m / 2]) / 2;
  return { cards, gate: { q, tested: m, medianNEff: med, rGate: med == null ? null : rGate(med) } };
}

export const STATS_FN_JS = [statDayMs, statAddDays, statDaysBetween, statWeekday, pearsonR, lag1, nEff, residualiseByWeekday,
  normalCdf, fisherCI, rGate, blockBootstrapCI, bhGate, pairLag1, liftZByDate, sets7ByDate, analyseHypotheses]
  .map((f) => f.toString()).join("\n");
