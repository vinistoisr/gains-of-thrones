// The refresh job: fetch -> summarise -> brief -> narrative -> render -> R2.
// Runs inside the Worker (cron slots, POST /refresh) with R2 as the only state.
//
// Bucket layout (per person id from the settings, config.js):
//   data/<uid>/YYYY-MM-DD.json   raw Ultrahuman daily_metrics payload (kept for reprocessing)
//   data/<uid>/ring.json         {date: ringRec} - summaries of every raw day
//   data/<uid>/empty.json        {date: fetchedAtMs} - dates the API had no data for
//   data/<uid>/workouts.json     workout log as Liftoff posts (post.getMyPosts, or Hevy converted by hevyToPosts)
//   data/<uid>/liftoff-auth.json {accessToken, expiresAt} cached from the refresh token
//   data/<uid>/hevy.json         {syncedAt, workouts: {id: workout}} raw Hevy sync state
//   data/<uid>/screentime.json   optional {date: {pc, pcEve}} computer time, uploaded by an outside script
//   data/<uid>/narrative.json    {current, history: [...]} Workers AI weekly note
//   coach/<uid>.md               the coach snapshot (coach.js), served at GET /coach
//   state/plan.json              {weeks: [...]} the weekly plan and its hit-or-miss record (first person with a workout log)
//   dashboard.html, brief.json, status.json, refresh.flag
import { loadSettings, loadSecrets, credential, vapidKeys } from "../config.js";
import { ringRec, loadWorkouts, mergeDays } from "./summarize.js";
import { computeBrief, evaluatePlan } from "./brief.js";
import { renderPage } from "./render.js";
import { coachMarkdown } from "./coach.js";
import { fetchUltrahumanDay, hasRealData, liftoffPosts, LIFTOFF_DEFAULT_BASE, hevySync, hevyToPosts } from "./sources.js";
import { weeklyFacts, writeNarrative, narrativeDue } from "./ai.js";
import { todayLocal, localStamp, addDays, daysBetween, mondayOf, setTimeZone } from "./util.js";

const LOOKBACK = 35;
const PLAN_KEEP = 26;   // weeks kept in state/plan.json

// the first person with a workout log owns state/plan.json; any further one gets state/plan-<uid>.json
export const planKey = (people, uid) => (people.find((x) => x.workouts) || {}).id === uid ? "state/plan.json" : `state/plan-${uid}.json`;

/**
 * The weekly plan store for one user. On the first refresh of a new ISO week
 * every unscored earlier week is scored from the set log (evaluatePlan) and the
 * week's new plan, built by computeBrief, is appended; otherwise the stored
 * plan stands and only its sentence is recomputed. Returns the brief.
 */
async function briefWithPlan(env, u, days, today, people) {
  if (!u.workouts) return computeBrief(days, today);
  const key = planKey(people, u.id);
  const store = (await getJSON(env, key)) || { weeks: [] };
  if (!Array.isArray(store.weeks)) store.weeks = [];
  const weekStart = mondayOf(today);
  let changed = false;
  for (const w of store.weeks) {
    if (w.result || w.weekStart >= weekStart) continue;
    Object.assign(w, evaluatePlan(w, days));
    changed = true;
  }
  const brief = computeBrief(days, today, store);
  const plan = brief.training && brief.training.plan;
  if (plan && !store.weeks.some((w) => w.weekStart === plan.weekStart)) {
    const { sentence, state, done, ...fixed } = plan;
    store.weeks.push(fixed);
    store.weeks = store.weeks.slice(-PLAN_KEEP);
    changed = true;
  }
  if (changed) await putJSON(env, key, store);
  return brief;
}

async function getJSON(env, key) {
  const o = await env.BUCKET.get(key);
  if (!o) return null;
  try { return await o.json(); } catch { return null; }
}
const putJSON = (env, key, obj) => env.BUCKET.put(key, JSON.stringify(obj), { httpMetadata: { contentType: "application/json" } });

async function setStatus(env, patch) {
  const s = (await getJSON(env, "status.json")) || { last: 0, running: false };
  await putJSON(env, "status.json", { ...s, ...patch });
}

