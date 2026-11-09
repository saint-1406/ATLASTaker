// How two devices' notes and library cards come together. Pure functions, no I/O: the engine
// (engine.js) feeds them what this device has, what Google Drive has and what both had after the last
// sync (the "base"), and does what they decide. One rule above all: nothing is lost. A note changed
// on both sides keeps both versions; a deletion wins only over a copy nobody touched since.

/** A short fingerprint of a string (cyrb53): enough to tell "changed" from "the same". */
export function fingerprint(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + text.length.toString(36);
}

/** JSON with keys in a fixed order, so the same value always gives the same fingerprint. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export const sig = (value) => fingerprint(stableJson(value));

// ---------- notes ----------

/**
 * Decides what happens to each note.
 *   local:  { id: { hash, updated } }                — notes on this device
 *   remote: { id: { hash, updated } | { deleted } }   — the index on Drive
 *   base:   { id: hash }                              — what both had after the last sync
 * Returns a list of steps:
 *   { op: 'same', id, hash }        nothing to move, remember the hash
 *   { op: 'pull', id }              Drive's version replaces (or creates) the local one
 *   { op: 'push', id }              the local version goes to Drive
 *   { op: 'trash', id }             deleted elsewhere and untouched here: to the local trash
 *   { op: 'delete', id }            deleted here and untouched elsewhere: a tombstone on Drive
 *   { op: 'conflict', id, keep }    changed on both sides: `keep` ('local'/'remote') stays under the
 *                                   id (the newer one); the other becomes a note of its own
 *   { op: 'forget', id }            gone everywhere: drop it from the base
 */
export function planNotes(local, remote, base) {
  const ids = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)]);
  const steps = [];
  for (const id of [...ids].sort()) {
    const l = local[id];
    const r = remote[id];
    const b = base[id];
    const rLive = r && !r.deleted;
    if (l && rLive) {
      if (l.hash === r.hash) steps.push({ op: 'same', id, hash: l.hash });
      else if (l.hash === b) steps.push({ op: 'pull', id });
      else if (r.hash === b) steps.push({ op: 'push', id });
      else steps.push({ op: 'conflict', id, keep: (l.updated ?? 0) >= (r.updated ?? 0) ? 'local' : 'remote' });
    } else if (l) {
      // Drive has a tombstone or nothing at all
      if (r?.deleted && l.hash === b) steps.push({ op: 'trash', id });
      else steps.push({ op: 'push', id });
    } else if (rLive) {
      if (b !== undefined && r.hash === b) steps.push({ op: 'delete', id });
      else steps.push({ op: 'pull', id });
    } else if (b !== undefined) {
      steps.push({ op: 'forget', id });
    }
  }
  return steps;
}

/**
 * One small value of a note (its folder, when it went to the trash) from this device, Drive and the
 * last sync: the side that changed it wins; changed on both, this device's. Such values travel apart
 * from the text, so moving a note or putting it in the trash never makes a conflict copy of it.
 */
export function mergeField(local, remote, base, none) {
  const l = local ?? none;
  const r = remote ?? none;
  const b = base ?? none;
  if (l === r || r === b) return l;
  if (l === b) return r;
  return l;
}

/** A note's folder ('' for none). */
export const mergeFolder = (local, remote, base) => mergeField(local, remote, base, '');

/** When a note went to the trash (0: it is not there). */
export const mergeTrashed = (local, remote, base) => mergeField(local || 0, remote || 0, base || 0, 0);

// ---------- settings ----------

/**
 * Settings that travel between devices; each side keeps, per setting, when the person last set it.
 * The newer one wins; a setting never set on purpose here (a fresh install's default) gives way to
 * Drive's. Reading days add up: of each day, the longer time counts.
 */
export const SETTING_KEYS = [
  'skin',
  'theme',
  'accent',
  'lang',
  'sidebar',
  'fontScale',
  'readMode',
  'readTurn',
  'readFont',
  'readLeading',
  'readLook',
  'avatar',
  'profileName',
  'noteFolders',
  'shelves',
  'readDays',
  'readGoal',
  // writing (0.17): the statistics strip, the formatting bar and its tools, what focus dims, and the
  // writing logs (written per day and the text's growth per day, src/writing.js). The PIN is not here:
  // it locks one device.
  'statsBar',
  'formatBar',
  'formatTools',
  'focusDim',
  'markup',
  'editorMode',
  'writeDays',
  'growDays',
];
const MAX_DAYS = 60;
const WRITING_DAYS = 400;

