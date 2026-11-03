// What the statistics strip over a note shows: characters, words, sentences, paragraphs and how long
// the note takes to read. Counted on the text as written (Markdown marks included in the characters,
// as an editor's counter would; words and sentences from the words themselves).

const WORD_RE = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const HAS_WORD_RE = /[\p{L}\p{N}]/u;
const SENTENCE_END_RE = /[.!?…]+["»”')\]]*(?=\s|$)/gu;
const MARKUP_LINE_RE = /^(?:---+|\*\*\*+|___+|\|?[\s:|-]+\|[\s:|-]*)$/; // a rule, a table's rule row
const LEAD_RE = /^(#{1,6}\s|[-*+]\s(?:\[[ xX]\]\s)?|\d+[.)]\s|>\s?)/; // a heading, an item, a quote
export const READ_WPM = 200; // words a minute read silently, roughly the same in Russian and English

const segmenters = new Map();
function sentenceSegmenter(lang) {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
  if (!segmenters.has(lang)) segmenters.set(lang, new Intl.Segmenter(lang, { granularity: 'sentence' }));
  return segmenters.get(lang);
}

// sentences per paragraph, kept: a change to a long note counts again only the paragraph it touched
const counted = new Map();
const MAX_COUNTED = 20_000;

/** Sentences in a piece of text with no blank lines in it. */
export function sentencesIn(block, lang = 'ru') {
  const key = `${lang}\u0000${block}`;
  const known = counted.get(key);
  if (known !== undefined) return known;
  if (counted.size >= MAX_COUNTED) counted.clear();
  const n = countSentences(block, lang);
  counted.set(key, n);
  return n;
}

function countSentences(block, lang) {
  if (!HAS_WORD_RE.test(block)) return 0;
  const seg = sentenceSegmenter(lang);
  if (!seg) {
    // no Intl.Segmenter: the ends of sentences, and a last one without its full stop
    const ends = block.match(SENTENCE_END_RE)?.length ?? 0;
    return ends + (/[.!?…]["»”')\]]*\s*$/u.test(block) ? 0 : 1);
  }
  let n = 0;
  for (const part of seg.segment(block)) if (HAS_WORD_RE.test(part.segment)) n++;
  return n;
}

/**
 * { chars, charsNoSpaces, words, sentences, paragraphs, readMinutes } of a note. A paragraph is a line
 * with words on it (a heading, an item of a list, a line of a poem); a sentence never runs across a
 * blank line, a heading or an item. Code blocks are not prose: no paragraphs or sentences in them.
 */
export function textStats(text, lang = 'ru') {
  const chars = text.length;
  const charsNoSpaces = text.replace(/\s/g, '').length;
  const words = text.match(WORD_RE)?.length ?? 0;
  let paragraphs = 0;
  let sentences = 0;
  let block = [];
  let fence = false;
  const flush = () => {
    if (block.length) sentences += sentencesIn(block.join(' '), lang);
    block = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      flush();
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (!line || MARKUP_LINE_RE.test(line) || !HAS_WORD_RE.test(line)) {
      flush();
      continue;
    }
    paragraphs++;
    if (LEAD_RE.test(line)) {
      flush();
      sentences += sentencesIn(line.replace(LEAD_RE, ''), lang);
    } else block.push(line);
  }
  flush();
  return { chars, charsNoSpaces, words, sentences, paragraphs, readMinutes: words / READ_WPM };
}
