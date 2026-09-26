// Render the page locally, the same way the Worker does at the end of a refresh.
//   npm run render        (= node --import ./test/register.mjs dev.mjs)
// Inputs, per person in .dev-data/users.json (a list like the settings'
// people, [{id, name, workouts}]): .dev-data/<uid>/{ring,workouts,screentime,
// narrative}.json pulled from the R2 bucket (gitignored), plus the optional
// .dev-data/state/plan.json (the weekly plan record; without it the page shows
// the week's sentence only, as on a fresh deploy). Without any .dev-data
// folder it renders test/fixture.json instead, so the command works on a fresh
// clone. Writes out.html, out-brief.json and out-coach-<uid>.md next to this file (all gitignored).
// `today` is the latest date in ring.json, so the brief is the same on every run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorkouts, mergeDays } from "./src/pipeline/summarize.js";
import { computeBrief } from "./src/pipeline/brief.js";
import { renderPage } from "./src/pipeline/render.js";
import { coachMarkdown } from "./src/pipeline/coach.js";

const here = import.meta.dirname;
const readJSON = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) : fallback);
const users = readJSON(join(here, ".dev-data", "users.json"), [{ id: "demo", name: "Demo", workouts: "liftoff" }])
  .map((u) => ({ ...u, workouts: u.workouts || (u.liftoff ? "liftoff" : null) }));

const inputs = {};   // uid -> {ring, workouts, screentime, narrative}
for (const u of users) {
  const dir = join(here, ".dev-data", u.id);
  if (!existsSync(join(dir, "ring.json"))) continue;
  inputs[u.id] = {
    ring: readJSON(join(dir, "ring.json"), {}),
    workouts: readJSON(join(dir, "workouts.json"), []),
    screentime: readJSON(join(dir, "screentime.json"), {}),
    narrative: readJSON(join(dir, "narrative.json"), null),
  };
}
let source = ".dev-data";
if (!Object.keys(inputs).length) {
  const fx = readJSON(join(here, "test", "fixture.json"));
  inputs[users[0].id] = { ring: fx.ring, workouts: fx.workouts, screentime: fx.screentime, narrative: null };
  source = "test/fixture.json (no .dev-data folder)";
}

const today = Object.values(inputs).flatMap((x) => Object.keys(x.ring)).sort().pop();
const planStore = readJSON(join(here, ".dev-data", "state", "plan.json"), null);
const datasets = {}, briefs = {}, narratives = {};
for (const [uid, x] of Object.entries(inputs)) {
  const days = mergeDays(x.ring, loadWorkouts(x.workouts), x.screentime);
  if (!days.length) continue;
  datasets[uid] = days;
  briefs[uid] = computeBrief(days, today, uid === users.find((u) => u.workouts)?.id ? planStore : null);
  if (x.narrative && x.narrative.current) narratives[uid] = x.narrative.current;
}
const { html } = renderPage({ users, datasets, briefs, narratives, today, vapidPublic: "" });
const outHtml = join(here, "out.html"), outBrief = join(here, "out-brief.json");
writeFileSync(outHtml, html);
writeFileSync(outBrief, JSON.stringify({ generated: today, users: briefs }, null, 2));
// the coach snapshot for each rendered user, the file the Worker writes to coach/<uid>.md
for (const u of users) {
  if (!datasets[u.id]) continue;
  const md = coachMarkdown({ user: u, days: datasets[u.id], brief: briefs[u.id], narrative: narratives[u.id] || null, today });
  writeFileSync(join(here, `out-coach-${u.id}.md`), md);
  console.log(`wrote out-coach-${u.id}.md (${md.length} chars)`);
}
console.log(`source: ${source}`);
console.log(`today: ${today}`);
console.log(`wrote ${outHtml} (${Math.round(Buffer.byteLength(html) / 1024)} KB) and ${outBrief}`);
for (const [uid, days] of Object.entries(datasets)) console.log(`${uid}: ${days.length} days`);
for (const [uid, b] of Object.entries(briefs)) for (const a of (b.actions || []).slice(0, 2)) console.log(`${uid} action [${a.tag}] ${a.text}`);
for (const [uid, b] of Object.entries(briefs)) if (b.training && b.training.plan) console.log(`${uid} plan: ${b.training.plan.sentence}`);