/** Two devices' writing logs of one kind: of each day the larger amount (one device's day is not doubled). */
export function mergeWriting(a, b) {
  const out = { ...(a ?? {}) };
  for (const [day, value] of Object.entries(b ?? {})) if (Math.abs(value) > Math.abs(out[day] ?? 0)) out[day] = value;
  const days = Object.keys(out).sort().slice(-WRITING_DAYS);
  return Object.fromEntries(days.map((day) => [day, out[day]]));
}

/**
 * The times kept with a change to the app's state (state.settingsAt): each setting whose value really
 * changes gets `now`, unless the change is `quiet` — a default or a one-time move, not the person's choice.
 */
export function stampSettings(state, patch, { now = Date.now(), quiet = false } = {}) {
  const at = { ...(state?.settingsAt ?? {}) };
  if (quiet) return at;
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (SETTING_KEYS.includes(key) && sig(value) !== sig(state?.[key])) at[key] = now;
  }
  return at;
}

/** A state's settings as sync sees them: { values, at }. */
export function settingsOf(state) {
  const values = {};
  for (const key of SETTING_KEYS) if (state?.[key] !== undefined) values[key] = state[key];
  return { values, at: { ...(state?.settingsAt ?? {}) } };
}

/** Minutes read per day from two devices: the longer of each day, the newest days kept. */
export function mergeDays(a, b) {
  const out = { ...(a ?? {}) };
  for (const [day, minutes] of Object.entries(b ?? {})) out[day] = Math.max(out[day] ?? 0, minutes);
  const days = Object.keys(out).sort().slice(-MAX_DAYS);
  return Object.fromEntries(days.map((day) => [day, out[day]]));
}

/**
 * This device's and Drive's settings, each { values: { key: value }, at: { key: time } }.
 * Returns { values, at } for both sides afterwards, `toLocal` (key → { value, at }) for what this
 * device takes, and `upload`: whether Drive's copy has to change.
 */
export function mergeSettings(local, remote) {
  const values = {};
  const at = {};
  const toLocal = {};
  let upload = false;
  for (const key of SETTING_KEYS) {
    const hasL = key in (local.values ?? {});
    const hasR = key in (remote.values ?? {});
    if (!hasL && !hasR) continue;
    const la = local.at?.[key] ?? 0;
    const ra = remote.at?.[key] ?? 0;
    let value;
    let when;
    if (!hasR || (hasL && la > ra)) {
      value = local.values[key];
      when = la || 1; // set before settings travelled: known now, and older than anything set on purpose
    } else {
      value = remote.values[key];
      when = ra;
    }
    if (key === 'readDays' && hasL && hasR) {
      value = mergeDays(local.values[key], remote.values[key]);
      when = Math.max(la, ra, 1);
    }
    if ((key === 'writeDays' || key === 'growDays') && hasL && hasR) {
      value = mergeWriting(local.values[key], remote.values[key]);
      when = Math.max(la, ra, 1);
    }
    values[key] = value;
    at[key] = when;
    if (!hasL || sig(value) !== sig(local.values[key]) || when !== la) toLocal[key] = { value, at: when };
    if (!hasR || sig(value) !== sig(remote.values[key]) || when !== ra) upload = true;
  }
  return { values, at, toLocal, upload };
}

// ---------- library cards ----------

/** Card fields that travel, in groups that change together. `opened` is the newest of both. */
// `trashed`: when the document went to the trash (null or 0: it is on the shelf)
export const CARD_GROUPS = [['name'], ['format'], ['added'], ['title'], ['author'], ['cover'], ['position', 'progress'], ['notesId'], ['scale'], ['shelf'], ['series', 'seriesNo'], ['finished'], ['trashed']];
export const CARD_FIELDS = [...CARD_GROUPS.flat(), 'opened', 'marks', 'bookmarks', 'texts', 'edits'];

const pick = (card, keys) => Object.fromEntries(keys.map((k) => [k, card?.[k] ?? null]));
const groupKey = (keys) => keys.join('+');

/** The part of a card that syncs (no id, size or local bookkeeping). */
export const cardData = (card) => pick(card, CARD_FIELDS);

/** What the base keeps of a card: one fingerprint per group and per mark / bookmark. */
export function cardSigs(card) {
  const fields = {};
  for (const keys of CARD_GROUPS) fields[groupKey(keys)] = sig(pick(card, keys));
  const items = (list) => Object.fromEntries((list ?? []).map((item) => [item.id, sig(item)]));
  return { fields, marks: items(card?.marks), bookmarks: items(card?.bookmarks), texts: items(card?.texts), edits: items(card?.edits) };
}

