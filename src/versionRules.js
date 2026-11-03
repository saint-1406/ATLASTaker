// Which earlier versions of a note are kept: the same rules on the computer (server/store.js) and in
// the phone's or browser's storage (bridge.js). A version is the note's whole text at one moment; one
// is taken while the note is being written, at most every few minutes, and before a version is put back.

export const VERSION_EVERY = 10 * 60 * 1000; // a new version after this long of writing
export const MAX_VERSIONS = 60;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/**
 * The versions to keep, newest first: every one of the last day, the newest of each hour of the last
 * week, the newest of each day before that; MAX_VERSIONS at most.
 */
export function versionsToKeep(times, now = Date.now()) {
  const keep = [];
  const seen = new Set();
  for (const at of [...times].sort((a, b) => b - a)) {
    const age = now - at;
    const bucket = age < DAY ? `v${at}` : age < 7 * DAY ? `h${Math.floor(at / HOUR)}` : `d${Math.floor(at / DAY)}`;
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    keep.push(at);
    if (keep.length >= MAX_VERSIONS) break;
  }
  return keep;
}
