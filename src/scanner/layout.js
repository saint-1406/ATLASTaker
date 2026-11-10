// From what the recognizer found on a page (pieces of text, each with its box) to text a person
// reads: the order of reading (columns left to right, a heading over them first), lines, paragraphs,
// words broken with a hyphen at a line's end joined again, and letters of the wrong alphabet put
// right (the recognizer reads Russian and English with one model and now and then takes "о" for "o").
// No DOM here: the tests run it in Node.

/** item: { box: [[x, y] × 4] (tl, tr, br, bl), text, score }. */

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function toBox(item) {
  const pts = item.box;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const side = (a, b) => Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
  return {
    text: String(item.text ?? '').trim(),
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    y0: Math.min(...ys),
    y1: Math.max(...ys),
    // the height of the letters: the box's short sides (tl–bl, tr–br)
    h: Math.max(1, (side(0, 3) + side(1, 2)) / 2),
  };
}

/** The widest empty band along one axis among the boxes: { at, size, before, after } or null. */
function widestGap(boxes, lo, hi) {
  const spans = boxes.map((b) => [lo(b), hi(b)]).sort((a, b) => a[0] - b[0]);
  let best = null;
  let reach = spans[0][1];
  for (let i = 1; i < spans.length; i++) {
    const [start, end] = spans[i];
    if (start > reach && (!best || start - reach > best.size)) best = { at: (start + reach) / 2, size: start - reach };
    reach = Math.max(reach, end);
  }
  return best;
}

/**
 * The page cut into blocks in reading order (recursive XY-cut): a gutter that runs the whole height
 * splits columns (left first), a wide empty band splits top from bottom (top first).
 */
function blocks(boxes, H) {
  if (boxes.length < 2) return [boxes];
  const col = widestGap(boxes, (b) => b.x0, (b) => b.x1);
  if (col && col.size >= 1.2 * H) {
    const left = boxes.filter((b) => b.x1 <= col.at);
    const right = boxes.filter((b) => b.x0 >= col.at);
    const tall = (list) => Math.max(...list.map((b) => b.y1)) - Math.min(...list.map((b) => b.y0)) >= 1.5 * H;
    // a gutter between columns, not the space between two words of one line
    if (left.length && right.length && tall(left) && tall(right)) return [...blocks(left, H), ...blocks(right, H)];
  }
  const row = widestGap(boxes, (b) => b.y0, (b) => b.y1);
  if (row && row.size >= 1.2 * H) {
    const top = boxes.filter((b) => b.y1 <= row.at);
    const bottom = boxes.filter((b) => b.y0 >= row.at);
    if (top.length && bottom.length) return [...blocks(top, H), ...blocks(bottom, H)];
  }
  return [boxes];
}

/** The boxes of one block grouped into lines, top to bottom, each line's pieces left to right. */
function lines(boxes) {
  const sorted = [...boxes].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const out = [];
  for (const b of sorted) {
    const line = out.find((l) => {
      const overlap = Math.min(l.y1, b.y1) - Math.max(l.y0, b.y0);
      return overlap >= 0.5 * Math.min(l.y1 - l.y0, b.y1 - b.y0);
    });
    if (line) {
      line.items.push(b);
      line.y0 = Math.min(line.y0, b.y0);
      line.y1 = Math.max(line.y1, b.y1);
    } else {
      out.push({ items: [b], y0: b.y0, y1: b.y1 });
    }
  }
  return out
    .map((l) => {
      l.items.sort((a, b) => a.x0 - b.x0);
      return {
        text: l.items.map((b) => b.text).join(' '),
        x0: Math.min(...l.items.map((b) => b.x0)),
        x1: Math.max(...l.items.map((b) => b.x1)),
        y0: l.y0,
        y1: l.y1,
        cy: (l.y0 + l.y1) / 2,
        h: median(l.items.map((b) => b.h)),
      };
    })
    .sort((a, b) => a.cy - b.cy);
}