/** Marks or bookmarks of two sides, by id: new ones from both stay, a removal wins over an untouched copy. */
export function mergeItems(local, remote, base) {
  // a card without marks or bookmarks has null there (cardData), not an empty list
  base ??= {};
  const l = new Map((Array.isArray(local) ? local : []).map((m) => [m.id, m]));
  const r = new Map((Array.isArray(remote) ? remote : []).map((m) => [m.id, m]));
  const out = [];
  for (const id of new Set([...l.keys(), ...r.keys()])) {
    const a = l.get(id);
    const b = r.get(id);
    if (a && b) {
      const sa = sig(a);
      const sb = sig(b);
      if (sa === sb || sb === base[id]) out.push(a);
      else if (sa === base[id]) out.push(b);
      else out.push((b.edited ?? b.created ?? 0) > (a.edited ?? a.created ?? 0) ? b : a);
    } else if (a) {
      // missing on Drive: removed there if Drive once had it and this copy is as it was then
      if (!(id in base) || sig(a) !== base[id]) out.push(a);
    } else if (!(id in base) || sig(b) !== base[id]) {
      out.push(b);
    }
  }
  return out.sort((x, y) => (x.created ?? 0) - (y.created ?? 0) || (x.id < y.id ? -1 : 1));
}

/**
 * One card from this device's and Drive's, field by field. A group changed on one side only takes
 * that side; changed on both, the side where the book was opened last wins.
 */
export function mergeCard(local, remote, base) {
  const b = base ?? { fields: {}, marks: {}, bookmarks: {}, texts: {}, edits: {} };
  const localFirst = (local.opened ?? 0) >= (remote.opened ?? 0);
  const out = {};
  for (const keys of CARD_GROUPS) {
    const key = groupKey(keys);
    const sl = sig(pick(local, keys));
    const sr = sig(pick(remote, keys));
    let from;
    if (sl === sr || sr === b.fields[key]) from = local;
    else if (sl === b.fields[key]) from = remote;
    else from = localFirst ? local : remote;
    Object.assign(out, pick(from, keys));
  }
  out.opened = Math.max(local.opened ?? 0, remote.opened ?? 0);
  out.marks = mergeItems(local.marks, remote.marks, b.marks);
  out.bookmarks = mergeItems(local.bookmarks, remote.bookmarks, b.bookmarks);
  // texts and edits came after 0.10.0: a card from an older app has none at all, which says nothing about removals
  for (const key of ['texts', 'edits']) {
    if (!Array.isArray(remote[key])) out[key] = local[key] ?? [];
    else if (!Array.isArray(local[key])) out[key] = remote[key];
    else out[key] = mergeItems(local[key], remote[key], b[key] ?? {});
  }
  return out;
}

/**
 * Decides what happens to each document. Like planNotes, with each side described as
 *   { card: hash of cardData, file: hash of the file, fileTime }
 * and steps 'same' | 'merge' (both have it: cards merge, the file goes the way it changed) |
 * 'push' | 'pull' | 'trash' | 'delete' | 'forget'.
 *   base: { id: { card, file } }
 */
export function planDocs(local, remote, base) {
  const ids = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)]);
  const steps = [];
  for (const id of [...ids].sort()) {
    const l = local[id];
    const r = remote[id];
    const b = base[id];
    const rLive = r && !r.deleted;
    const untouched = (side) => b && side.card === b.card && side.file === b.file;
    if (l && rLive) {
      if (l.card === r.card && l.file === r.file) steps.push({ op: 'same', id });
      else {
        let file = 'same';
        if (l.file !== r.file) {
          if (l.file === b?.file) file = 'pull';
          else if (r.file === b?.file) file = 'push';
          else file = (l.fileTime ?? 0) >= (r.fileTime ?? 0) ? 'push' : 'pull';
        }
        steps.push({ op: 'merge', id, file });
      }
    } else if (l) {
      if (r?.deleted && untouched(l)) steps.push({ op: 'trash', id });
      else steps.push({ op: 'push', id });
    } else if (rLive) {
      if (untouched(r)) steps.push({ op: 'delete', id });
      else steps.push({ op: 'pull', id });
    } else if (b) {
      steps.push({ op: 'forget', id });
    }
  }
  return steps;
}
