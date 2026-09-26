// Data sources: the Ultrahuman Partner API, Liftoff's tRPC API (the calls the
// open-source liftoff-export-cli makes) and Hevy's public API (Hevy Pro).

export const ULTRAHUMAN_BASE = "https://partner.ultrahuman.com/api/v1/partner/daily_metrics";
export const LIFTOFF_DEFAULT_BASE = "https://v2-13-10.api.getgymbros.com";
const LIFTOFF_UA = "Liftoff/528 CFNetwork/3860.400.51 Darwin/25.3.0";

/** Pre-ring dates return metric shells; a real day has a series, a value, a score or a total. */
export function hasRealData(metrics) {
  for (const entries of Object.values(metrics || {})) {
    for (const m of entries || []) {
      const o = (m && m.object) || {};
      if (o.values && o.values.length) return true;
      if (o.value) return true;
      if (o.sleep_score && o.sleep_score.score != null) return true;
      if (o.total != null) return true;
    }
  }
  return false;
}

/** GET one day; the header is the raw token (no "Bearer"). Returns the parsed payload. */
export async function fetchUltrahumanDay(dateIso, token) {
  const r = await fetch(`${ULTRAHUMAN_BASE}?date=${dateIso}`, { headers: { Authorization: token.trim() } });
  if (!r.ok) throw new Error(`ultrahuman ${dateIso}: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

// ---------------------------------------------------------------- Liftoff
function trpcUrl(base, procedure, input) {
  const batch = input === undefined
    ? { 0: { json: null, meta: { values: ["undefined"] } } }
    : { 0: { json: input } };
  return `${base}/api/trpc/${procedure}?batch=1&input=${encodeURIComponent(JSON.stringify(batch))}`;
}

async function trpcGet(url, headers) {
  const r = await fetch(url, { headers: { Accept: "*/*", "Accept-Language": "en-US,en;q=0.9", "User-Agent": LIFTOFF_UA, ...headers } });
  const text = await r.text();
  if (text.toLowerCase().includes("server is deprecated")) {
    throw new Error("Liftoff retired this API version - set LIFTOFF_API_BASE to the host the current app uses");
  }
  if (!r.ok) throw new Error(`Liftoff HTTP ${r.status}: ${text.slice(0, 160)}`);
  const batch = JSON.parse(text);
  if (!batch.length) throw new Error("empty tRPC response");
  if (batch[0].error) throw new Error(`tRPC error: ${batch[0].error.json && batch[0].error.json.message}`);
  return batch[0].result.data.json;
}

/**
 * user.signIn with the Liftoff account's email (or username) and password, the
 * way the app does it. Returns {refreshToken, accessToken, expiresAt(ms)}; only
 * the refresh token is kept, the password is never stored.
 */
export async function liftoffSignIn(email, password, base = LIFTOFF_DEFAULT_BASE) {
  const r = await fetch(`${base}/api/trpc/user.signIn?batch=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "*/*", "User-Agent": LIFTOFF_UA },
    body: JSON.stringify({ 0: { json: { usernameOrEmail: email, password, provider: "gymbros" } } }),
  });
  const text = await r.text();
  if (text.toLowerCase().includes("server is deprecated")) {
    throw new Error("Liftoff retired this API version - set LIFTOFF_API_BASE to the host the current app uses");
  }
  let batch;
  try { batch = JSON.parse(text); } catch { throw new Error(`Liftoff HTTP ${r.status}`); }
  const first = batch && batch[0];
  if (!first || first.error) throw new Error((first && first.error && first.error.json && first.error.json.message) || `Liftoff HTTP ${r.status}`);
  const data = first.result.data.json;
  if (!data || !data.refreshToken) throw new Error("Liftoff did not return a refresh token");
  const exp = Date.parse(data.accessTokenExpiresAt) || (Date.now() + 3600_000);
  return { refreshToken: data.refreshToken, accessToken: data.accessToken, expiresAt: exp - 5 * 60_000 };
}

/** user.refreshToken -> {accessToken, expiresAt(ms)}; the refresh token itself does not rotate. */
export async function liftoffRefresh(refreshToken, base = LIFTOFF_DEFAULT_BASE) {
  const data = await trpcGet(trpcUrl(base, "user.refreshToken", refreshToken), {});
  const exp = Date.parse(data.accessTokenExpiresAt) || (Date.now() + 3600_000);
  return { accessToken: data.accessToken, expiresAt: exp - 5 * 60_000 };
}

/**
 * All of the user's own workout posts (post.getMyPosts). `state` is
 * {accessToken, expiresAt} cached from a previous run (may be null); returns
 * {posts, state} so the caller can persist the refreshed access token.
 */
