// Changing a PDF: pages turned, removed, moved or brought in from another PDF, and a copy of the file
// with the reader's marks written in as real PDF highlights (with the comment as the note), so other
// PDF programs show them too. pdf-lib writes; pdf.js (already here for reading) measures pages.

import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, degrees, rgb } from 'pdf-lib';
import { closeDoc, loadPdf } from './pdf.js';
import { fontBytes, readerBase } from './pdffonts.js';

/** fontkit, from its own script the first time it is needed (the browser build has it in the page). */
let fontkitCode = null;
function loadFontkit() {
  if (window.AtlasFontkit) return Promise.resolve(window.AtlasFontkit);
  fontkitCode ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('fontkit.js', readerBase).href;
    script.onload = () => (window.AtlasFontkit ? resolve(window.AtlasFontkit) : reject(new Error('fontkit')));
    script.onerror = () => {
      fontkitCode = null;
      script.remove();
      reject(new Error('fontkit'));
    };
    document.head.append(script);
  });
  return fontkitCode;
}

const rgbOf = (hex) => rgb(...hex.match(/\w\w/g).map((h) => parseInt(h, 16) / 255));

/**
 * The document with rewritten lines written into its pages: each old line covered with the page's
 * colour, the new words drawn over it as real text (in Noto, only the letters used), so they can be
 * selected and found. The old words stay under the cover: this is not for hiding secrets.
 */
export async function applyEdits(bytes, edits) {
  const live = edits.filter((e) => e && Number.isInteger(e.page));
  if (!live.length) return bytes;
  const shown = await loadPdf(bytes);
  try {
    const pdf = await loadForEdit(bytes);
    pdf.registerFontkit(await loadFontkit());
    const fonts = new Map();
    const fontFor = async (e) => {
      const key = `${e.font}:${e.bold}`;
      // the whole font: pdf-lib's subsets lose letters in some viewers
      if (!fonts.has(key)) fonts.set(key, pdf.embedFont(await fontBytes(e.font, e.bold), { subset: false }));
      return fonts.get(key);
    };
    const pages = pdf.getPages();
    for (const e of live) {
      const page = pages[e.page - 1];
      if (!page) continue;
      const viewport = (await shown.getPage(e.page)).getViewport({ scale: 1 });
      const vw = viewport.width;
      const vh = viewport.height;
      const toPdf = (fx, fy) => viewport.convertToPdfPoint(fx * vw, fy * vh);
      // the cover, as in the reader (pdf.js coverOf)
      const cx = e.x - e.size * 0.08;
      const cw = e.w + e.size * 0.16;
      const corners = [toPdf(cx, e.y), toPdf(cx + cw, e.y), toPdf(cx, e.y + e.h), toPdf(cx + cw, e.y + e.h)];
      const xs = corners.map((p) => p[0]);
      const ys = corners.map((p) => p[1]);
      page.drawRectangle({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), color: rgbOf(e.bg) });
      if (!e.text) continue;
      // the words run left to right as the page is shown, whatever the page's own rotation
      const [px, py] = toPdf(e.x, e.base);
      const [qx, qy] = toPdf(e.x + 0.1, e.base);
      const angle = (Math.atan2(qy - py, qx - px) * 180) / Math.PI;
      page.drawText(e.text, { x: px, y: py, size: e.size * vw, font: await fontFor(e), color: rgbOf(e.ink), rotate: degrees(angle) });
    }
    return await pdf.save();
  } finally {
    closeDoc(shown);
  }
}

const COLORS = { yellow: [1, 0.84, 0.16], green: [0.36, 0.84, 0.47], blue: [0.38, 0.64, 1], pink: [1, 0.45, 0.75] };

const TEXT_INK = { black: '#1a1a1a', red: '#d32f2f', blue: '#1e5bd8', green: '#1f8a3b' };
const TEXT_FONT = "'Inter Variable', Arial, sans-serif";
const LINE = 1.25; // line height, as in .pdf-text

/** The lines a text breaks into at a width, as the page shows it (pre-wrap, long words broken anywhere). */
export function wrapLines(text, width, measure) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(/(?<=\s)/)) {
      if (measure(line + word.trimEnd()) <= width || !line) {
        line += word;
      } else {
        lines.push(line.trimEnd());
        line = word;
      }
      // a word wider than the box breaks letter by letter
      while (measure(line.trimEnd()) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut)) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/**
 * One text as a PDF free-text annotation: the words in its Contents (other programs can read and edit
 * them), and its look drawn as a picture, so any script shows the same in every viewer without a font.
 */
