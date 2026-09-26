// Rule-based insight cards and their HTML.
import { mean, median, pstdev, fmtF, fmtComma0, fmtSigned, lblShort, lblLong, addDays, hasNight } from "./util.js";

function fmtH(hours) {
  const h = Math.trunc(hours);
  return `${h}h ${String(Math.round((hours - h) * 60)).padStart(2, "0")}m`;
}

export function buildInsights(days, today, unit = "lb") {
  const slept = days.filter(hasNight);
  const out = [];
  if (!slept.length) return out;

  // 1. weeknight sleep shortfall
  const durs = slept.filter((x) => x.slh).map((x) => x.slh);
  const avgAll = mean(durs);
  const wk = slept.filter((x) => x.wd !== "Sat" && x.wd !== "Sun" && x.slh).map((x) => x.slh);
  const we = slept.filter((x) => (x.wd === "Sat" || x.wd === "Sun") && x.slh).map((x) => x.slh);
  const shortN = durs.filter((v) => v < 6.5).length;
  if (wk.length && avgAll < 7.3) {
    let body = `Across ${durs.length} recorded nights you averaged ${fmtH(avgAll)} asleep (time in bed not counted). Weeknights average ${fmtH(mean(wk))}`;
    if (we.length) body += `, weekend nights ${fmtH(mean(we))}`;
    body += `. ${shortN} nights were under 6h 30m. A 7-hour floor on weeknights closes most of the gap. Weekend catch-up sleep leaves the weeknight deficit in place.`;
    out.push(["Sleep", "Weeknight sleep is running short", body]);
  }

  // 2. ring charging gaps
  const missing = days.filter((x) => !hasNight(x) && x.d !== today).map((x) => x.d);
  if (missing.length >= 3) {
    const gaps = [];
    for (let i = 0; i < missing.length - 1; i++) {
      gaps.push(Math.round((Date.parse(missing[i + 1]) - Date.parse(missing[i])) / 86400000));
    }
    const med = median(gaps);
    if (med >= 3 && med <= 8) {
      const pretty = missing.map(lblShort).join(", ");
      out.push(["Habit", `A night of data disappears every ~${Math.round(med)} days`,
        `${missing.length} nights have no sleep data (${pretty}). The spacing matches the ring's 4-6 day battery, so it is charging overnight. Charging it during a shower or at your desk keeps every night in the record.`]);
    }
  }

  // 3. HRV trend
  const hrvs = slept.filter((x) => x.hrv).map((x) => x.hrv);
  if (hrvs.length >= 12) {
    const a = mean(hrvs.slice(-7)), b = mean(hrvs.slice(0, -7));
    const pct = (a - b) / b * 100;
    if (Math.abs(pct) >= 4) {
      const direction = pct > 0 ? "up" : "down";
      const body = `Your last 7 recorded nights average ${fmtF(a, 0)} ms vs ${fmtF(b, 0)} ms over the prior stretch (${fmtSigned(pct, 0)}%).`;
      out.push(["Trend", `Night HRV is trending ${direction}`, body]);
    }
  }

  // 4. bedtime consistency
  const beds = slept.filter((x) => x.bedRel != null).map((x) => [x.bedRel, x.score, x.bed]);
  if (beds.length >= 8) {
    const rels = beds.map((b) => b[0]);
    const spread = Math.max(...rels) - Math.min(...rels);
    const early = beds.filter(([r, s]) => r <= -0.5 && s).map((b) => b[1]);
    const late = beds.filter(([r, s]) => r > -0.5 && s).map((b) => b[1]);
    const earliest = beds.reduce((a, b) => (b[0] < a[0] ? b : a))[2];
    const latest = beds.reduce((a, b) => (b[0] > a[0] ? b : a))[2];
    if (spread >= 2) {
      let body = `Bedtimes ranged from ${earliest} to ${latest}, a ${fmtF(spread, 1)}-hour swing. `;
      if (early.length >= 3 && late.length >= 3 && mean(early) - mean(late) >= 2) {
        body += `On nights in bed before 23:30 your sleep score averaged ${fmtF(mean(early), 0)}; after 23:30 it averaged ${fmtF(mean(late), 0)}. `;
      }
      body += "A 22:30-23:15 bedtime most nights would narrow the swing.";
      out.push(["Sleep", `Bedtime swings by ${fmtF(spread, 1)} hours`, body]);
    }
  }

  // 5. RHR anomaly nights
  const rhrs = slept.filter((x) => x.rhr).map((x) => x.rhr);
  if (rhrs.length >= 10) {
    const mu = mean(rhrs), sd = pstdev(rhrs);
    const spikes = slept.filter((x) => x.rhr && x.rhr >= mu + Math.max(1.5 * sd, 3));
    if (spikes.length) {
      const s = spikes.reduce((a, b) => (b.rhr > a.rhr ? b : a));
      out.push(["Recovery", `${lblLong(s.d)} stood out`,
        `Resting HR was ${s.rhr} bpm against a usual ${fmtF(mu, 0)}, HRV ${s.hrv} ms, recovery ${s.rec}. This pattern usually follows alcohol, a late heavy meal, illness or stress. Check what that day held.`]);
    }
  }

  // 6. training (Liftoff)
  const trained = days.filter((x) => x.wsets);
  if (trained.length) {
    const weeks = Math.max(1, days.length / 7);
    const perWk = trained.length / weeks;
    const vol = trained.reduce((a, x) => a + (x.wvol || 0), 0);
    const prs = trained.reduce((a, x) => a + (x.wpr || 0), 0);
    let body = `${trained.length} lifting sessions in ${days.length} days (${fmtF(perWk, 1)}/week), ${fmtComma0(vol)} ${unit} of total volume`;
    body += prs ? ` and ${prs} PRs. ` : ". ";
    const wdCounts = {};
    for (const x of trained) wdCounts[x.wd] = (wdCounts[x.wd] || 0) + 1;
    const fav = Object.keys(wdCounts).sort((a, b) => wdCounts[b] - wdCounts[a]).slice(0, 2);
    body += `Most sessions are on ${fav.join(" and ")}. The ring credits little of a lifting session as active minutes, so the step count understates the day.`;
    out.push(["Training", `Lifting ${fmtF(perWk, 1)}x per week`, body]);

    const byDate = Object.fromEntries(days.map((x) => [x.d, x]));
    const afterTrain = [], afterRest = [];
    for (const x of days) {
      if (x.rec == null) continue;
      const p = byDate[addDays(x.d, -1)];
      if (!p) continue;
      (p.wsets ? afterTrain : afterRest).push(x.rec);
    }
    if (afterTrain.length >= 4 && afterRest.length >= 4) {
      const a = mean(afterTrain), b = mean(afterRest);
      if (a - b >= 3) {
        out.push(["Training", "Recovery is higher the morning after a session",
          `Mornings after a session average ${fmtF(a, 0)} recovery vs ${fmtF(b, 0)} after rest days. Lifting and the weekdays you lift on are confounded here.`]);
      } else if (b - a >= 3) {
        out.push(["Training", "Recovery is lower the morning after a session",
          `Mornings after a session average ${fmtF(a, 0)} recovery vs ${fmtF(b, 0)} after rest days. Session time, the post-workout meal and sleep on training days are the things to check. Lifting and the weekdays you lift on are confounded here.`]);
      }
    }
  }

  // 7. activity (steps)
  const steps = days.filter((x) => x.steps).map((x) => [x.d, x.steps]);
  if (steps.length) {
    const avgSteps = mean(steps.map((s) => s[1]));
    const [bigD, bigV] = steps.reduce((a, b) => (b[1] > a[1] ? b : a));
    const vo2 = [...days].reverse().find((x) => x.vo2)?.vo2 ?? null;
    const nice = lblLong(bigD);
    if (trained.length) {
      let body = `You averaged ${fmtComma0(avgSteps)} steps a day, with a peak of ${bigV.toLocaleString("en-US")} on ${nice}.`;
      // claim: vo2-endurance-response
      if (vo2) body += ` VO2 max is ${vo2}. Sustained cardio is what moves it.`;
      out.push(["Activity", `${fmtComma0(avgSteps)} steps a day`, body]);
    } else {
      let body = `You averaged ${fmtComma0(avgSteps)} steps a day, with a peak of ${bigV.toLocaleString("en-US")} on ${nice}. Active minutes are near zero most days: the ring only counts sustained elevated heart rate, and walking does not reach it.`;
      if (vo2) body += ` VO2 max is ${vo2}, read from sustained elevated heart rate; two or three such sessions a week would give the ring something to measure.`;
      out.push(["Activity", `${fmtComma0(avgSteps)} steps a day, no workouts`, body]);
    }
  }

  // 8. bodyweight trend
  const bws = days.filter((x) => x.wbody).map((x) => [x.d, x.wbody]);
  if (bws.length >= 4 && Math.max(...bws.map((b) => b[1])) - Math.min(...bws.map((b) => b[1])) > 0.5) {
    const first = bws[0][1], last = bws[bws.length - 1][1];
    const delta = last - first;
    const spanD = Math.round((Date.parse(bws[bws.length - 1][0]) - Date.parse(bws[0][0])) / 86400000) || 1;
    const direction = delta < -0.5 ? "down" : delta > 0.5 ? "up" : "flat";
    out.push(["Body", `Bodyweight is ${direction}: ${fmtF(first, 1)} to ${fmtF(last, 1)}`,
      `${bws.length} weigh-ins over ${spanD} days, net ${fmtSigned(delta, 1)}. That is ${fmtSigned(delta / spanD * 7, 2)} per week as logged in Liftoff.`]);
  }

  // 9. morning alertness
  const alerts = slept.filter((x) => x.alert != null).map((x) => x.alert);
  if (alerts.length && mean(alerts) >= 20) {
    out.push(["Note", "Mornings start groggy",
      `Sleep inertia averaged ${fmtF(mean(alerts), 0)} minutes. Consistent wake times, morning light and holding caffeine for the first 60-90 minutes all shorten it.`]);
  }

  // 10. SpO2 (beta sensor)
  const spo2 = slept.filter((x) => x.spo2).map((x) => x.spo2);
  if (spo2.length && median(spo2) < 92) {
    out.push(["Note", `Sleep SpO2 (beta) averaged ${fmtF(mean(spo2), 0)}%`,
      "The ring's SpO2 sensor is beta and reads low for many wearers, so treat this as noise unless you also snore heavily or wake unrested - in which case it is worth mentioning to a doctor."]);
  }

  return out.slice(0, 8);
}

