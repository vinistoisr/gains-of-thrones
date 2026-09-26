import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAIMS } from "../src/pipeline/claims.js";
import { writeNarrative } from "../src/pipeline/ai.js";

const SRC = join(import.meta.dirname, "..", "src");

const BANNED = ["18%", "4.6 score", "protein synthesis", "easing training"];

test("CLAIMS: each allowed claim carries id, text, source, n, protocol", () => {
  assert.ok(Array.isArray(CLAIMS) && CLAIMS.length >= 3, `got ${CLAIMS.length}`);
  const ids = new Set();
  for (const c of CLAIMS) {
    for (const k of ["id", "text", "source", "n", "protocol"]) assert.ok(k in c, `${c.id}: ${k}`);
    for (const k of ["id", "text", "source", "protocol"]) assert.ok(typeof c[k] === "string" && c[k].length > 0, `${c.id}: ${k}`);
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.ok(!/—/.test(c.text + c.source + c.protocol), `${c.id}: em dash`);
  }
  for (const id of ["sets-growth-range", "sets-maintenance-dose", "cardio-no-interference", "vo2-endurance-response", "e1rm-strength-signal", "sleep-7h-floor"]) assert.ok(ids.has(id), id);
});

// copy that states physiology carries a "// claim: <id>[, <id>]" comment on the line above it;
// every id named that way has to be on the list, so a claim cannot ship unsourced
test("CLAIMS: every claim id referenced by a code comment exists", () => {
  const ids = new Set(CLAIMS.map((c) => c.id));
  const files = [join(SRC, "template.html"), ...readdirSync(join(SRC, "pipeline")).map((f) => join(SRC, "pipeline", f))];
  const seen = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\/\/ claim: ([\w-]+(?:, [\w-]+)*)/g)) {
      for (const id of m[1].split(", ")) {
        seen.push(id);
        assert.ok(ids.has(id), `${f}: unknown claim id "${id}"`);
      }
    }
  }
  // the three copy locations this guards: VO2 chart note, muscle legend, steps insight, untrained action
  for (const id of ["cardio-no-interference", "sets-growth-range", "sets-maintenance-dose", "vo2-endurance-response", "e1rm-strength-signal", "sleep-7h-floor", "rep-dropoff-effort"]) assert.ok(seen.includes(id), `no code comment references ${id}`);
  // the growth-range claim carries the tiered wording the page and the brief use
  const growth = CLAIMS.find((c) => c.id === "sets-growth-range");
  assert.match(growth.text, /4 to 10 give most of the return per set/);
  assert.ok(!/10 to 20/.test(growth.text), growth.text);
});

test("writeNarrative: the system prompt lists the allowed claims and nothing else physiological", async () => {
  let seen = null;
  // every number in the reply is checked against the facts sheet, so the sheet carries the ones the reply uses
  const reply = {
    headline: "Sleep fell to 6.4 h while chest hit 16 sets",
    body: Array.from({ length: 100 }, () => "word").join(" "),
    focus: "Be in bed by 22:45 on the four weeknights and add 8 sets of quads.",
  };
  const facts = { week_ending: "2026-06-30", sleep_h: 6.4, chest_sets: 16, quad_sets: 8 };
  const env = { AI: { run: async (_model, opts) => { seen = opts.messages; return { response: reply }; } } };
  const n = await writeNarrative(env, facts, []);
  assert.equal(n.quality, "ok");
  assert.equal(seen[0].role, "system");
  const sys = seen[0].content;
  assert.ok(sys.includes("Only make physiological claims from this list:"));
  for (const c of CLAIMS) assert.ok(sys.includes(c.text), c.id);
  for (const s of BANNED) assert.ok(!sys.includes(s), `found "${s}"`);
});