async function addText(pdf, page, viewport, item, author) {
  const k = 4; // picture pixels per page point
  const fontPx = item.size * viewport.width * k;
  const font = `${fontPx}px ${TEXT_FONT}`;
  await document.fonts?.load(font).catch(() => {});
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  const width = Math.max(1, Math.round(item.w * viewport.width * k));
  const lines = wrapLines(item.text, width, (s) => ctx.measureText(s).width);
  const lineH = fontPx * LINE;
  canvas.width = width;
  canvas.height = Math.max(1, Math.ceil(lines.length * lineH));
  ctx.font = font;
  ctx.fillStyle = TEXT_INK[item.color] ?? TEXT_INK.black;
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => ctx.fillText(line, 0, (i + 0.5) * lineH));
  const png = new Uint8Array(await (await new Promise((done) => canvas.toBlob(done, 'image/png'))).arrayBuffer());
  const image = await pdf.embedPng(png);

  // the box on the page as shown → the page's own coordinates (rotation and crop box included)
  const X = item.x * viewport.width;
  const Y = item.y * viewport.height;
  const W = canvas.width / k;
  const H = canvas.height / k;
  const p00 = viewport.convertToPdfPoint(X, Y + H); // the picture's bottom left
  const p10 = viewport.convertToPdfPoint(X + W, Y + H);
  const p01 = viewport.convertToPdfPoint(X, Y);
  const p11 = viewport.convertToPdfPoint(X + W, Y);
  const xs = [p00[0], p10[0], p01[0], p11[0]];
  const ys = [p00[1], p10[1], p01[1], p11[1]];
  const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const m = [p10[0] - p00[0], p10[1] - p00[1], p01[0] - p00[0], p01[1] - p00[1], p00[0], p00[1]].map((v) => v.toFixed(3)).join(' ');
  const appearance = pdf.context.stream(`q ${m} cm /Im0 Do Q`, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: rect,
    Resources: { XObject: { Im0: image.ref } },
  });
  const rgb = (TEXT_INK[item.color] ?? TEXT_INK.black).match(/\w\w/g).map((h) => (parseInt(h, 16) / 255).toFixed(3));
  const annot = pdf.context.obj({
    Type: 'Annot',
    Subtype: 'FreeText',
    Rect: rect,
    F: 4,
    NM: PDFString.of(item.id),
    T: PDFHexString.fromText(author),
    Contents: PDFHexString.fromText(item.text),
    DA: PDFString.of(`/Helv ${(item.size * viewport.width).toFixed(1)} Tf ${rgb.join(' ')} rg`),
    M: PDFString.fromDate(new Date(item.edited || item.created)),
    AP: { N: pdf.context.register(appearance) },
  });
  const ref = pdf.context.register(annot);
  const annots = page.node.lookup(PDFName.of('Annots'));
  if (annots && typeof annots.push === 'function') annots.push(ref);
  else page.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
}

async function loadForEdit(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    if (/encrypt/i.test(err.message)) throw Object.assign(new Error('encrypted'), { encrypted: true });
    throw err;
  }
}

/** For the page editor: the page count and small pictures of the pages, drawn on demand. */
export async function openPages(bytes) {
  const doc = await loadPdf(bytes);
  return {
    count: doc.numPages,
    async thumbnail(n, width = 150) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: width / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      return canvas;
    },
    close: () => closeDoc(doc),
  };
}

/**
 * sources: the PDFs the pages come from (0 is the document itself); plan: the new pages in order,
 * [{ src, page (1-based), turn (degrees clockwise) }]. Resolves to the bytes of the new PDF.
 */
