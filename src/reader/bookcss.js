// A book's own CSS, read for the few things that carry meaning in the text: italics and bold set by a
// class (most EPUBs mark emphasis as <span class="calibre5">, not <i>), underline, and how a paragraph
// sits: aligned right or centred, or indented from the left (the two sides of a text-message exchange).
// Nothing else of the book's styling reaches the page: these become the reader's own classes.
//   look = { italic, bold, underline, align: 'right' | 'center' | null, indent: 0..3 }

const EMPTY = Object.freeze({ italic: false, bold: false, underline: false, align: null, indent: 0 });

/** How far a left margin or padding goes, as a step of 0..3 (about 2em each). */
function indentStep(value) {
  const m = /^(-?\d*\.?\d+)\s*(em|rem|%|px|pt|ex|ch|vw)?$/i.exec(String(value).trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'px').toLowerCase();
  const em = unit === '%' || unit === 'vw' ? n / 8 : unit === 'px' ? n / 16 : unit === 'pt' ? n / 12 : unit === 'ex' || unit === 'ch' ? n / 2 : n;
  if (em >= 5) return 3;
  if (em >= 3) return 2;
  if (em >= 1.5) return 1;
  return 0;
}

/** The look one declaration block gives ("font-style: italic; margin-left: 25%"). */
export function lookOfDeclarations(text) {
  const look = {};
  for (const part of String(text).split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).replace(/!important/i, '').trim().toLowerCase();
    if (prop === 'font-style') look.italic = value === 'italic' || value === 'oblique';
    else if (prop === 'font-weight') look.bold = value === 'bold' || value === 'bolder' || Number(value) >= 600;
    else if (prop === 'text-decoration' || prop === 'text-decoration-line') look.underline = /underline/.test(value);
    else if (prop === 'text-align') look.align = value === 'right' || value === 'end' ? 'right' : value === 'center' ? 'center' : null;
    else if (prop === 'margin-left' || prop === 'padding-left' || prop === 'margin-inline-start' || prop === 'padding-inline-start') look.indent = Math.max(look.indent ?? 0, indentStep(value));
    else if (prop === 'margin') {
      // margin: top right bottom left — the left one is the 4th, or the 2nd when there are 2 or 3
      const values = value.split(/\s+/);
      const left = values.length === 4 ? values[3] : values.length >= 2 ? values[1] : values[0];
      look.indent = Math.max(look.indent ?? 0, indentStep(left));
    } else if (prop === 'font') {
      if (/\b(italic|oblique)\b/.test(value)) look.italic = true;
      if (/\b(bold|bolder|[6-9]00)\b/.test(value)) look.bold = true;
    }
  }
  return look;
}

/**
 * A stylesheet's rules for classes: Map class → look. Only simple selectors count: ".x", "p.x",
 * "span.x", lists of them; anything with combinators or pseudo-classes is left out.
 */
export function parseBookCss(css, into = new Map()) {
  const text = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{([\s\S]*?\})\s*\}/g, '$1');
  const rule = /([^{}@]+)\{([^{}]*)\}/g;
  for (const m of text.matchAll(rule)) {
    const look = lookOfDeclarations(m[2]);
    if (!Object.keys(look).length) continue;
    for (const raw of m[1].split(',')) {
      const sel = raw.trim();
      const one = /^(?:[a-z][a-z0-9]*)?\.([\w-]+)$/i.exec(sel);
      if (!one) continue;
      into.set(one[1], { ...(into.get(one[1]) ?? {}), ...look });
    }
  }
  return into;
}

/** The look of an element: its classes' rules, then its own style="" over them. */
export function lookOf(attrs, rules) {
  let look = null;
  const add = (part) => {
    if (part && Object.keys(part).length) look = { ...(look ?? EMPTY), ...part };
  };
  if (rules?.size && attrs.class) for (const cls of String(attrs.class).split(/\s+/)) add(rules.get(cls));
  if (attrs.style) add(lookOfDeclarations(attrs.style));
  return look;
}

/** The reader's classes for a block's look: "ta-right in-2". */
export function blockClasses(look) {
  if (!look) return '';
  return [look.align === 'right' ? 'ta-right' : look.align === 'center' ? 'ta-center' : '', look.indent ? `in-${look.indent}` : ''].filter(Boolean).join(' ');
}
