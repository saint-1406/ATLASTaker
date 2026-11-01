// Changing a PDF: pages turned, removed, moved or brought in from another PDF, and a copy of the file
// with the reader's marks written in as real PDF highlights (with the comment as the note), so other
// PDF programs show them too. pdf-lib writes; pdf.js (already here for reading) measures pages.

import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, degrees } from 'pdf-lib';
import { closeDoc, loadPdf } from './pdf.js';

const COLORS = { yellow: [1, 0.84, 0.16], green: [0.36, 0.84, 0.47], blue: [0.38, 0.64, 1], pink: [1, 0.45, 0.75] };

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
export async function pdfWithMarks(bytes, marks, { author = 'ATLAS' } = {}) {
  const shown = await loadPdf(bytes);
  try {
    const pdf = await loadForEdit(bytes);
    const pages = pdf.getPages();
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
