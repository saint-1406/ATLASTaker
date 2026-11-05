// What the device checks before a file goes to Apocrypha: the format by its bytes (not its name),
// the size, the SHA-256 (one copy of each file in the catalogue), the language and the kind.
// Plain functions, the same in the page and in the tests.

export const SHARE_FORMATS = ['pdf', 'epub', 'fb2', 'docx', 'odt', 'rtf', 'cbz', 'txt', 'md', 'html'];
export const KINDS = ['book', 'document', 'comic'];
export const MAX_SHARE = 50 * 1024 * 1024; // the catalogue takes no bigger file (apocrypha/src/worker.js)

/** A check that failed: code is one of 'format', 'size', 'empty'. */
export class ShareCheckError extends Error {
  constructor(code, detail = '') {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a file most likely is; the person can change it before sharing. */
export function kindOf(format) {
  if (format === 'cbz') return 'comic';
  if (format === 'epub' || format === 'fb2') return 'book';
  return 'document';
}

/** The format by the file's bytes; throws ShareCheckError when Apocrypha does not take it. */
export function checkFile(name, bytes, detectFormat) {
  if (!bytes?.length) throw new ShareCheckError('empty');
  if (bytes.length > MAX_SHARE) throw new ShareCheckError('size');
  const format = detectFormat(name, bytes);
  if (!SHARE_FORMATS.includes(format)) throw new ShareCheckError('format', String(format).replace(/^unknown:/, ''));
  return format;
}

// ---------- the language ----------

const THREE = { rus: 'ru', eng: 'en', ukr: 'uk', bel: 'be', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it', por: 'pt', pol: 'pl', jpn: 'ja', zho: 'zh', chi: 'zh', kor: 'ko' };

/** "ru-RU", "RUS", "en_GB" → "ru", "ru", "en"; anything odd → ''. */
export function normalizeLang(value) {
  const raw = String(value ?? '').trim().toLowerCase().split(/[-_\s,;]/)[0];
  if (/^[a-z]{2}$/.test(raw)) return raw;
  if (/^[a-z]{3}$/.test(raw)) return THREE[raw] ?? raw;
  return '';
}

const STOPWORDS = {
  en: 'the and of to in is that it was for with he she you his her not this be are have',
  de: 'der die und das ist nicht ich sie mit den ein eine zu auf sich dem auch es',
  fr: 'le la les et est des une que pas dans il elle pour qui sur au du ne se',
  es: 'el la los las que de y en un una por con para es se no lo su del',
  it: 'il di che la e non per una un sono gli della con del lo le si',
  pt: 'o a que de e do da em um uma não com os para se no na',
  pl: 'i w nie się na że to jest z do jak ale co tak po',
};
const STOP_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words.split(' '))]));

const SCRIPTS = [
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['latin', /\p{Script=Latin}/u],
  ['el', /\p{Script=Greek}/u],
  ['ar', /\p{Script=Arabic}/u],
  ['he', /\p{Script=Hebrew}/u],
  ['ko', /\p{Script=Hangul}/u],
  ['kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['han', /\p{Script=Han}/u],
  ['hi', /\p{Script=Devanagari}/u],
  ['th', /\p{Script=Thai}/u],
  ['ka', /\p{Script=Georgian}/u],
  ['hy', /\p{Script=Armenian}/u],
];

/** The language of a piece of text: 'ru', 'en', … or 'und' when it can't tell. */
export function detectLanguage(text) {
  const sample = String(text ?? '').slice(0, 20_000);
  const counts = {};
  let letters = 0;
  for (const ch of sample) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    const script = SCRIPTS.find(([, re]) => re.test(ch))?.[0] ?? 'other';
    counts[script] = (counts[script] ?? 0) + 1;
  }
  if (letters < 20) return 'und';
  const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const lower = sample.toLowerCase();
  const share = (re) => (lower.match(re) ?? []).length / letters;
  if (top === 'cyrillic') {
    if (share(/[іїєґ]/g) > 0.004) return 'uk';
    if (share(/ў/g) > 0.002) return 'be';
    return 'ru';
  }
  if (top === 'kana' || (top === 'han' && counts.kana > letters * 0.05)) return 'ja';
  if (top === 'han') return 'zh';
  if (top === 'latin') {
    const words = lower.match(/\p{L}+/gu) ?? [];
    const score = Object.fromEntries(Object.keys(STOP_SETS).map((lang) => [lang, 0]));
    for (const word of words) for (const [lang, set] of Object.entries(STOP_SETS)) if (set.has(word)) score[lang]++;
    // letters only some languages have
    score.de += 3 * (lower.match(/[ßäöü]/g) ?? []).length;
    score.pl += 3 * (lower.match(/[ąęłśżźń]/g) ?? []).length;
    score.es += 3 * (lower.match(/[ñ¿¡]/g) ?? []).length;
    score.pt += 3 * (lower.match(/[ãõ]/g) ?? []).length;
    score.fr += 2 * (lower.match(/[èêëçœ]/g) ?? []).length;
    const [[best, n], [, next = 0] = []] = Object.entries(score).sort((a, b) => b[1] - a[1]);
    return n >= 3 && n > next * 1.2 ? best : 'und';
  }
  return top === 'other' ? 'und' : top;
}

/** The language from the book's own record if it has one, else from its text, else from its title. */
export function languageOf({ meta = '', text = '', title = '' }) {
  return normalizeLang(meta) || (() => {
    const fromText = detectLanguage(text);
    return fromText !== 'und' ? fromText : detectLanguage(`${title} ${title} ${title}`);
  })();
}

const SIZES = ['B', 'KB', 'MB', 'GB'];
export function formatSize(bytes) {
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1024 && i < SIZES.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${SIZES[i]}`;
}
