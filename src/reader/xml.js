// A small, forgiving XML/HTML parser for the documents the library reads (FB2, the XML inside DOCX
// and EPUB, plain HTML). It never runs anything and never fails: unknown entities stay as text,
// stray end tags are dropped, unclosed elements end where their parent does. Names are lower-cased.
//
//   parseXml(text) → { name: '#root', attrs: {}, children: [element | string] }

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
// not "title": in FB2 a <title> holds paragraphs
const RAW_TEXT = new Set(['script', 'style']);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­', ensp: ' ', emsp: ' ',
  thinsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’',
  sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™',
  deg: '°', plusmn: '±', times: '×', divide: '÷', sect: '§', para: '¶', euro: '€', pound: '£', yen: '¥',
  cent: '¢', frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', larr: '←', rarr: '→', uarr: '↑',
  darr: '↓', harr: '↔', minus: '−', prime: '′', Prime: '″', dagger: '†', Dagger: '‡', permil: '‰',
  iexcl: '¡', iquest: '¿', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏', numero: '№',
  hyphen: '‐', infin: '∞', ne: '≠', le: '≤', ge: '≥', asymp: '≈', alpha: 'α', beta: 'β', gamma: 'γ',
  delta: 'δ', pi: 'π', sigma: 'σ', omega: 'ω', mu: 'μ', lambda: 'λ', micro: 'µ', acute: '´', uml: '¨',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä', ouml: 'ö',
  uuml: 'ü', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ', oacute: 'ó', iacute: 'í', uacute: 'ú',
};

export function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

function parseAttrs(source) {
  const attrs = {};
  for (const m of source.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const addText = (s) => {
    if (!s) return;
    const kids = top().children;
    if (typeof kids[kids.length - 1] === 'string') kids[kids.length - 1] += s;
    else kids.push(s);
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      addText(decodeEntities(text.slice(i)));
      break;
    }
    if (lt > i) addText(decodeEntities(text.slice(i, lt)));
    i = lt;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      addText(text.slice(i + 9, end < 0 ? n : end));
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text[i + 1] === '?' || text[i + 1] === '!') {
      const end = text.indexOf('>', i + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const close = text[i + 1] === '/';
    const m = /^<\/?([A-Za-z_][\w:.-]*)/.exec(text.slice(i, i + 200));
    if (!m) {
      addText('<');
      i++;
      continue;
    }
    // the tag ends at the first ">" outside quotes
    let j = i + m[0].length;
    let quote = null;
    for (; j < n; j++) {
      const c = text[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    const name = m[1].toLowerCase();
    const inner = text.slice(i + m[0].length, j);
    i = j + 1;
    if (close) {
      const at = stack.findLastIndex((el) => el.name === name);
      if (at > 0) stack.length = at;
      continue;
    }
    const selfClosing = inner.trimEnd().endsWith('/');
    const el = { name, attrs: parseAttrs(selfClosing ? inner.trimEnd().slice(0, -1) : inner), children: [] };
    top().children.push(el);
    if (selfClosing || VOID.has(name)) continue;
    if (RAW_TEXT.has(name)) {
      const end = text.toLowerCase().indexOf(`</${name}`, i);
      const body = text.slice(i, end < 0 ? n : end);
      if (body) el.children.push(body);
      const after = end < 0 ? n : text.indexOf('>', end);
      i = after < 0 ? n : after + 1;
      continue;
    }
    stack.push(el);
  }
  return root;
}

/** The name without its namespace prefix: "w:p" → "p". */
export const local = (name) => name.slice(name.indexOf(':') + 1);

export const elements = (node) => (node?.children ?? []).filter((c) => typeof c !== 'string');

/** The first descendant (depth first) whose local name is one of `names`. */
export function find(node, ...names) {
  for (const child of elements(node)) {
    if (names.includes(local(child.name))) return child;
    const deeper = find(child, ...names);
    if (deeper) return deeper;
  }
  return null;
}

/** Every descendant whose local name is one of `names`, without looking inside a match. */
export function findAll(node, names, out = []) {
  for (const child of elements(node)) {
    if (names.includes(local(child.name))) out.push(child);
    else findAll(child, names, out);
  }
  return out;
}

/** A direct child by local name. */
export const child = (node, name) => elements(node).find((c) => local(c.name) === name) ?? null;

export const children = (node, name) => elements(node).filter((c) => local(c.name) === name);

/** All the text inside, as one string. */
export function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  return node.children.map(textOf).join('');
}

/** An attribute by local name, whatever prefix the file gave it ("xlink:href", "l:href", "href"). */
export function attr(node, name) {
  if (!node) return undefined;
  if (name in node.attrs) return node.attrs[name];
  for (const [key, value] of Object.entries(node.attrs)) if (local(key) === name) return value;
  return undefined;
}
