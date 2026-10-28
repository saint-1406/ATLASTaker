// PDF through pdf.js (the legacy build: it carries its own polyfills, so older Android WebViews read
// it too). Pages are laid out at once as empty frames and drawn only near the view; pages far away
// give their canvases back, so a 500-page book fits in a phone's memory. A transparent text layer
// over each page makes the words selectable, for quotes.

import { AnnotationMode, getDocument, PDFWorker, TextLayer } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerSource from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';

let worker = null;

// One worker for every document, started from the bundle itself (a blob: URL), so no file has to
// be served next to it. Handed to each document explicitly, so closing one does not stop it.
function sharedWorker() {
  if (!worker) {
    const port = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));
    worker = new PDFWorker({ port });
  }
  return worker;
}

function loadPdf(bytes) {
  // pdf.js takes the buffer over: hand it a copy
  return getDocument({ data: bytes.slice(), worker: sharedWorker(), useSystemFonts: true, enableXfa: false, stopAtErrors: false }).promise;
}

const closeDoc = (doc) => doc.loadingTask.destroy().catch(() => {});

// "Microsoft Word - report.docx", "untitled" and the like are not titles
const NOT_A_TITLE = /^(microsoft (word|powerpoint|excel) - |untitled|document\d*$|slide \d+$)|\.(docx?|pptx?|xlsx?|pdf|tex|indd)$/i;
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Title, author, page count and a small picture of the first page. */
export async function pdfInfo(bytes, coverWidth = 240) {
  const doc = await loadPdf(bytes);
  try {
    const meta = await doc.getMetadata().catch(() => null);
    const title = clean(meta?.info?.Title);
    let cover = null;
    try {
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: coverWidth / page.getViewport({ scale: 1 }).width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, annotationMode: AnnotationMode.DISABLE }).promise;
      cover = canvas.toDataURL('image/jpeg', 0.8);
    } catch {
      // no picture: the card shows the format instead
    }
    return { title: NOT_A_TITLE.test(title) ? '' : title, author: clean(meta?.info?.Author), pages: doc.numPages, cover };
  } finally {
    closeDoc(doc);
  }
}

