// Sleep and recovery sources that sign in with OAuth (oauth.js). Each adapter:
//   fetchDays(env, secrets, uid, startDate, endDate) -> {YYYY-MM-DD: rawDay}
//   toRec(rawDay, date) -> a ring record shaped like summarize.js ringRec, or null
// A night belongs to the day it ends (the wake-up day), as with Ultrahuman.
// Fields a source does not have stay null and the page leaves them out.
import { authedGet, ReconnectError } from "../oauth.js";
import { minimalRec, clockFields } from "./summarize.js";
import { addDays, pyRound } from "./util.js";

const secs = (iso) => { const ms = Date.parse(iso || ""); return Number.isNaN(ms) ? null : Math.floor(ms / 1000); };
const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const minutes = (s) => (s == null ? null : Math.round(s / 60));

/** Merge back-to-back segments of the same stage: [[start, end, code], ...]. */
function mergeSegs(segs) {
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last[2] === s[2] && last[1] === s[0]) last[1] = s[1];
    else out.push([...s]);
  }
  return out;
}

// ================================================================ Oura
// https://cloud.ouraring.com/v2/docs (OpenAPI 1.41). Sleep periods, daily sleep
// score, readiness (score and temperature deviation), activity (steps), SpO2 and
// VO2 max, each a ranged list: {data: [...], next_token}.
export const OURA_BASE = "https://api.ouraring.com/v2/usercollection";
const OURA_COLLECTIONS = { sleep: "sleep", dailySleep: "daily_sleep", readiness: "daily_readiness", activity: "daily_activity", spo2: "daily_spo2", vo2: "vO2_max" };
const OURA_PHASE = { 1: "de", 2: "li", 3: "re", 4: "aw" };

async function ouraList(env, secrets, uid, collection, start, end, optional = false) {
  const out = [];
  let next = null;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ start_date: start, end_date: end });
    if (next) q.set("next_token", next);
    const j = await authedGet(env, secrets, uid, "oura", `${OURA_BASE}/${collection}?${q}`, undefined, { optional });
    out.push(...(j.data || []));
    next = j.next_token;
    if (!next) break;
  }
  return out;
}

/** The night that scores the day: the long_sleep with the most sleep; never rest/deleted. */
export function ouraMainSleep(periods) {
  const usable = (periods || []).filter((p) => p && p.type !== "rest" && p.type !== "deleted");
  const long = usable.filter((p) => p.type === "long_sleep");
  const pool = long.length ? long : usable;
  return pool.sort((a, b) => (b.total_sleep_duration || 0) - (a.total_sleep_duration || 0))[0] || null;
}

export const oura = {
  async fetchDays(env, secrets, uid, start, end) {
    // pad a day each side: Oura buckets some ranges by the UTC start of a night
    const s = addDays(start, -1), e = addDays(end, 1);
    const days = {};
    const bucket = (d) => (days[d] ||= { sleep: [] });
    for (const [key, coll] of Object.entries(OURA_COLLECTIONS)) {
      let rows;
      try { rows = await ouraList(env, secrets, uid, coll, s, e, key === "vo2" || key === "spo2"); }
      catch (err) {
        // VO2 max and SpO2 need newer rings; a 403/404 on those must not sink the rest
        if ((key === "vo2" || key === "spo2") && !(err instanceof ReconnectError)) continue;
        throw err;
      }
      for (const r of rows) {
        if (!r || !r.day || r.day < start || r.day > end) continue;
        if (key === "sleep") bucket(r.day).sleep.push(r);
        else bucket(r.day)[key] = r;
      }
    }
    return days;
  },

  toRec(raw, d) {
    const sl = ouraMainSleep(raw.sleep);
    const rd = raw.readiness || (sl && sl.readiness) || {};
    if (!sl && !raw.dailySleep && !raw.readiness && !raw.activity) return null;
    const bt = sl ? secs(sl.bedtime_start) : null, wt = sl ? secs(sl.bedtime_end) : null;
    const rec = {
      ...minimalRec(d),
      nsc: 1,
      score: num(raw.dailySleep && raw.dailySleep.score),
      rec: num(rd.score),
      mov: null,
      slh: sl && sl.total_sleep_duration != null ? pyRound(sl.total_sleep_duration / 3600, 2) : null,
      tib: sl && sl.time_in_bed != null ? pyRound(sl.time_in_bed / 3600, 2) : null,
      eff: num(sl && sl.efficiency),
      rest: null,
      deep: minutes(sl && sl.deep_sleep_duration),
      rem: minutes(sl && sl.rem_sleep_duration),
      light: minutes(sl && sl.light_sleep_duration),
      hrv: num(sl && sl.average_hrv),
      rhr: num(sl && sl.lowest_heart_rate),
      temp: num(rd.temperature_deviation),
      steps: raw.activity && raw.activity.steps != null ? Math.trunc(raw.activity.steps) : null,
      alert: null,
      toss: num(sl && sl.restless_periods),
      vo2: num(raw.vo2 && raw.vo2.vo2_max),
      spo2: num(raw.spo2 && raw.spo2.spo2_percentage && raw.spo2.spo2_percentage.average),
      ...clockFields(bt, wt),
    };
    // hypnogram from the 5-minute phase string ('1' deep, '2' light, '3' REM, '4' awake)
    const phases = sl && typeof sl.sleep_phase_5_min === "string" ? sl.sleep_phase_5_min : "";
    if (bt && phases) {
      const segs = [...phases].map((c, i) => [bt + i * 300, bt + (i + 1) * 300, OURA_PHASE[c] || "aw"]);
      rec.hyp = mergeSegs(segs);
    }
    return rec;
  },
};

