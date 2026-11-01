// Fonts for rewritten lines of a PDF: the same files show the new words over the page (as CSS font
// faces) and go into the PDF when the edits are written (pdf-lib with fontkit, only the letters used).
// Noto has Latin and Cyrillic. The files are fetched the first time they are needed.

import sansRegular from '@expo-google-fonts/noto-sans/400Regular/NotoSans_400Regular.ttf';
import sansBold from '@expo-google-fonts/noto-sans/700Bold/NotoSans_700Bold.ttf';
import serifRegular from '@expo-google-fonts/noto-serif/400Regular/NotoSerif_400Regular.ttf';
import serifBold from '@expo-google-fonts/noto-serif/700Bold/NotoSerif_700Bold.ttf';
import monoRegular from '@expo-google-fonts/noto-sans-mono/400Regular/NotoSansMono_400Regular.ttf';

// paths are relative to the reader's own script (dist/reader.js); the browser build has data: URLs
export const readerBase = document.currentScript?.src || location.href;
const FILES = { sans: [sansRegular, sansBold], serif: [serifRegular, serifBold], mono: [monoRegular, monoRegular] };

export const FAMILY = { sans: 'ATLAS Edit Sans', serif: 'ATLAS Edit Serif', mono: 'ATLAS Edit Mono' };
export const familyOf = (font) => `'${FAMILY[font] ?? FAMILY.sans}', ${font === 'serif' ? 'serif' : font === 'mono' ? 'monospace' : 'sans-serif'}`;

const urlOf = (font, bold) => new URL((FILES[font] ?? FILES.sans)[bold ? 1 : 0], readerBase).href;

const bytes = new Map();
/** The font file, as bytes for pdf-lib. */
export function fontBytes(font, bold) {
  const url = urlOf(font, bold);
  if (!bytes.has(url)) {
    bytes.set(
      url,
      // a data: URL (the browser build, which may not fetch at all) is read in place
      url.startsWith('data:')
        ? Promise.resolve(Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (c) => c.charCodeAt(0)).buffer)
        : fetch(url).then((res) => {
            if (!res.ok) throw new Error(`font ${res.status}`);
            return res.arrayBuffer();
          }),
    );
    bytes.get(url).catch(() => bytes.delete(url));
  }
  return bytes.get(url);
}

let faces = null;
/** The fonts as CSS faces, so the page shows new words as the file will have them. */
export function loadFaces() {
  faces ??= Promise.all(
    Object.entries(FAMILY).flatMap(([font, family]) =>
      [false, true].map(async (bold) => {
        try {
          const face = new FontFace(family, `url(${urlOf(font, bold)})`, { weight: bold ? '700' : '400' });
          document.fonts.add(await face.load());
        } catch {
          // the page falls back to a system font of the same kind
        }
      }),
    ),
  );
  return faces;
}
