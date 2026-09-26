// The push log: state/push-log.json in R2, {uid: [entry, ...]}.
//   send entry    {ts, kind, tag, nid}    kind morning | evening | test; nid is the
//                                         notification id (date-kind), shared by
//                                         every device a person has subscribed
//   opened entry  {ts, tag, opened: true} appended by POST /push/opened from sw.js
// The Worker sends a person at most PUSH_CAP notifications in any CAP_DAYS days;
// test sends (the "Send test" button) are logged but never counted. Entries older
// than KEEP_DAYS are dropped on every write.
export const PUSH_CAP = 4;
export const CAP_DAYS = 7;
export const KEEP_DAYS = 30;
const DAY = 86400000;

/** Entries for one person, oldest first, without anything older than KEEP_DAYS. */
function fresh(list, now) {
  return (Array.isArray(list) ? list : []).filter((e) => e && typeof e.ts === "number" && now - e.ts < KEEP_DAYS * DAY);
}

/** True when a cron send to `uid` is still under the rolling cap at `now`. */
export function maySend(log, uid, now = Date.now(), cap = PUSH_CAP, days = CAP_DAYS) {
  const nids = new Set();
  for (const e of fresh(log && log[uid], now)) {
    if (e.opened || e.kind === "test" || now - e.ts >= days * DAY) continue;
    nids.add(e.nid || `${e.ts}-${e.kind}`);
  }
  return nids.size < cap;
}

/** Returns a new log with `entry` appended to `uid`, trimmed to KEEP_DAYS. */
export function recordSend(log, uid, entry, now = Date.now()) {
  const out = trimLog(log, now);
  out[uid] = [...(out[uid] || []), { ts: now, ...entry }];
  return out;
}

/** Returns a new log with {ts, tag, opened: true} appended to `uid`. */
export function recordOpened(log, uid, tag, now = Date.now()) {
  return recordSend(log, uid, { tag: String(tag || "").slice(0, 40), opened: true }, now);
}

/** Returns a copy of the log without entries older than KEEP_DAYS or users left empty. */
export function trimLog(log, now = Date.now()) {
  const out = {};
  for (const [uid, list] of Object.entries(log && typeof log === "object" ? log : {})) {
    const keep = fresh(list, now);
    if (keep.length) out[uid] = keep;
  }
  return out;
}
