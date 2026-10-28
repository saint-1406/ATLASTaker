// Word documents (.docx): a zip of XML parts. word/document.xml holds paragraphs (w:p) made of runs
// (w:r); styles.xml says which paragraph styles are headings, numbering.xml which lists are numbered,
// the relationships file where links and pictures point. Footnotes land at the end of the book.

import { joinPath } from './zip.js';
import { attr, child, children, elements, find, findAll, local, parseXml, textOf } from './xml.js';
import { el, safeHref } from './model.js';

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
export const imageType = (path) => IMAGE_TYPES[String(path).split('.').pop().toLowerCase()] ?? null;

/** A w:b / w:i style switch: on unless its value says off. */
function on(node) {
  if (!node) return false;
  const value = attr(node, 'val');
  return value === undefined || !['0', 'false', 'off', 'none'].includes(String(value).toLowerCase());
}

const hasText = (nodes) => nodes.some((n) => (typeof n === 'string' ? n.trim() : n.tag === 'img' || hasText(n.children)));

export async function docxBook(zip) {
  const xml = async (name) => (zip.has(name) ? parseXml(await zip.text(name)) : null);
  const document = await xml('word/document.xml');
  if (!document) throw new Error('docx: no word/document.xml');

  const rels = new Map();
  for (const r of findAll(await xml('word/_rels/document.xml.rels'), ['relationship'])) {
    rels.set(r.attrs.id, { target: r.attrs.target, external: String(r.attrs.targetmode).toLowerCase() === 'external' });
  }

  const headingOf = new Map(); // style id → heading level
  for (const style of findAll(await xml('word/styles.xml'), ['style'])) {
    const name = attr(child(style, 'name'), 'val') ?? '';
    const outline = attr(find(child(style, 'ppr'), 'outlinelvl'), 'val');
    let level = /^heading\s*(\d)$/i.exec(name)?.[1] ?? (/^title$/i.test(name) ? 1 : null);
    if (level == null && outline != null && Number(outline) < 6) level = Number(outline) + 1;
    if (level) headingOf.set(attr(style, 'styleid'), Math.min(6, Number(level)));
  }

  const ordered = new Map(); // num id → Map(level → numbered?)
  const numbering = await xml('word/numbering.xml');
  const abstract = new Map();
  for (const a of findAll(numbering, ['abstractnum'])) {
    abstract.set(attr(a, 'abstractnumid'), new Map(children(a, 'lvl').map((lvl) => [attr(lvl, 'ilvl'), attr(child(lvl, 'numfmt'), 'val') !== 'bullet'])));
  }
  for (const num of findAll(numbering, ['num'])) ordered.set(attr(num, 'numid'), abstract.get(attr(child(num, 'abstractnumid'), 'val')) ?? new Map());

  const pictures = new Set();
  const notes = []; // { kind, id, number } in the order the text refers to them
  const ctx = { rels, pictures, notes, headingOf, ordered };
  const blocks = bodyBlocks(find(document, 'body') ?? document, ctx);

  for (const [kind, part] of [['footnote', 'word/footnotes.xml'], ['endnote', 'word/endnotes.xml']]) {
    const wanted = notes.filter((n) => n.kind === kind);
    if (!wanted.length) continue;
    const all = new Map(findAll(await xml(part), [kind]).map((n) => [attr(n, 'id'), n]));
    const section = [];
    for (const note of wanted) {
      const body = all.get(note.id);
      if (!body) continue;
      const inner = bodyBlocks(body, ctx);
      if (inner[0]?.tag === 'p') inner[0].children.unshift(el('strong', {}, [`${note.number}. `]));
      else inner.unshift(el('p', {}, [el('strong', {}, [`${note.number}.`])]));
      inner[0].attrs.id = `docx-${kind}-${note.id}`;
      section.push(...inner);
    }
    if (section.length) blocks.push(el('section', { class: 'notes' }, [el('hr'), ...section]));
  }

  const resources = new Map();
  for (const path of pictures) {
    try {
      resources.set(path, { type: imageType(path), bytes: await zip.read(path) });
    } catch {
      // a missing picture: the text still reads
    }
  }
  const core = await xml('docProps/core.xml');
  return {
    title: textOf(find(core, 'title')).trim(),
    author: textOf(find(core, 'creator')).trim(),
    cover: null,
    blocks,
    resources,
  };
}

