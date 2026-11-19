// How the shelf shows a series (Settings → Library): as a folder with its books standing in it, or as
// the books alone, fanned like a bouquet; and how big that bouquet is (2, 3 or 5 covers). Kept on this
// device, as the motion switch is: a phone and a PC may want it differently. Only attributes on <html>
// (data-folders, data-bouquet) change, styles.css does the rest: the shelf is not drawn again.

const KEY = 'atlas-shelf-look';
export const BOUQUET_SIZES = ['s', 'm', 'l'];
/** The most covers a series card carries; the bouquet size shows 2, 3 or all of them. */
export const BOUQUET_MOST = 5;

const DEFAULT = { folders: true, bouquet: 'm' };

function read() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      folders: saved.folders !== false,
      bouquet: BOUQUET_SIZES.includes(saved.bouquet) ? saved.bouquet : DEFAULT.bouquet,
    };
  } catch {
    return { ...DEFAULT };
  }
}

let look = read();
apply();

function apply() {
  const root = document.documentElement;
  root.dataset.folders = look.folders ? 'on' : 'off';
  root.dataset.bouquet = look.bouquet;
}

export const shelfLook = () => ({ ...look });

/** The person's choice: { folders } and/or { bouquet: 's' | 'm' | 'l' }. */
export function setShelfLook(patch) {
  look = { ...look, ...patch };
  if (!BOUQUET_SIZES.includes(look.bouquet)) look.bouquet = DEFAULT.bouquet;
  look.folders = look.folders !== false;
  apply();
  try {
    if (look.folders === DEFAULT.folders && look.bouquet === DEFAULT.bouquet) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(look));
  } catch {
    // only a convenience
  }
}