// feather-style 24x24 stroke icons + accent colour per insight category
const ICONS = {
  Sleep: ["M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z", "--c-sleep"],
  Trend: ["M2 18 9 11l4 4 8-9M15 6h6v6", "--c-hrv"],
  Recovery: ["M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8L12 21.2l8.8-8.8a5.5 5.5 0 0 0 0-7.8z", "--c-rec"],
  Training: ["M6.5 6.5v11M17.5 6.5v11M3 9v6M21 9v6M6.5 12h11", "--c-lift"],
  Habit: ["M13 2 3 14h9l-1 8 10-12h-9l1-8z", "--c-steps"],
  Activity: ["M22 12h-4l-3 9L9 3l-3 9H2", "--c-bw"],
  Body: ["M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM5.5 21a6.5 6.5 0 0 1 13 0", "--c-restor"],
  Note: ["M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zM12 16v-4M12 8h.01", "--c-restor"],
};

export function insightCard(tag, title, body, featured) {
  const [path, accent] = ICONS[tag] || ICONS.Note;
  return `<div class="insight${featured ? " featured" : ""}" style="--accent:var(${accent})">` +
    `<div class="ihead"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg><span class="chip">${tag}</span></div>` +
    `<h3>${title}</h3><p>${body}</p></div>`;
}

export function insightsBlock(userId, insights) {
  const cards = insights.map(([tag, title, body], j) => insightCard(tag, title, body, j === 0)).join("\n");
  const more = insights.length > 4 ? `<button class="ghostbtn moreins">Show ${insights.length - 4} more</button>` : "";
  return `<div class="insightwrap" data-user="${userId}"><div class="insights collapsed">${cards}</div>${more}</div>`;
}