export async function rebuildPdf(sources, plan) {
  if (!plan.length) throw new Error('no pages');
  const loaded = await Promise.all(sources.map(loadForEdit));
  const out = await PDFDocument.create();
  const main = loaded[0];
  const title = main.getTitle();
  const author = main.getAuthor();
  if (title) out.setTitle(title);
  if (author) out.setAuthor(author);
  out.setProducer('ATLAS Notetaker');
  // copy each source's pages in one go (shared fonts and pictures are copied once)
  const wanted = new Map(); // src → sorted unique page indexes
  for (const p of plan) (wanted.get(p.src) ?? wanted.set(p.src, new Set()).get(p.src)).add(p.page - 1);
  const copies = new Map(); // `${src}:${index}` → copied page
  for (const [src, set] of wanted) {
    const indexes = [...set].sort((a, b) => a - b);
    const pages = await out.copyPages(loaded[src], indexes);
    indexes.forEach((index, i) => copies.set(`${src}:${index}`, pages[i]));
  }
  const used = new Set();
  for (const p of plan) {
    const key = `${p.src}:${p.page - 1}`;
    // the same page twice: a second copy
    const page = used.has(key) ? (await out.copyPages(loaded[p.src], [p.page - 1]))[0] : copies.get(key);
    used.add(key);
    const turn = ((p.turn || 0) % 360 + 360) % 360;
    if (turn) page.setRotation(degrees((page.getRotation().angle + turn) % 360));
    out.addPage(page);
  }
  return out.save();
}

/**
 * The document with its marks as PDF highlight annotations: one per mark, the comment as its text.
 * The boxes are fractions of the page as shown, so pdf.js turns them into the page's own coordinates
 * (rotation and crop box included).
 */
export async function pdfWithMarks(bytes, marks, { author = 'ATLAS', texts = [] } = {}) {
  const shown = await loadPdf(bytes);
  try {
    const pdf = await loadForEdit(bytes);
    const pages = pdf.getPages();
    for (const item of texts) {
      const page = pages[item.page - 1];
      if (!page || !item.text.trim()) continue;
      await addText(pdf, page, (await shown.getPage(item.page)).getViewport({ scale: 1 }), item, author);
    }
    for (const mark of marks) {
      const byPage = new Map();
      for (const [n, ...box] of mark.anchor?.rects ?? []) (byPage.get(n) ?? byPage.set(n, []).get(n)).push(box);
      for (const [n, boxes] of byPage) {
        const page = pages[n - 1];
        if (!page) continue;
        const viewport = (await shown.getPage(n)).getViewport({ scale: 1 });
        const quads = [];
        let rect = null;
        let paint = '';
        for (const [x, y, w, h] of boxes) {
          const [ax, ay] = viewport.convertToPdfPoint(x * viewport.width, y * viewport.height);
          const [bx, by] = viewport.convertToPdfPoint((x + w) * viewport.width, (y + h) * viewport.height);
          const [x1, x2, y1, y2] = [Math.min(ax, bx), Math.max(ax, bx), Math.min(ay, by), Math.max(ay, by)];
          quads.push(x1, y2, x2, y2, x1, y1, x2, y1);
          rect = rect ? [Math.min(rect[0], x1), Math.min(rect[1], y1), Math.max(rect[2], x2), Math.max(rect[3], y2)] : [x1, y1, x2, y2];
          paint += `${x1.toFixed(2)} ${y1.toFixed(2)} ${(x2 - x1).toFixed(2)} ${(y2 - y1).toFixed(2)} re f\n`;
        }
        if (!rect) continue;
        const color = COLORS[mark.color] ?? COLORS.yellow;
        // the look, for viewers that do not draw highlights themselves: the boxes, multiplied over the page
        const gs = pdf.context.obj({ Type: 'ExtGState', BM: 'Multiply', ca: 0.45, CA: 0.45 });
        const appearance = pdf.context.stream(`q /GS0 gs ${color.map((c) => c.toFixed(3)).join(' ')} rg\n${paint}Q`, {
          Type: 'XObject',
          Subtype: 'Form',
          BBox: rect,
          Resources: { ExtGState: { GS0: pdf.context.register(gs) } },
        });
        const annot = pdf.context.obj({
          Type: 'Annot',
          Subtype: 'Highlight',
          Rect: rect,
          QuadPoints: quads,
          C: color,
          CA: PDFNumber.of(0.45),
          F: 4,
          NM: PDFString.of(mark.id),
          T: PDFHexString.fromText(author),
          Contents: PDFHexString.fromText(mark.note || ''),
          M: PDFString.fromDate(new Date(mark.edited || mark.created)),
          AP: { N: pdf.context.register(appearance) },
        });
        const ref = pdf.context.register(annot);
        const annots = page.node.lookup(PDFName.of('Annots'));
        if (annots && typeof annots.push === 'function') annots.push(ref);
        else page.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
      }
    }
    return await pdf.save();
  } finally {
    closeDoc(shown);
  }
}
