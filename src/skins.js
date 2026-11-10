// Two looks share one app: "minimal" (the default) and "atlas" (the cartographic one). Each look has
// its own words for the same things (see `look` in i18n.js): on a map, "saved" reads «Нанесено на карту».
//
// A theme is a tone (light or dark, what the CSS keys most rules on) and, for some, a palette laid
// over it: sepia paper for long reading, dusk for the evening, night (true black for OLED screens,
// warm dim text), contrast for eyes that need it. The atlas look keeps its own palette and takes
// only the tone.

// cozy: warm paper, a violet accent, serif titles, soft round cards (0.13); the default since then
export const SKINS = ['cozy', 'minimal', 'atlas'];
export const THEMES = ['cream', 'dark', 'light', 'sepia', 'dusk', 'night', 'contrast', 'system'];
export const ACCENTS = ['lime', 'cyan', 'orange', 'violet'];
/** Palette → the tone it sits on. */
export const PALETTES = { cream: 'light', sepia: 'light', dusk: 'dark', night: 'dark', contrast: 'dark' };

export const DEFAULT_LOOK = { skin: 'cozy', theme: 'cream', accent: 'violet' };

/** The look every install is moved to once, when it first runs 0.13 (lookVersion in the app's state). */
export const LOOK_VERSION = 13;

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
/** How fast pages turn: 1 is as designed, 2 twice as fast, 0.5 half as fast. */
export const TURN_SPEED = { min: 0.5, max: 2 };

// ---------- reading themes: colours, a font and a layout, laid over the reader only ----------
//
// Each theme is a palette (styles.css: .reader[data-rtheme]) with its own font; the person can
// change its font and, with "custom" on, its spacing and margins. A theme that differs from how it
// came is "modified" and wears a star on its card. "app" follows the app's own theme.

export const READ_THEMES = ['app', 'paper', 'light', 'dusk', 'night', 'contrast'];
/** The themes that sit on a light page: the ones the auto-dark switch trades for night. */
export const LIGHT_READ_THEMES = ['paper', 'light'];
export const READ_FONTS = ['literata', 'garamond', 'georgia', 'inter', 'system', 'mono'];
export const FONT_STACKS = {
  literata: '"Literata Variable", "Literata", Georgia, serif',
  garamond: '"Cormorant Garamond", Garamond, Georgia, serif',
  georgia: 'Georgia, "Palatino Linotype", Palatino, "Noto Serif", serif',
  inter: '"Inter Variable", "Segoe UI", system-ui, sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: '"JetBrains Mono Variable", "JetBrains Mono", Consolas, monospace',
};
/** Slider limits: line height as a factor, the rest in per cent. */
export const LAYOUT_RANGES = {
  leading: { min: 1.2, max: 2.4, step: 0.05 },
  letter: { min: -10, max: 30, step: 1 },
  word: { min: -20, max: 100, step: 2 },
  margin: { min: -50, max: 100, step: 5 },
};
const LAYOUT = { leading: 1.7, letter: 0, word: 0, margin: 0, justify: false };
export const READ_THEME_DEFAULTS = {
  app: { font: 'literata', bold: false, custom: false, ...LAYOUT },
  paper: { font: 'literata', bold: false, custom: false, ...LAYOUT, leading: 1.75 },
  light: { font: 'georgia', bold: false, custom: false, ...LAYOUT, leading: 1.6 },
  dusk: { font: 'inter', bold: false, custom: false, ...LAYOUT, leading: 1.65 },
  night: { font: 'literata', bold: false, custom: false, ...LAYOUT },
  contrast: { font: 'inter', bold: true, custom: false, ...LAYOUT, letter: 2 },
};
// what the "custom" switch holds; justify and the font are the theme's own choice either way
const LAYOUT_KEYS = ['leading', 'letter', 'word', 'margin'];
export const BRIGHTNESS = { min: 0.3, max: 1 };

export const DEFAULT_READ_LOOK = { theme: 'app', auto: false, bright: 1, themes: {} };

const clamp = (v, { min, max }) => Math.min(max, Math.max(min, v));
const roundTo = (v, step) => Math.round(Math.round(v / step) * step * 100) / 100;