/** Recompute ring.json for one user from every raw day file in the bucket. */
async function rebuildRing(env, uid, log) {
  const ring = {};
  let cursor, n = 0;
  do {
    const page = await env.BUCKET.list({ prefix: `data/${uid}/`, cursor });
    for (const o of page.objects) {
      if (!/\/\d{4}-\d{2}-\d{2}\.json$/.test(o.key)) continue;
      const raw = await getJSON(env, o.key);
      const rec = raw && ringRec(raw);
      if (rec) { ring[rec.d] = rec; n++; }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  log(`${uid}: rebuilt ring.json from ${n} raw days`);
  return ring;
}

async function refreshUser(env, u, secrets, today, full, log) {
  const uid = u.id;
  const out = { uid, fetched: 0, workouts: null, warnings: [] };

  // ---- ring
  let ring = full ? await rebuildRing(env, uid, log) : (await getJSON(env, `data/${uid}/ring.json`)) || {};
  if (!full && !Object.keys(ring).length) ring = await rebuildRing(env, uid, log);   // first run bootstrap
  const empty = (await getJSON(env, `data/${uid}/empty.json`)) || {};
  const token = credential(env, secrets, uid, "ultrahuman");
  if (token) {
    const wanted = [];
    for (let i = 0; i < LOOKBACK; i++) {
      const d = addDays(today, -i);
      if (i <= 1) { wanted.push(d); continue; }                    // the two latest days can still change
      if (ring[d]) continue;
      if (empty[d] && daysBetween(d, today) > 3) continue;          // gave up on that date
      wanted.push(d);
    }
    for (const d of wanted) {
      try {
        const raw = await fetchUltrahumanDay(d, token);
        const metrics = (raw.data && raw.data.metrics) || {};
        if (!hasRealData(metrics)) { empty[d] = Date.now(); continue; }
        const rec = ringRec(raw);
        if (!rec) { empty[d] = Date.now(); continue; }
        await env.BUCKET.put(`data/${uid}/${d}.json`, JSON.stringify(raw), { httpMetadata: { contentType: "application/json" } });
        ring[rec.d] = rec;
        delete empty[rec.d];
        out.fetched++;
      } catch (e) {
        out.warnings.push(`ultrahuman ${d}: ${e.message}`);
      }
    }
    await putJSON(env, `data/${uid}/ring.json`, ring);
    await putJSON(env, `data/${uid}/empty.json`, empty);
  } else {
    out.warnings.push("No Ultrahuman token yet.");
  }

  // ---- workout log: Liftoff or Hevy, stored as Liftoff-shaped posts either way
  let posts = null;
  const refreshToken = u.workouts === "liftoff" ? credential(env, secrets, uid, "liftoff") : null;
  const hevyKey = u.workouts === "hevy" ? credential(env, secrets, uid, "hevy") : null;
  if (refreshToken) {
    try {
      const state = await getJSON(env, `data/${uid}/liftoff-auth.json`);
      const r = await liftoffPosts(refreshToken, state, (env.LIFTOFF_API_BASE || LIFTOFF_DEFAULT_BASE).replace(/\/$/, ""));
      posts = r.posts;
      await putJSON(env, `data/${uid}/workouts.json`, posts);
      if (r.state !== state) await putJSON(env, `data/${uid}/liftoff-auth.json`, r.state);
      out.workouts = posts.length;
    } catch (e) {
      out.warnings.push(`liftoff: ${e.message}`);
    }
  } else if (hevyKey) {
    try {
      const state = await getJSON(env, `data/${uid}/hevy.json`);
      const next = await hevySync(hevyKey, state);
      await putJSON(env, `data/${uid}/hevy.json`, next);
      posts = hevyToPosts(next.workouts);
      await putJSON(env, `data/${uid}/workouts.json`, posts);
      out.workouts = posts.length;
    } catch (e) {
      out.warnings.push(`hevy: ${e.message}`);
    }
  } else if (u.workouts) {
    out.warnings.push(`No ${u.workouts === "hevy" ? "Hevy API key" : "Liftoff sign-in"} yet.`);
  }
  if (posts === null) posts = (await getJSON(env, `data/${uid}/workouts.json`)) || [];

  const screentime = (await getJSON(env, `data/${uid}/screentime.json`)) || {};
  const days = mergeDays(ring, loadWorkouts(posts), screentime);
  out.days = days.length;
  return { ...out, days_list: days };
}

/**
 * Run the whole refresh. opts: {reason, full (rebuild ring.json from raw files),
 * narrative ("auto" | "force" | "skip")}. Returns a summary for logs.
 */
export async function runRefresh(env, opts = {}) {
  const t0 = Date.now();
  const settings = await loadSettings(env);
  setTimeZone(settings.tz);
  const today = todayLocal();
  const users = settings.people;
  const logLines = [];
  const log = (m) => logLines.push(m);
  await setStatus(env, { running: true, startedAt: t0 / 1000, reason: opts.reason || "" });
  const summary = { reason: opts.reason || "", today, users: {} };
  try {
    if (!users.length) throw new Error("No people set up yet. Add one on the settings page.");
    const secrets = await loadSecrets(env);
    const datasets = {}, briefs = {}, narratives = {};
    for (const u of users) {
      const r = await refreshUser(env, u, secrets, today, !!opts.full, log);
      const days = r.days_list; delete r.days_list;
      summary.users[u.id] = r;
      if (!days.length) continue;
      datasets[u.id] = days;
      // a throw here must reach the page, not only state/last-refresh.json: the
      // Today card shows a banner when its brief carries an error
      try { briefs[u.id] = await briefWithPlan(env, u, days, today, users); }
      catch (e) { r.warnings.push(`brief: ${e.message}`); briefs[u.id] = { error: `brief: ${e.message}` }; }

      // weekly narrative (Workers AI)
      const key = `data/${u.id}/narrative.json`;
      const store = (await getJSON(env, key)) || { current: null, history: [] };
      const mode = opts.narrative || "auto";
      if (env.AI && mode !== "skip" && (mode === "force" || narrativeDue(store.current, today))) {
        try {
          const facts = weeklyFacts(days, briefs[u.id], today);
          const prev = [store.current, ...store.history].filter(Boolean).map((n) => ({ week_ending: n.week_ending, headline: n.headline }));
          const n = await writeNarrative(env, facts, prev);
          if (store.current) store.history = [store.current, ...store.history].slice(0, 12);
          store.current = n;
          await putJSON(env, key, store);
          r.narrative = "written";
        } catch (e) { r.warnings.push(`narrative: ${e.message}`); }
      }
      if (store.current) narratives[u.id] = store.current;

      // the coach snapshot, a plain-text summary for an outside agent (README "Coach snapshot")
      try {
        const md = coachMarkdown({ user: u, days, brief: briefs[u.id], narrative: narratives[u.id] || null, today, origin: settings.origin });
        await env.BUCKET.put(`coach/${u.id}.md`, md, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
      } catch (e) { r.warnings.push(`coach: ${e.message}`); }
    }
    if (!Object.keys(datasets).length) {
      const why = Object.values(summary.users).flatMap((r) => r.warnings).slice(0, 3).join("; ");
      throw new Error(`No data yet${why ? `: ${why}` : ""}`);
    }
    const { publicKey } = await vapidKeys(env);
    const { html } = renderPage({ users, datasets, briefs, narratives, today, vapidPublic: publicKey });
    await env.BUCKET.put("dashboard.html", html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    await putJSON(env, "brief.json", { generated: localStamp(), users: briefs });
    summary.htmlKB = Math.round(html.length / 1024);
    summary.ok = true;
  } catch (e) {
    summary.ok = false; summary.error = String(e && e.stack || e);
  } finally {
    await setStatus(env, { running: false, last: Date.now() / 1000, ok: summary.ok, ms: Date.now() - t0 });
    await env.BUCKET.delete("refresh.flag");
  }
  summary.ms = Date.now() - t0;
  summary.log = logLines;
  await putJSON(env, "state/last-refresh.json", summary);
  return summary;
}
