// Two looks share one app: "minimal" (the default) and "atlas" (the cartographic one). Each look has
// its own words for the same things (see `look` in i18n.js): on a map, "saved" reads «Нанесено на карту».

export const SKINS = ['minimal', 'atlas'];
export const THEMES = ['dark', 'light', 'system'];
export const ACCENTS = ['lime', 'cyan', 'orange', 'violet'];

export const DEFAULT_LOOK = { skin: 'minimal', theme: 'dark', accent: 'lime' };

/** Keeps only known values, falling back to the defaults. */
export function normalizeLook(saved = {}) {
  return {
    skin: SKINS.includes(saved.skin) ? saved.skin : DEFAULT_LOOK.skin,
    theme: THEMES.includes(saved.theme) ? saved.theme : DEFAULT_LOOK.theme,
    accent: ACCENTS.includes(saved.accent) ? saved.accent : DEFAULT_LOOK.accent,
  };
}
