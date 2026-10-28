// Two looks share one app: "minimal" (the default) and "atlas" (the cartographic one). Each look has
// its own words for the same things (see `look` in i18n.js): on a map, "saved" reads «Нанесено на карту».
//
// A theme is a tone (light or dark, what the CSS keys most rules on) and, for some, a palette laid
// over it: sepia paper for long reading, dusk for the evening, night (true black for OLED screens,
// warm dim text), contrast for eyes that need it. The atlas look keeps its own palette and takes
// only the tone.

export const SKINS = ['minimal', 'atlas'];
export const THEMES = ['dark', 'light', 'sepia', 'dusk', 'night', 'contrast', 'system'];
export const ACCENTS = ['lime', 'cyan', 'orange', 'violet'];
/** Palette → the tone it sits on. */
export const PALETTES = { sepia: 'light', dusk: 'dark', night: 'dark', contrast: 'dark' };

export const DEFAULT_LOOK = { skin: 'minimal', theme: 'dark', accent: 'lime' };

/** Keeps only known values, falling back to the defaults. */
export function normalizeLook(saved = {}) {
  return {
    skin: SKINS.includes(saved.skin) ? saved.skin : DEFAULT_LOOK.skin,
    theme: THEMES.includes(saved.theme) ? saved.theme : DEFAULT_LOOK.theme,
    accent: ACCENTS.includes(saved.accent) ? saved.accent : DEFAULT_LOOK.accent,
  };
}

/** "light" or "dark" for a theme; "system" follows the operating system. */
export function toneOf(theme, systemDark = true) {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return PALETTES[theme] ?? (theme === 'light' ? 'light' : 'dark');
}

// ---------- how the reader shows a book ----------

export const READ_MODES = ['scroll', 'pages'];
/** Page turns: a book page over its spine, a slide, a stack of cards, a fade, or none at all. */
export const TURNS = ['flip', 'slide', 'stack', 'fade', 'none'];
export const READ_FONTS = ['serif', 'sans'];
export const LEADINGS = ['tight', 'normal', 'loose'];

export const DEFAULT_READING = { readMode: 'scroll', readTurn: 'flip', readFont: 'serif', readLeading: 'normal' };

export function normalizeReading(saved = {}) {
  const pick = (key, list) => (list.includes(saved[key]) ? saved[key] : DEFAULT_READING[key]);
  return {
    readMode: pick('readMode', READ_MODES),
    readTurn: pick('readTurn', TURNS),
    readFont: pick('readFont', READ_FONTS),
    readLeading: pick('readLeading', LEADINGS),
  };
}
