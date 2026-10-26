// Reads a note's markdown just enough for the map: title, headings with their section sizes, counts.

import { isCommentLine } from './comments.js';

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}_'’-]*/gu;
const TABLE_RULE_RE = /^\|?\s*:?-{3,}/;

export const WORD_FORMS = { one: 'слово', few: 'слова', many: 'слов', other: 'слова' };

/** A picture stored by the app: ![alt](assets/a-….png). Group 1 is the alt text, group 2 the file name. */
export const IMAGE_RE = /!\[([^\]\n]*)\]\(assets\/(a-[a-z0-9]{6,40}\.(?:png|jpg|gif|webp))\)/g;

/** File names of the pictures a note shows, each once. */
export function imageRefs(text) {
  return [...new Set([...text.matchAll(IMAGE_RE)].map((m) => m[2]))];
}
const pluralRules = new Intl.PluralRules('ru-RU');
const number = new Intl.NumberFormat('ru-RU');

export function formatCount(n, forms) {
  return `${number.format(n)} ${forms[pluralRules.select(n)] ?? forms.other}`;
}

export function countWords(text) {
  return (text.match(WORD_RE) ?? []).length;
}

export function cleanInline(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .replace(/[*_~`]+/g, '')
    .trim();
}

function clip(s, max) {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export function deriveTitle(text) {
  let fence = null;
  for (const raw of text.split('\n', 200)) {
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(raw);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = FENCE_OPEN_RE.exec(raw);
    if (open) { fence = open[1]; continue; }
    if (isCommentLine(raw)) continue;
    const title = cleanInline(raw.trim().replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, ''));
    if (title) return clip(title, 80);
  }
  return '';
}

export function analyze(text) {
  const lines = text.split('\n');
  const headings = [];
  let fence = null;
  let words = 0;
  let codeBlocks = 0;
  let comments = 0;
  let excerpt = '';
  let seenTitle = false;
  // A section runs until the next heading of its own level or higher, so a chapter's summit
  // includes everything in its subsections.
  const open = [];
  const addWords = (w) => {
    words += w;
    for (const s of open) s.words += w;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) { fence = null; continue; }
      addWords(countWords(line));
      continue;
    }
    const opening = FENCE_OPEN_RE.exec(line);
    if (opening) { fence = opening[1]; codeBlocks++; continue; }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      const textOf = cleanInline(heading[2]) || '…';
      while (open.length && open[open.length - 1].level >= level) open.pop();
      addWords(countWords(textOf));
      const section = { level, text: clip(textOf, 60), line: i + 1, words: 0 };
      headings.push(section);
      open.push(section);
      seenTitle = true;
      continue;
    }

    const isComment = isCommentLine(line);
    if (isComment) comments++;
    addWords(countWords(line));

    const trimmed = line.trim();
    if (!trimmed || isComment || TABLE_RULE_RE.test(trimmed)) continue;
    if (!seenTitle) { seenTitle = true; continue; }
    if (excerpt.length < 170) excerpt += (excerpt ? ' ' : '') + cleanInline(trimmed);
  }

  return {
    title: deriveTitle(text),
    words,
    chars: text.length,
    headings,
    codeBlocks,
    comments,
    excerpt: clip(excerpt, 170),
  };
}
