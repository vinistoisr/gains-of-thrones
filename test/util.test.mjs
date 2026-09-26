import { test } from "node:test";
import assert from "node:assert/strict";
import { localStamp, todayLocal } from "../src/pipeline/util.js";

test("localStamp: brief.generated is stamped in Pacific time, not UTC", () => {
  // 18:20 Pacific on Sep 7 is already Sep 8 in UTC; the stale check in
  // worker.js compares the date prefix with a Pacific date, so the stamp must
  // say Sep 7 or "no refresh today" could never fire the next morning
  const ms = Date.parse("2026-09-08T01:20:00Z");
  const s = localStamp(ms);
  assert.equal(s, "2026-09-07T18:20:00");
  assert.equal(s.slice(0, 10), "2026-09-07");
  assert.equal(s.slice(0, 10), todayLocal(ms), "same date the pipeline uses for today");
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, "same shape as the old ISO slice");
});

test("localStamp: standard time (PST) and midnight edges", () => {
  assert.equal(localStamp(Date.parse("2026-12-08T01:20:00Z")), "2026-12-07T17:20:00");   // UTC-8
  assert.equal(localStamp(Date.parse("2026-09-07T07:00:00Z")), "2026-09-07T00:00:00");   // local midnight, not 24:00
  assert.equal(localStamp(Date.parse("2026-09-07T06:59:59Z")), "2026-09-06T23:59:59");
});