// ================================================================ Google Health
// https://developers.google.com/health (API v4, discovery document). Sleep is a
// session with stages; resting HR, HRV, SpO2, skin temperature and VO2 max are
// daily data points keyed by a civil date; steps are summed per civil day with
// dailyRollUp. Google publishes no sleep or recovery score, so those stay null.
export const GOOGLE_BASE = "https://health.googleapis.com/v4/users/me/dataTypes";
const G_STAGE = { AWAKE: "aw", RESTLESS: "aw", LIGHT: "li", ASLEEP: "li", DEEP: "de", REM: "re" };
const G_DAILY = {
  rhr: ["daily-resting-heart-rate", "daily_resting_heart_rate", "dailyRestingHeartRate"],
  hrv: ["daily-heart-rate-variability", "daily_heart_rate_variability", "dailyHeartRateVariability"],
  spo2: ["daily-oxygen-saturation", "daily_oxygen_saturation", "dailyOxygenSaturation"],
  temp: ["daily-sleep-temperature-derivations", "daily_sleep_temperature_derivations", "dailySleepTemperatureDerivations"],
  vo2: ["daily-vo2-max", "daily_vo2_max", "dailyVo2Max"],
};
const ymd = (o) => (o && o.year ? `${o.year}-${String(o.month).padStart(2, "0")}-${String(o.day).padStart(2, "0")}` : null);
const civilDate = ([y, m, d]) => ({ year: y, month: m, day: d });
const parts = (iso) => iso.split("-").map(Number);

async function googleList(env, secrets, uid, type, filter, optional = false) {
  const out = [];
  let token = "";
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ filter, pageSize: "1000" });
    if (token) q.set("pageToken", token);
    const j = await authedGet(env, secrets, uid, "google", `${GOOGLE_BASE}/${type}/dataPoints?${q}`, undefined, { optional });
    out.push(...(j.dataPoints || []));
    token = j.nextPageToken;
    if (!token) break;
  }
  return out;
}

/** The main night among one day's sessions: flagged mainSleep, else the longest non-nap. */
export function googleMainSleep(sessions) {
  const all = (sessions || []).filter(Boolean);
  const main = all.find((s) => s.metadata && s.metadata.mainSleep);
  if (main) return main;
  const asleep = (s) => num(s.summary && s.summary.minutesAsleep) || 0;
  return all.filter((s) => !(s.metadata && s.metadata.nap)).sort((a, b) => asleep(b) - asleep(a))[0] || null;
}

