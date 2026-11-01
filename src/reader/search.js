// Finding a word or a phrase in a document's text. The text is folded first — lower case, ё as е,
// every run of spaces and line breaks as one space, soft hyphens and zero-width marks gone — and a
// map leads each folded character back to its place in the original, so a match can be shown there.
// A word cut at the end of a line ("сло-⏎во") is found whole, and a phrase with a real hyphen
// ("что-то") is found even where the line breaks at that hyphen.

const SPACE = /\s/; // every Unicode space, the no-break ones too
const LETTER = /[\p{L}\p{N}]/u;
const JOIN = '\x01'; // a hyphen at the end of a line, between two letters
const JOIN_CODE = 1; // JOIN, as a character code
const HYPHEN = 45;
const [YO, YE] = [0x451, 0x435]; // ё, е
const decoder = new TextDecoder('utf-16le');
export const MAX_HITS = 5000;

/** { text, map }: the folded text, and for each of its characters the index it came from. */
export function foldText(source) {
  // a whole book is folded in one go, so the work is done on character codes in typed arrays, with
  // lower case for the whole text at once where that keeps every character in place (nearly always)
  const lowered = source.toLowerCase();
  const inPlace = lowered.length === source.length;
  let out = new Uint16Array(source.length + 8);
  let map = new Int32Array(source.length + 8);
  let n = 0;
  const put = (c, at) => {
    if (n >= out.length) {
      const bigger = new Uint16Array(out.length * 2);
      bigger.set(out);
      out = bigger;
      const wider = new Int32Array(map.length * 2);
      wider.set(map);
      map = wider;
    }
    out[n] = c === YO ? YE : c;
    map[n++] = at;
  };
  let space = false; // a run of spaces is waiting to be written
  let spaceAt = 0; // ...where it began
  let newline = false; // ...and whether it holds a line break
  let soft = false; // a soft hyphen came right before the run
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 32 || (c >= 9 && c <= 13) || (c < 0x2000 ? c === 0xa0 || c === 0x1680 : SPACE.test(source[i]))) {
      if (!space) spaceAt = i;
      space = true;
      if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) newline = true;
      continue;
    }
    if (c === 0xad || (c >= 0x200b && c <= 0x200d) || c === 0x2060) {
      if (c === 0xad) soft = true;
      continue;
    }
    if (space) {
      const last = n ? out[n - 1] : 0;
      if (newline && n && LETTER.test(source[i]) && (soft || (last === HYPHEN && n > 1 && LETTER.test(String.fromCharCode(out[n - 2]))))) {
        // a word broken over a line: no space between its halves
        if (last === HYPHEN) out[n - 1] = JOIN_CODE;
      } else if (n) put(32, spaceAt);
      space = newline = false;
    }
    soft = false;
    if (inPlace) put(lowered.charCodeAt(i), i);
    else {
      const lower = source[i].toLowerCase();
      for (let k = 0; k < lower.length; k++) put(lower.charCodeAt(k), i);
    }
  }
  return { text: decoder.decode(out.subarray(0, n)), map: map.slice(0, n) };
}

/** The query as a pattern over folded text, or null when there is nothing to look for. */
export function queryPattern(query) {
  const folded = foldText(String(query ?? '')).text.trim();
  if (!folded) return null;
  const chars = [...folded];
  const parts = chars.map((c) => (c === '-' ? `(?:-|${JOIN})` : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // a cut line may fall between any two letters of the query
  let source = '';
  for (let i = 0; i < parts.length; i++) {
    source += parts[i];
    if (i < parts.length - 1 && chars[i] !== '-' && chars[i + 1] !== '-' && chars[i] !== ' ' && chars[i + 1] !== ' ') source += `${JOIN}?`;
  }
  return new RegExp(source, 'gu');
}

/** Every match of `pattern` in a folded text, as [start, end) in the original it was folded from. */
export function findIn(folded, pattern, limit = MAX_HITS) {
  const hits = [];
  if (!pattern || !folded.text) return hits;
  pattern.lastIndex = 0;
  for (let m = pattern.exec(folded.text); m && hits.length < limit; m = pattern.exec(folded.text)) {
    if (!m[0].length) {
      pattern.lastIndex++;
      continue;
    }
    hits.push([folded.map[m.index], folded.map[m.index + m[0].length - 1] + 1]);
  }
  return hits;
}

const GAP = /\n[^\S\n]*\n/g; // a blank line: where a paragraph ends

/** A few words either side of a match, on one line and inside its paragraph: [before, match, after]. */
export function snippet(text, start, end, room = 40) {
  const flat = (s) => s.replace(/\s+/g, ' ');
  let from = Math.max(0, start - room);
  let to = Math.min(text.length, end + room);
  let openStart = from > 0;
  let openEnd = to < text.length;
  const before = [...text.slice(from, start).matchAll(GAP)].pop();
  if (before) {
    from += before.index + before[0].length;
    openStart = false;
  }
  const after = [...text.slice(end, to).matchAll(GAP)][0];
  if (after) {
    to = end + after.index;
    openEnd = false;
  }
  // whole words at the edges, where a space is near
  if (openStart) {
    const cut = text.slice(from, start).search(/\s/);
    if (cut >= 0 && cut < room / 2) from += cut + 1;
  }
  if (openEnd) {
    const cut = text.slice(end, to).search(/\s\S*$/);
    if (cut > room / 2) to = end + cut;
  }
  return [(openStart ? '…' : '') + flat(text.slice(from, start)).trimStart(), flat(text.slice(start, end)), flat(text.slice(end, to)).trimEnd() + (openEnd ? '…' : '')];
}
