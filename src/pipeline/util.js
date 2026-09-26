// Shared helpers for the pipeline. Several keep the semantics of the Python
// original this was ported from (round-half-even, strftime labels, the
// statistics module); where that differs from plain JS the helper says so.

// The deployment's IANA time zone. Set once per request or cron run from the
// settings (worker.js applyTimeZone); every "local" date below is in this zone.
export let TZ = "UTC";
let partsFmt = makeFmt(TZ);

function makeFmt(tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

/** True when `tz` is an IANA zone this runtime knows. */
export function validTimeZone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try { makeFmt(tz); return true; } catch { return false; }
}

/** Switch the local zone; an unknown name leaves the current one in place. */
export function setTimeZone(tz) {
  if (tz === TZ || !validTimeZone(tz)) return TZ;
  TZ = tz;
  partsFmt = makeFmt(tz);
  return TZ;
}

/** Local calendar parts of an epoch-ms instant. */
export function localParts(ms) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    y: +p.year, m: +p.month, d: +p.day, h: (+p.hour) % 24, min: +p.minute, s: +p.second,
    date: `${p.year}-${p.month}-${p.day}`,
  };
}

/** Today's local date as YYYY-MM-DD. */
export function todayLocal(now = Date.now()) {
  return localParts(now).date;
}

/**
 * Local wall-clock stamp, YYYY-MM-DDTHH:MM:SS with no zone suffix.
 * brief.json carries this so the Worker's "refreshed today?" check compares a
 * local date with a local date; an evening refresh must not roll over to
 * the next UTC day.
 */
export function localStamp(now = Date.now()) {
  const p = localParts(now);
  const two = (n) => String(n).padStart(2, "0");
  return `${p.date}T${two(p.h)}:${two(p.min)}:${two(p.s)}`;
}

/** RFC3339 with any number of fractional digits -> epoch ms (null if unparsable). */
export function parseTs(s) {
  if (!s || typeof s !== "string") return null;
  const t = Date.parse(s.trim().replace(/\.(\d{3})\d+(?=[Z+-])/, ".$1"));
  return Number.isNaN(t) ? null : t;
}

/** Python round(): round half to even, on the decimal-scaled value. */
export function pyRound(x, nd = 0) {
  if (x === null || x === undefined || Number.isNaN(x)) return x;
  const f = 10 ** nd;
  const y = x * f;
  const r = Math.round(y);
  // exact tie -> even
  if (Math.abs(y - Math.trunc(y)) === 0.5) {
    const fl = Math.floor(y);
    const out = fl % 2 === 0 ? fl : fl + 1;
    return nd ? out / f : out;
  }
  return nd ? r / f : r;
}

/** Python f"{x:.nf}" (half-even on the scaled value, keeps trailing zeros). */
export function fmtF(x, nd) {
  const v = pyRound(x, nd);
  return v.toFixed(nd);
}

/** Python f"{x:,.0f}". */
export function fmtComma0(x) {
  return pyRound(x, 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Python f"{x:+.nf}". */
export function fmtSigned(x, nd) {
  const s = fmtF(x, nd);
  return x >= 0 && !s.startsWith("-") ? "+" + s : s;
}

// ---- dates (YYYY-MM-DD strings, no timezone games)
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function dateParts(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}
export function dateFromParts(y, m, d) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
/** Python date.weekday(): Monday=0. */
export function weekday(iso) {
  const { y, m, d } = dateParts(iso);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}
export function addDays(iso, n) {
  const { y, m, d } = dateParts(iso);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return dateFromParts(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export function daysBetween(a, b) {
  const pa = dateParts(a), pb = dateParts(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}
/** strftime("%b %d").replace(" 0", " ") -> "Aug 2" */
export function lblShort(iso) {
  const { m, d } = dateParts(iso);
  return `${MON[m - 1]} ${d}`;
}
/** strftime("%B %d").replace(" 0", " ") -> "August 2" */
export function lblLong(iso) {
  const { m, d } = dateParts(iso);
  return `${MONTH[m - 1]} ${d}`;
}
export function wdName(iso) {
  return WD[weekday(iso)];
}
export function mondayOf(iso) {
  return addDays(iso, -weekday(iso));
}

// ---- statistics (Python statistics module semantics)
export function mean(v) {
  return v.reduce((a, b) => a + b, 0) / v.length;
}
export function median(v) {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
export function pstdev(v) {
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}
export function pearson(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null);
  const n = pts.length;
  if (n < 8) return null;
  const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  if (!sxx || !syy) return null;
  return sxy / Math.sqrt(sxx * syy);
}