/** One theme's saved changes: only known keys, only values that differ from how it came. */
function cleanStyle(id, saved) {
  const base = READ_THEME_DEFAULTS[id];
  const out = {};
  if (!saved || typeof saved !== 'object') return out;
  if (READ_FONTS.includes(saved.font)) out.font = saved.font;
  for (const key of ['bold', 'custom', 'justify']) if (typeof saved[key] === 'boolean') out[key] = saved[key];
  for (const [key, range] of Object.entries(LAYOUT_RANGES)) {
    if (Number.isFinite(saved[key])) out[key] = roundTo(clamp(saved[key], range), range.step);
  }
  for (const key of Object.keys(out)) if (out[key] === base[key]) delete out[key];
  return out;
}

export function normalizeReadLook(saved = {}) {
  const look = saved && typeof saved === 'object' ? saved : {};
  const themes = {};
  for (const id of READ_THEMES) {
    const style = cleanStyle(id, look.themes?.[id]);
    if (Object.keys(style).length) themes[id] = style;
  }
  return {
    theme: READ_THEMES.includes(look.theme) ? look.theme : DEFAULT_READ_LOOK.theme,
    auto: typeof look.auto === 'boolean' ? look.auto : DEFAULT_READ_LOOK.auto,
    bright: Number.isFinite(look.bright) ? Math.round(clamp(look.bright, BRIGHTNESS) * 100) / 100 : DEFAULT_READ_LOOK.bright,
    themes,
  };
}

/** Everything a theme shows: how it came, with the person's changes; spacing only while "custom" is on. */
export function themeStyle(look, id) {
  const base = READ_THEME_DEFAULTS[id] ?? READ_THEME_DEFAULTS.app;
  const style = { ...base, ...(look.themes?.[id] ?? {}) };
  if (!style.custom) for (const key of LAYOUT_KEYS) style[key] = base[key];
  return style;
}

export const isModified = (look, id) => Object.keys(look.themes?.[id] ?? {}).length > 0;

/** The theme on screen: auto-dark trades a light page for night while the system is dark. */
export function shownTheme(look, systemDark = false) {
  return look.auto && systemDark && LIGHT_READ_THEMES.includes(look.theme) ? 'night' : look.theme;
}

/** A theme's style as CSS custom properties for the reader (styles.css reads them on .reader-book). */
export function styleVars(style) {
  const garamond = style.font === 'garamond';
  return {
    '--rd-font': FONT_STACKS[style.font] ?? FONT_STACKS.literata,
    '--rd-weight': style.bold ? (garamond ? '700' : '600') : garamond ? '500' : '400',
    '--rd-leading': String(style.leading),
    '--rd-letter': String(style.letter),
    '--rd-word': String(style.word),
    '--rd-margin': String(style.margin),
    '--rd-align': style.justify ? 'justify' : 'start',
  };
}

/** Earlier versions kept one font and one line spacing for every book: they become the app theme's changes. */
function fromOldReading(saved) {
  const app = {};
  if (saved.readFont === 'sans') app.font = 'inter';
  if (saved.readLeading === 'tight' || saved.readLeading === 'loose') Object.assign(app, { custom: true, leading: saved.readLeading === 'tight' ? 1.5 : 1.95 });
  return normalizeReadLook({ themes: { app } });
}

export const DEFAULT_READING = { readMode: 'scroll', readTurn: 'flip', readSpeed: 1, readLook: DEFAULT_READ_LOOK };

export function normalizeReading(saved = {}) {
  const pick = (key, list) => (list.includes(saved[key]) ? saved[key] : DEFAULT_READING[key]);
  return {
    readMode: pick('readMode', READ_MODES),
    readTurn: pick('readTurn', TURNS),
    readSpeed: Number.isFinite(saved.readSpeed) ? Math.round(Math.min(TURN_SPEED.max, Math.max(TURN_SPEED.min, saved.readSpeed)) * 100) / 100 : 1,
    readLook: saved.readLook ? normalizeReadLook(saved.readLook) : fromOldReading(saved),
  };
}
