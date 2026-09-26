import { test } from "node:test";
import assert from "node:assert/strict";
import { maySend, recordSend, recordOpened, trimLog, PUSH_CAP, CAP_DAYS, KEEP_DAYS } from "../src/pipeline/pushlog.js";

const DAY = 86400000;
const now = Date.parse("2026-09-07T14:00:00Z");
const send = (daysAgo, kind = "morning", nid) => ({ ts: now - daysAgo * DAY, kind, tag: kind, nid: nid || `${daysAgo}-${kind}` });

test("maySend: under the cap with an empty or missing log", () => {
  assert.equal(maySend({}, "alex", now), true);
  assert.equal(maySend(null, "alex", now), true);
  assert.equal(maySend({ sam: [send(1)] }, "alex", now), true);
});

test("maySend: the fifth notification in 7 days is refused, the first after the window rolls is allowed", () => {
  assert.equal(PUSH_CAP, 4);
  const log = { alex: [send(1), send(2), send(3, "evening"), send(5)] };
  assert.equal(maySend(log, "alex", now), false);
  assert.equal(maySend(log, "alex", now + (CAP_DAYS - 5) * DAY + 1), true);   // the 5-day-old send has aged out
});

test("maySend: two devices sharing one notification id count once", () => {
  const log = { alex: [send(1, "morning", "a"), send(1, "morning", "a"), send(2, "morning", "b"), send(3, "morning", "c")] };
  assert.equal(maySend(log, "alex", now), true);
  log.alex.push(send(4, "evening", "d"));
  assert.equal(maySend(log, "alex", now), false);
});

test("maySend: opened entries and test sends do not count", () => {
  const log = { alex: [send(1), send(2), send(3), { ts: now - DAY, tag: "morning-lift", opened: true }, { ts: now - DAY, kind: "test", tag: "test" }] };
  assert.equal(maySend(log, "alex", now), true);
});

test("recordSend / recordOpened: append, stamp ts, trim past 30 days, never mutate the input", () => {
  const stale = send(KEEP_DAYS + 1);
  const log = { alex: [stale, send(2)], sam: [stale] };
  const out = recordSend(log, "alex", { kind: "morning", tag: "morning-lift", nid: "2026-09-07-morning" }, now);
  assert.equal(log.alex.length, 2, "input untouched");
  assert.equal(out.alex.length, 2, "stale entry dropped, new one added");
  assert.deepEqual(out.alex[1], { ts: now, kind: "morning", tag: "morning-lift", nid: "2026-09-07-morning" });
  assert.ok(!("sam" in out), "a user left with nothing is dropped");
  const opened = recordOpened(out, "alex", "morning-lift", now + 60000);
  assert.deepEqual(opened.alex[2], { ts: now + 60000, tag: "morning-lift", opened: true });
  assert.deepEqual(trimLog({ alex: [stale], x: "junk" }, now), {});
});