function bodyBlocks(container, ctx) {
  const out = [];
  let lists = []; // open lists, outermost first
  for (const node of elements(container)) {
    const name = local(node.name);
    if (name === 'p') {
      const ppr = child(node, 'ppr');
      const numPr = child(ppr, 'numpr');
      const numId = attr(child(numPr, 'numid'), 'val');
      const kids = runs(node, ctx);
      if (numId && numId !== '0') {
        const level = Math.min(8, Number(attr(child(numPr, 'ilvl'), 'val') ?? 0) || 0);
        const numbered = ctx.ordered.get(numId)?.get(String(level)) ?? false;
        while (lists.length > level + 1) lists.pop();
        if (lists.length === level + 1 && (lists[level].tag === 'ol') !== numbered) lists.pop();
        while (lists.length < level + 1) {
          const list = el(numbered ? 'ol' : 'ul');
          const parent = lists[lists.length - 1];
          if (parent) {
            if (!parent.children.length) parent.children.push(el('li'));
            parent.children[parent.children.length - 1].children.push(list);
          } else out.push(list);
          lists.push(list);
        }
        lists[level].children.push(el('li', {}, kids));
        continue;
      }
      lists = [];
      if (!hasText(kids)) continue;
      const style = attr(child(ppr, 'pstyle'), 'val');
      const outline = attr(child(ppr, 'outlinelvl'), 'val');
      const level = ctx.headingOf.get(style) ?? (outline != null && Number(outline) < 6 ? Number(outline) + 1 : null);
      out.push(el(level ? `h${level}` : 'p', {}, kids));
    } else if (name === 'tbl') {
      lists = [];
      out.push(table(node, ctx));
    } else if (['sdt', 'sdtcontent', 'customxml', 'ins', 'smarttag'].includes(name)) {
      lists = [];
      out.push(...bodyBlocks(node, ctx));
    }
  }
  return out;
}

function table(tbl, ctx) {
  const rows = children(tbl, 'tr').map((tr) =>
    el(
      'tr',
      {},
      children(tr, 'tc').map((tc) => {
        const props = child(tc, 'tcpr');
        const merge = child(props, 'vmerge');
        // the lower parts of a vertically merged cell stay empty, so the columns still line up
        if (merge && attr(merge, 'val') !== 'restart') return el('td');
        const inner = bodyBlocks(tc, ctx);
        const kids = inner.length === 1 && inner[0].tag === 'p' ? inner[0].children : inner;
        return el('td', { colspan: attr(child(props, 'gridspan'), 'val') }, kids);
      }),
    ),
  );
  return el('table', {}, [el('tbody', {}, rows)]);
}

function runs(node, ctx) {
  const out = [];
  for (const c of elements(node)) {
    const name = local(c.name);
    if (name === 'r') out.push(...run(c, ctx));
    else if (name === 'hyperlink') {
      const rel = ctx.rels.get(attr(c, 'id'));
      const anchor = attr(c, 'anchor');
      const href = rel?.external ? safeHref(rel.target) : anchor ? `#docx-${anchor}` : null;
      const kids = runs(c, ctx);
      out.push(...(href ? [el('a', { href }, kids)] : kids));
    } else if (name === 'bookmarkstart') {
      const bookmark = attr(c, 'name');
      if (bookmark && !bookmark.startsWith('_GoBack')) out.push(el('span', { id: `docx-${bookmark}` }));
    } else if (['ins', 'smarttag', 'customxml', 'fldsimple', 'sdt', 'sdtcontent'].includes(name)) out.push(...runs(c, ctx));
  }
  return out;
}

function run(r, ctx) {
  const props = child(r, 'rpr');
  let kids = [];
  for (const c of elements(r)) {
    const name = local(c.name);
    if (name === 't') kids.push(textOf(c));
    else if (name === 'tab') kids.push('\t');
    else if (name === 'br' || name === 'cr') kids.push(el('br'));
    else if (name === 'nobreakhyphen') kids.push('‑');
    else if (name === 'softhyphen') kids.push('­');
    else if (name === 'drawing' || name === 'pict' || name === 'object') {
      const blip = find(c, 'blip');
      const rel = ctx.rels.get(blip ? attr(blip, 'embed') : attr(find(c, 'imagedata'), 'id'));
      if (rel && !rel.external) {
        const path = joinPath('word/document.xml', rel.target);
        if (imageType(path)) {
          ctx.pictures.add(path);
          kids.push(el('img', { ref: path, alt: attr(find(c, 'docpr'), 'descr') ?? '' }));
        }
      }
    } else if (name === 'footnotereference' || name === 'endnotereference') {
      const kind = name === 'footnotereference' ? 'footnote' : 'endnote';
      const id = attr(c, 'id');
      const number = ctx.notes.filter((n) => n.kind === kind).length + 1;
      ctx.notes.push({ kind, id, number });
      kids.push(el('sup', {}, [el('a', { href: `#docx-${kind}-${id}` }, [String(number)])]));
    }
  }
  if (!kids.length) return [];
  const align = attr(child(props, 'vertalign'), 'val');
  if (align === 'superscript') kids = [el('sup', {}, kids)];
  else if (align === 'subscript') kids = [el('sub', {}, kids)];
  if (on(child(props, 'strike')) || on(child(props, 'dstrike'))) kids = [el('s', {}, kids)];
  const underline = child(props, 'u');
  if (underline && on(underline)) kids = [el('u', {}, kids)];
  if (on(child(props, 'i'))) kids = [el('em', {}, kids)];
  if (on(child(props, 'b'))) kids = [el('strong', {}, kids)];
  return kids;
}