export const google = {
  async fetchDays(env, secrets, uid, start, end) {
    const days = {};
    const bucket = (d) => (days[d] ||= { sleep: [] });
    const endX = addDays(end, 1);                       // filters are closed-open
    const sleeps = await googleList(env, secrets, uid, "sleep",
      `sleep.interval.civil_end_time >= "${start}" AND sleep.interval.civil_end_time < "${endX}"`);
    for (const p of sleeps) {
      const s = p.sleep;
      const d = s && s.interval && s.interval.civilEndTime && ymd(s.interval.civilEndTime.date);
      if (d && d >= start && d <= end) bucket(d).sleep.push(s);
    }
    for (const [key, [type, filterName, field]] of Object.entries(G_DAILY)) {
      let rows;
      try { rows = await googleList(env, secrets, uid, type, `${filterName}.date >= "${start}" AND ${filterName}.date < "${endX}"`, true); }
      catch (err) {
        if (err instanceof ReconnectError) throw err;
        continue;                                       // a device without that sensor
      }
      for (const p of rows) {
        const v = p[field];
        const d = v && ymd(v.date);
        if (d && d >= start && d <= end) bucket(d)[key] = v;
      }
    }
    // steps: one total per civil day (dailyRollUp allows 90 days per request)
    for (let s = start; s <= end; s = addDays(s, 90)) {
      const e = addDays(s, 90) > endX ? endX : addDays(s, 90);
      const j = await authedGet(env, secrets, uid, "google", `${GOOGLE_BASE}/steps/dataPoints:dailyRollUp`,
        { range: { start: { date: civilDate(parts(s)) }, end: { date: civilDate(parts(e)) } }, windowSizeDays: 1 });
      for (const r of j.rollupDataPoints || []) {
        const d = ymd(r.civilStartTime && r.civilStartTime.date);
        if (d && d >= start && d <= end && r.steps) bucket(d).steps = num(r.steps.countSum);
      }
    }
    return days;
  },

  toRec(raw, d) {
    const sl = googleMainSleep(raw.sleep);
    if (!sl && !raw.rhr && !raw.hrv && raw.steps == null) return null;
    const sum = (sl && sl.summary) || {};
    const stage = (t) => {
      const x = (sum.stagesSummary || []).filter((z) => z.type === t).reduce((a, z) => a + (num(z.minutes) || 0), 0);
      return (sum.stagesSummary || []).some((z) => z.type === t) ? x : null;
    };
    const asleep = num(sum.minutesAsleep), period = num(sum.minutesInSleepPeriod);
    const bt = sl ? secs(sl.interval.startTime) : null, wt = sl ? secs(sl.interval.endTime) : null;
    const t = raw.temp;
    const rec = {
      ...minimalRec(d),
      nsc: 1,
      score: null,
      rec: null,
      mov: null,
      slh: asleep != null ? pyRound(asleep / 60, 2) : null,
      tib: period != null ? pyRound(period / 60, 2) : null,
      eff: asleep != null && period ? Math.round((asleep / period) * 100) : null,
      rest: null,
      deep: stage("DEEP"),
      rem: stage("REM"),
      // classic (stage-less) nights report ASLEEP; count it as light so the stage chart still has a bar
      light: stage("LIGHT") ?? stage("ASLEEP"),
      hrv: num(raw.hrv && raw.hrv.averageHeartRateVariabilityMilliseconds),
      rhr: num(raw.rhr && raw.rhr.beatsPerMinute),
      temp: t && t.nightlyTemperatureCelsius != null && t.baselineTemperatureCelsius != null
        ? pyRound(Number(t.nightlyTemperatureCelsius) - Number(t.baselineTemperatureCelsius), 2) : null,
      steps: raw.steps != null ? Math.trunc(raw.steps) : null,
      alert: null,
      toss: null,
      vo2: num(raw.vo2 && raw.vo2.vo2Max),
      spo2: num(raw.spo2 && raw.spo2.averagePercentage),
      ...clockFields(bt, wt),
    };
    const segs = (sl && sl.stages || []).map((s) => [secs(s.startTime), secs(s.endTime), G_STAGE[s.type] || "aw"])
      .filter((s) => s[0] && s[1]).sort((a, b) => a[0] - b[0]);
    if (segs.length) rec.hyp = mergeSegs(segs);
    return rec;
  },
};

export const RING_ADAPTERS = { oura, google };