export async function liftoffPosts(refreshToken, state, base = LIFTOFF_DEFAULT_BASE) {
  let st = state && state.accessToken && state.expiresAt > Date.now() ? state : await liftoffRefresh(refreshToken, base);
  try {
    const posts = await trpcGet(trpcUrl(base, "post.getMyPosts"), { Authorization: `Bearer ${st.accessToken}` });
    return { posts: posts || [], state: st };
  } catch (e) {
    if (!/HTTP 401|UNAUTHORIZED/i.test(String(e.message))) throw e;
    st = await liftoffRefresh(refreshToken, base);
    const posts = await trpcGet(trpcUrl(base, "post.getMyPosts"), { Authorization: `Bearer ${st.accessToken}` });
    return { posts: posts || [], state: st };
  }
}

// ---------------------------------------------------------------- Hevy
// https://api.hevyapp.com/docs - needs a Hevy Pro API key (hevy.com/settings?developer).
export const HEVY_BASE = "https://api.hevyapp.com/v1";
const KG_TO_LB = 2.20462;
const HEVY_MAX_PAGES = 300;          // 10 workouts a page
const HEVY_SET_TYPE = { normal: "normal", warmup: "warmup", failure: "failure", dropset: "drop" };

async function hevyGet(path, apiKey) {
  const r = await fetch(`${HEVY_BASE}${path}`, { headers: { "api-key": apiKey, Accept: "application/json" } });
  if (r.status === 401 || r.status === 403) throw new Error("Hevy rejected the API key (it needs Hevy Pro)");
  if (!r.ok) throw new Error(`Hevy HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

/** Every workout, newest first, as {id: workout}. */
async function hevyAll(apiKey) {
  const out = {};
  for (let page = 1; page <= HEVY_MAX_PAGES; page++) {
    const j = await hevyGet(`/workouts?page=${page}&pageSize=10`, apiKey);
    for (const w of j.workouts || []) out[w.id] = w;
    if (!j.page_count || page >= j.page_count) break;
  }
  return out;
}

/** Apply /workouts/events since `since` (ISO) to `byId`; returns false if the endpoint is unusable. */
async function hevyEvents(apiKey, since, byId) {
  for (let page = 1; page <= HEVY_MAX_PAGES; page++) {
    let j;
    try { j = await hevyGet(`/workouts/events?page=${page}&pageSize=10&since=${encodeURIComponent(since)}`, apiKey); }
    catch (e) { if (/HTTP 404/.test(e.message)) return false; throw e; }
    for (const ev of j.events || []) {
      if (ev.type === "deleted" && ev.id) delete byId[ev.id];
      else if (ev.workout && ev.workout.id) byId[ev.workout.id] = ev.workout;
    }
    if (!j.page_count || page >= j.page_count) break;
  }
  return true;
}

/**
 * Sync Hevy workouts. `state` is the stored {syncedAt, workouts: {id: w}} (or
 * null); the first run pages through everything, later runs apply the change
 * events since the last sync. Returns the new state.
 */
export async function hevySync(apiKey, state) {
  const started = new Date().toISOString();
  if (state && state.syncedAt && state.workouts) {
    const byId = { ...state.workouts };
    if (await hevyEvents(apiKey, state.syncedAt, byId)) return { syncedAt: started, workouts: byId };
  }
  return { syncedAt: started, workouts: await hevyAll(apiKey) };
}

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * Hevy workouts -> the Liftoff post shape summarize.js reads, so every analysis
 * works on either log. Loads become pounds (the page shows lb), RPE becomes
 * reps in reserve (10 - RPE), weight-and-reps sets are "WR", timed or distance
 * sets are "DD" (inputOne metres, inputTwo seconds). Liftoff-only counters
 * (streak, XP, rank-ups, its PR count) are absent, so those tiles stay hidden.
 */
export function hevyToPosts(workouts) {
  const posts = [];
  for (const w of Object.values(workouts || {})) {
    if (!w || !w.start_time) continue;
    const secs = w.end_time ? Math.max(0, Math.round((Date.parse(w.end_time) - Date.parse(w.start_time)) / 1000)) : 0;
    const exerciseData = [];
    for (const ex of w.exercises || []) {
      const sets = ex.sets || [];
      const lifting = sets.some((s) => s.reps != null || s.weight_kg != null);
      exerciseData.push({
        exerciseName: ex.title || "Unknown",
        exerciseTypes: lifting ? "WR" : "DD",
        setsData: sets.map((s) => {
          const out = { setType: HEVY_SET_TYPE[s.type] || "normal" };
          if (lifting) {
            out.inputOne = s.weight_kg != null ? round1(s.weight_kg * KG_TO_LB) : 0;
            out.inputTwo = s.reps != null ? s.reps : 0;
          } else {
            out.inputOne = s.distance_meters || 0;
            out.inputTwo = s.duration_seconds || 0;
          }
          if (s.rpe != null && !Number.isNaN(Number(s.rpe))) out.rir = Math.max(0, 10 - Number(s.rpe));
          return out;
        }),
      });
    }
    posts.push({ id: w.id, startedAt: w.start_time, sessionDuration: secs ? String(secs) : null, sessionPresetId: w.routine_id || null, exerciseData });
  }
  return posts.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