const LIST_START = /^(?:[•·▪◦‣⁃●■□–—-]\s|\d{1,3}[.)]\s|[a-zа-я][.)]\s)/iu;
const SENTENCE_END = /[.!?…:;»"”)]$/u;

/** One block's lines → paragraphs (arrays of lines). */
function paragraphs(blockLines) {
  if (!blockLines.length) return [];
  const pitches = [];
  for (let i = 1; i < blockLines.length; i++) pitches.push(blockLines[i].cy - blockLines[i - 1].cy);
  // the step from a line to the next inside a paragraph: the smaller steps (a page of two-line
  // paragraphs has as many steps between paragraphs as inside them, so not the median)
  const sorted = [...pitches].sort((a, b) => a - b);
  const pitch = sorted[Math.floor((sorted.length - 1) / 4)] ?? 0;
  const left = median(blockLines.map((l) => l.x0));
  const right = Math.max(...blockLines.map((l) => l.x1));
  const H = median(blockLines.map((l) => l.h));
  const doubleSpaced = pitch > 1.6 * H;
  const out = [[blockLines[0]]];
  for (let i = 1; i < blockLines.length; i++) {
    const prev = blockLines[i - 1];
    const line = blockLines[i];
    const gap = line.cy - prev.cy;
    // more room than a line takes: a blank line on paper (unless the whole text is double spaced)
    const wider = (pitches.length > 1 && gap > pitch * 1.35) || (!doubleSpaced && gap > 1.6 * H);
    // a heading over its text: larger letters than the block's own (a line without tall letters or
    // descenders has a lower box, so only "larger" counts, not "smaller")
    const sizeChange = prev.h > 1.3 * H !== line.h > 1.3 * H;
    const indented = line.x0 - left > 1.2 * H && prev.x0 - left < 0.6 * H;
    const shortBefore = prev.x1 < right - 3 * H && SENTENCE_END.test(prev.text);
    if (wider || sizeChange || indented || shortBefore || LIST_START.test(line.text)) out.push([line]);
    else out[out.length - 1].push(line);
  }
  return out;
}

const HYPHEN_END = /[\p{L}][-‐¬]$/u;
const LOWER_START = /^\p{Ll}/u;

/** A paragraph's lines as one text: "приложе-" + "ния" → "приложения"; otherwise a space between. */
export function joinLines(texts, keepLines = false) {
  if (keepLines) return texts.join('\n');
  let out = '';
  for (const text of texts) {
    if (!out) out = text;
    else if (HYPHEN_END.test(out) && LOWER_START.test(text)) out = out.slice(0, -1) + text;
    else out += ` ${text}`;
  }
  return out;
}

/**
 * A page's text as paragraphs, in reading order. items: what the recognizer found. Pieces that are
 * empty or that it was not sure of (score under minScore) are left out.
 */
export function pageParagraphs(items, { minScore = 0.5, keepLines = false } = {}) {
  const boxes = items.filter((it) => (it.score ?? 1) >= minScore).map(toBox).filter((b) => b.text);
  if (!boxes.length) return [];
  const H = median(boxes.map((b) => b.h));
  const out = [];
  for (const block of blocks(boxes, H)) {
    for (const para of paragraphs(lines(block))) out.push(fixScripts(joinLines(para.map((l) => l.text), keepLines)));
  }
  return out;
}

// ---------- letters of the wrong alphabet ----------

// look-alikes: Cyrillic → Latin (with the recognizer's own mix-ups т/m, п/n, г/r, used only to turn a
// word into Latin when the rest of it is Latin) and Latin → Cyrillic
const CYR_TO_LAT = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y', І: 'I', Ј: 'J', Ѕ: 'S',
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', к: 'k', т: 'm', п: 'n', г: 'r',
};
// the mix-ups that are not look-alikes in print: never enough on their own to turn a word
const LOOSE = new Set(['т', 'п', 'г']);
const LAT_TO_CYR = {
  A: 'А', B: 'В', E: 'Е', K: 'К', M: 'М', H: 'Н', O: 'О', P: 'Р', C: 'С', T: 'Т', X: 'Х', Y: 'У',
  a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', y: 'у', x: 'х', k: 'к',
};
const isCyr = (ch) => /\p{Script=Cyrillic}/u.test(ch);
const isLat = (ch) => /\p{Script=Latin}/u.test(ch);

