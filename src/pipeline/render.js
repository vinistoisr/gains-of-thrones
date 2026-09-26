// Fill the HTML template with data, insights, brief and narrative.
import template from "../template.html";
import { buildInsights, insightsBlock } from "./insights.js";
import { localParts } from "./util.js";
import { LIFT_FN_JS } from "./lift.js";
import { STATS_FN_JS } from "./stats.js";

export const USER_PALETTE = [["#2a78d6", "#3987e5"], ["#e87ba4", "#d55181"], ["#1baf7a", "#199e70"], ["#eda100", "#c98500"]];

/**
 * users: the people from the settings, in order; datasets: {uid: days}; briefs: {uid: brief};
 * narratives: {uid: narrative}; today: YYYY-MM-DD; vapidPublic: the Web Push
 * public key (config.js vapidKeys); now: epoch ms.
 */
export function renderPage({ users, datasets, briefs, narratives, today, vapidPublic = "", now = Date.now() }) {
  const meta = [], blocks = [], pending = [];
  let anyLift = false;
  const embedded = {};
  users.forEach((u, i) => {
    const days = datasets[u.id];
    if (!days || !days.length) { pending.push({ id: u.id, name: u.name }); return; }
    const insights = buildInsights(days.slice(-35), today);
    blocks.push(insightsBlock(u.id, insights));
    // the hypnogram is only rendered for the latest scored night - strip the rest
    const lastScored = [...days].reverse().find((d) => d.score != null)?.d;
    embedded[u.id] = days.map((d) => (d.d === lastScored || !d.hyp ? d : (({ hyp, ...rest }) => rest)(d)));
    anyLift = anyLift || days.some((d) => "trained" in d);
    const [light, dark] = USER_PALETTE[i % USER_PALETTE.length];
    meta.push({ id: u.id, name: u.name, c: light, cd: dark });
  });
  if (!meta.length) throw new Error("no user data to render");
  const p = localParts(now);
  const ndays = Math.max(...Object.values(embedded).map((v) => v.length));
  const rep = (s, k, v) => s.split(k).join(v);   // no regex, no $ patterns
  let html = template;
  html = rep(html, "__DATA__", JSON.stringify(embedded));
  html = rep(html, "__USERS__", JSON.stringify(meta));
  html = rep(html, "__PENDING__", JSON.stringify(pending));
  html = rep(html, "__BRIEF__", JSON.stringify(briefs || {}));
  html = rep(html, "__TODAY__", today);
  html = rep(html, "__NARRATIVE__", JSON.stringify(narratives || {}));
  html = rep(html, "__VAPID__", vapidPublic);
  html = rep(html, "__LIFTFN__", LIFT_FN_JS);
  html = rep(html, "__STATSFN__", STATS_FN_JS);
  html = rep(html, "__INSIGHTS__", blocks.join("\n"));
  html = rep(html, "__USERCSS_L__", meta.map((m) => `--u-${m.id}:${m.c};`).join(""));
  html = rep(html, "__USERCSS_D__", meta.map((m) => `--u-${m.id}:${m.cd};`).join(""));
  const logs = [...new Set(users.filter((u) => datasets[u.id] && u.workouts).map((u) => (u.workouts === "hevy" ? "Hevy" : "Liftoff")))];
  html = rep(html, "__SOURCES__", anyLift && logs.length ? `Ultrahuman Ring + ${logs.join(" + ")}` : "Ultrahuman Ring");
  html = rep(html, "__NDAYS__", String(ndays));
  html = rep(html, "__BUILDTS__", String(Math.floor(now / 1000)));
  html = rep(html, "__GENERATED__", `${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`);
  return { html, meta, pending };
}
