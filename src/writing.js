// How much was written, day by day, for the writing statistics: characters typed in (the heat map of
// the days) and how much the text grew, typed less deleted (today, the week, the month). Two logs in the
// app's state, { 'YYYY-MM-DD': number }: writeDays and growDays (merged between devices: sync/merge.js).

import { dayKey } from './home.js';

export const KEEP_DAYS = 400;

/**
 * Adds to today's two numbers: characters written (typed, pasted, dictated) and how much the text grew
 * (anything the person did, undoing included, so it can be less than nothing); keeps the last KEEP_DAYS.
 */
export function noteWriting(log, written, grown, date = new Date()) {
  const key = dayKey(date);
  const write = { ...(log.writeDays ?? {}) };
  const grow = { ...(log.growDays ?? {}) };
  write[key] = (write[key] ?? 0) + written;
  grow[key] = (grow[key] ?? 0) + grown;
  const cutoff = new Date(date);
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
  const oldest = dayKey(cutoff);
  for (const days of [write, grow]) for (const k of Object.keys(days)) if (k < oldest) delete days[k];
  return { writeDays: write, growDays: grow };
}

/** The sum of the last `n` days, today included. */
export function lastDays(days, n, date = new Date()) {
  const day = new Date(date);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += days?.[dayKey(day)] ?? 0;
    day.setDate(day.getDate() - 1);
  }
  return sum;
}

/** Days in a row with something written, up to today (or yesterday, when today has nothing yet). */
export function writingStreak(days, date = new Date()) {
  const has = (d) => (days?.[dayKey(d)] ?? 0) > 0;
  const day = new Date(date);
  if (!has(day)) day.setDate(day.getDate() - 1);
  let n = 0;
  while (has(day) && n < KEEP_DAYS) {
    n++;
    day.setDate(day.getDate() - 1);
  }
  return n;
}

/**
 * The heat map: `weeks` columns of seven days, Monday at the top, the last column holding today.
 * Each cell { day, value, level: 0–4 }: nothing written, then quarters of the busiest day of the map.
 * Days after today are null.
 */
export function heatCells(days, weeks = 26, date = new Date()) {
  const today = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const monday = new Date(today);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - (weeks - 1) * 7);
  const values = [];
  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    if (day > today) {
      cells.push(null);
      continue;
    }
    const key = dayKey(day);
    const value = Math.max(0, days?.[key] ?? 0);
    if (value) values.push(value);
    cells.push({ day: key, value, level: 0 });
  }
  const most = Math.max(0, ...values);
  for (const cell of cells) if (cell?.value) cell.level = Math.min(4, Math.ceil((cell.value / most) * 4));
  return cells;
}