/** 'lat', 'cyr' or null (both or neither alphabet): by the letters that cannot be the other's. */
function sureScript(word) {
  let lat = 0;
  let cyr = 0;
  for (const ch of word) {
    if (isLat(ch) && !(ch in LAT_TO_CYR)) lat++;
    else if (isCyr(ch) && !(ch in CYR_TO_LAT)) cyr++;
  }
  if (lat && !cyr) return 'lat';
  if (cyr && !lat) return 'cyr';
  return null;
}

const convert = (word, to) => [...word].map((ch) => (to === 'lat' ? (isCyr(ch) ? CYR_TO_LAT[ch] ?? ch : ch) : isLat(ch) ? LAT_TO_CYR[ch] ?? ch : ch)).join('');

/**
 * Each word in one alphabet: a word with letters of both is turned into the one its unmistakable
 * letters belong to (else the one most of its letters are in, Latin on a tie: "AРІ" → "API"); a word
 * of one or two look-alike letters takes the alphabet of the next clear word ("a также" → "а также").
 * A rouble sign read as "Р" after a number in a Russian text comes back as "₽".
 */
export function fixScripts(text) {
  const words = [...text.matchAll(/\p{L}+/gu)].map((m) => ({ at: m.index, word: m[0] }));
  const clear = words.map((w) => sureScript(w.word));
  const fixed = words.map((w, i) => {
    const letters = [...w.word];
    const lat = letters.filter(isLat).length;
    const cyr = letters.filter(isCyr).length;
    if (lat && cyr) {
      // no letter decides: an all-capital word is most likely an abbreviation (API, OCR), else the majority
      const caps = w.word === w.word.toUpperCase();
      const to = clear[i] ?? (caps || lat >= cyr ? 'lat' : 'cyr');
      return convert(w.word, to);
    }
    // a small lowercase word ("a", "c", "у"), not a part of a name like "C++" or "x2"
    const after = text.slice(w.at + w.word.length, w.at + w.word.length + 2);
    if (letters.length <= 2 && !clear[i] && !letters.some((ch) => LOOSE.has(ch)) && w.word === w.word.toLowerCase() && !/^(?:[+#\d_]|\.\p{L})/u.test(after)) {
      const to = i + 1 < words.length ? clear[i + 1] : clear[i - 1];
      if (to && to !== (lat ? 'lat' : 'cyr')) return convert(w.word, to);
    }
    return w.word;
  });
  let out = '';
  let pos = 0;
  words.forEach((w, i) => {
    out += text.slice(pos, w.at) + fixed[i];
    pos = w.at + w.word.length;
  });
  out += text.slice(pos);
  const cyrillic = (out.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const latin = (out.match(/\p{Script=Latin}/gu) ?? []).length;
  if (cyrillic > latin) out = out.replace(/(\d)\s?[РP](?=$|[\s.,;:!?)])/gu, '$1 ₽');
  return out;
}

/**
 * The text of a scan: pages → paragraphs → text, a blank line between paragraphs (and between
 * pages). pages: [{ items }]. keepLines: the lines as on paper, not run together into paragraphs.
 */
export function scanText(pages, { keepLines = false, minScore = 0.5 } = {}) {
  return pages
    .map((page) => pageParagraphs(page.items ?? [], { keepLines, minScore }).join('\n\n'))
    .filter(Boolean)
    .join('\n\n');
}

/** How sure the recognizer was over a page, 0…1, weighed by how much text each piece holds. */
export function pageConfidence(items) {
  let sum = 0;
  let n = 0;
  for (const it of items ?? []) {
    const len = String(it.text ?? '').length;
    sum += (it.score ?? 0) * len;
    n += len;
  }
  return n ? sum / n : 0;
}