export async function openPdf(host, bytes, { position, scale = 1, onPosition } = {}) {
  const doc = await loadPdf(bytes);
  const first = (await doc.getPage(1)).getViewport({ scale: 1 });
  const wrap = document.createElement('div');
  wrap.className = 'reader-pdf';
  wrap.style.setProperty('--pdf-zoom', String(scale));
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const frame = document.createElement('div');
    frame.className = 'pdf-page';
    frame.dataset.page = String(i);
    frame.style.aspectRatio = `${first.width} / ${first.height}`;
    pages.push(frame);
    wrap.append(frame);
  }
  host.replaceChildren(wrap);

  const drawn = new Map(); // page number → { width, canvas, text, task, layer, cancelled }
  const near = new Set();

  function release(n) {
    const entry = drawn.get(n);
    if (!entry) return;
    entry.cancelled = true;
    entry.task?.cancel();
    entry.layer?.cancel();
    if (entry.canvas) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
      entry.canvas.remove();
    }
    entry.text?.remove();
    drawn.delete(n);
  }

  async function draw(n) {
    const frame = pages[n - 1];
    const width = frame.clientWidth;
    if (!width || Math.abs((drawn.get(n)?.width ?? -10) - width) < 2) return;
    release(n);
    const entry = { width, cancelled: false };
    drawn.set(n, entry);
    try {
      const page = await doc.getPage(n);
      if (entry.cancelled) return;
      const base = page.getViewport({ scale: 1 });
      frame.style.aspectRatio = `${base.width} / ${base.height}`;
      const cssScale = width / base.width;
      const ratio = Math.min(window.devicePixelRatio || 1, innerWidth < 700 ? 1.75 : 2);
      const viewport = page.getViewport({ scale: cssScale * ratio });
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      entry.canvas = canvas;
      frame.append(canvas);
      entry.task = page.render({ canvasContext: canvas.getContext('2d'), viewport, annotationMode: AnnotationMode.DISABLE });
      await entry.task.promise;
      if (entry.cancelled) return;
      const text = document.createElement('div');
      text.className = 'textLayer';
      frame.style.setProperty('--total-scale-factor', String(cssScale));
      entry.text = text;
      frame.append(text);
      entry.layer = new TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: page.getViewport({ scale: cssScale }) });
      await entry.layer.render();
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException' && !entry.cancelled) console.warn(`pdf page ${n}:`, err);
    }
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const n = Number(e.target.dataset.page);
        if (e.isIntersecting) {
          near.add(n);
          draw(n);
        } else {
          near.delete(n);
          release(n);
        }
      }
    },
    { root: host, rootMargin: '120% 0px' },
  );
  pages.forEach((frame) => observer.observe(frame));

  const viewTop = () => host.getBoundingClientRect().top;
  function current() {
    const top = viewTop() + 1;
    let lo = 0;
    let hi = pages.length - 1;
    let found = pages.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pages[mid].getBoundingClientRect().bottom > top) {
        found = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    const r = pages[found].getBoundingClientRect();
    return { page: found + 1, frac: Math.round(Math.max(0, Math.min(1, (viewTop() - r.top) / r.height)) * 1000) / 1000 };
  }
  function restore(pos) {
    const frame = pos && pages[pos.page - 1];
    if (!frame) return;
    const r = frame.getBoundingClientRect();
    host.scrollTop += r.top - viewTop() + (pos.frac || 0) * r.height;
  }
  const progress = () => {
    const { page, frac } = current();
    return Math.min(1, (page - 1 + frac) / pages.length);
  };
  const goToPage = (index) => {
    const frame = pages[index];
    if (frame) host.scrollTop += frame.getBoundingClientRect().top - viewTop();
  };

  restore(position);
  let timer = 0;
  const onScroll = () => {
    clearTimeout(timer);
    timer = setTimeout(() => onPosition?.(current(), progress()), 300);
  };
  host.addEventListener('scroll', onScroll, { passive: true });

  const toc = [];
  try {
    const walk = (items, level) => {
      for (const item of items ?? []) {
        toc.push({
          level,
          text: clean(item.title).slice(0, 160),
          async go() {
            let dest = item.dest;
            if (typeof dest === 'string') dest = await doc.getDestination(dest);
            if (!Array.isArray(dest)) return;
            goToPage(typeof dest[0] === 'object' ? await doc.getPageIndex(dest[0]) : dest[0]);
          },
        });
        walk(item.items, level + 1);
      }
    };
    walk(await doc.getOutline(), 1);
  } catch {
    // no outline
  }
  if (!toc.length && pages.length > 1) {
    // no outline: a page list, thinned out for long files, so a long file can still be crossed quickly
    const step = pages.length > 60 ? 10 : pages.length > 20 ? 5 : 1;
    for (let i = 0; i < pages.length; i += step) toc.push({ level: 1, page: i + 1, go: () => goToPage(i) });
  }

  let rezoom = 0;
  return {
    kind: 'pdf',
    pages: pages.length,
    toc,
    position: current,
    progress,
    setScale(value) {
      const pos = current();
      wrap.style.setProperty('--pdf-zoom', String(value));
      restore(pos);
      clearTimeout(rezoom);
      rezoom = setTimeout(() => near.forEach(draw), 180);
    },
    where(node) {
      const target = node?.nodeType === 1 ? node : node?.parentElement;
      return { page: Number(target?.closest('.pdf-page')?.dataset.page) || current().page };
    },
    close() {
      observer.disconnect();
      host.removeEventListener('scroll', onScroll);
      clearTimeout(timer);
      clearTimeout(rezoom);
      [...drawn.keys()].forEach(release);
      closeDoc(doc);
      host.replaceChildren();
    },
  };
}
