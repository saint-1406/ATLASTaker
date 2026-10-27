import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackups, DRAFTS_DIR, safeName, stamp } from '../server/backups.js';

const HOUR = 60 * 60 * 1000;

function dataDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-backups-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'notes', 'assets'), { recursive: true });
  writeFileSync(path.join(dir, 'notes', 'n-aaaaaa1.md'), '# Первая\n\nтекст');
  writeFileSync(path.join(dir, 'notes', 'n-bbbbbb2.md'), '# Вторая');
  writeFileSync(path.join(dir, 'notes', 'atlas.json'), '{"version":1,"notes":{},"state":{}}');
  writeFileSync(path.join(dir, 'notes', 'assets', 'a-cccccc3.png'), Buffer.from('89504e47', 'hex'));
  return dir;
}

const clock = (start = Date.UTC(2026, 9, 27, 9, 0)) => {
  const c = { t: start, now: () => c.t };
  return c;
};
const copies = (dir) => readdirSync(path.join(dir, 'backups')).filter((name) => !name.endsWith('.json') && name !== DRAFTS_DIR).sort();
const about = (folder) => JSON.parse(readFileSync(path.join(folder, 'backup.json'), 'utf8'));

test('the first start on new code copies the notes as the old version left them', async (t) => {
  const dir = dataDir(t);
  const c = clock();
  const made = await createBackups(dir, { version: '0.4.0', build: 'bbb', now: c.now }).atStart();
  assert.equal(path.basename(made), `${stamp(c.t)} до обновления`);
  assert.equal(readFileSync(path.join(made, 'n-aaaaaa1.md'), 'utf8'), '# Первая\n\nтекст');
  assert.ok(existsSync(path.join(made, 'n-bbbbbb2.md')));
  assert.ok(existsSync(path.join(made, 'atlas.json')));
  assert.deepEqual(about(made).to, { version: '0.4.0', build: 'bbb' });
  assert.equal(about(made).notes, 2);
  // pictures are never rewritten, so the copy links to the same bytes instead of duplicating them
  assert.ok(statSync(path.join(made, 'assets', 'a-cccccc3.png')).nlink >= 2);
});

test('same code: no copy until a day has passed, then a daily one', async (t) => {
  const dir = dataDir(t);
  const c = clock();
  await createBackups(dir, { version: '0.4.0', build: 'bbb', now: c.now }).atStart();
  c.t += 5 * HOUR;
  assert.equal(await createBackups(dir, { version: '0.4.0', build: 'bbb', now: c.now }).atStart(), null);
  c.t += 20 * HOUR;
  const running = createBackups(dir, { version: '0.4.0', build: 'bbb', now: c.now });
  const daily = await running.atStart();
  assert.match(path.basename(daily), /ежедневная$/);
  c.t += 2 * HOUR;
  assert.equal(await running.daily(), null);
  c.t += 23 * HOUR;
  assert.match(path.basename(await running.daily()), /ежедневная$/);
  assert.equal(copies(dir).length, 3);
});

test('an update names the versions it went between', async (t) => {
  const dir = dataDir(t);
  const c = clock();
  await createBackups(dir, { version: '0.3.0', build: 'aaa', now: c.now }).atStart();
  c.t += HOUR;
  const made = await createBackups(dir, { version: '0.4.0', build: 'bbb', now: c.now }).atStart();
  assert.deepEqual(about(made).from, { version: '0.3.0', build: 'aaa' });
  assert.deepEqual(about(made).to, { version: '0.4.0', build: 'bbb' });
});

test('only the newest copies stay, and folders ATLAS did not make are left alone', async (t) => {
  const dir = dataDir(t);
  const c = clock();
  mkdirSync(path.join(dir, 'backups', 'мои'), { recursive: true });
  for (const build of ['a1', 'a2', 'a3', 'a4']) {
    c.t += HOUR;
    await createBackups(dir, { version: '0.4.0', build, keep: 2, now: c.now }).atStart();
  }
  const left = copies(dir);
  assert.deepEqual(left, ['мои', `${stamp(c.t - HOUR)} до обновления`, `${stamp(c.t)} до обновления`].sort());
});

test('two copies in the same minute get separate folders', async (t) => {
  const dir = dataDir(t);
  const c = clock();
  const first = await createBackups(dir, { version: '0.4.0', build: 'x1', now: c.now }).atStart();
  const second = await createBackups(dir, { version: '0.4.0', build: 'x2', now: c.now }).atStart();
  assert.notEqual(first, second);
  assert.match(path.basename(second), /\(2\)$/);
});

test('an empty notes folder needs no copy', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'atlas-backups-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(await createBackups(dir, { version: '0.4.0', build: 'bbb' }).atStart(), null);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'backups', 'last.json'), 'utf8')).build, 'bbb');
});

test('unsaved text is kept as its own file, under a safe and unique name', async (t) => {
  const dir = dataDir(t);
  const c = clock();
  const backups = createBackups(dir, { version: '0.4.0', build: 'bbb', keepDrafts: 2, now: c.now });
  const name = await backups.keepDraft({ title: 'План: a/b?', content: 'черновик', at: c.t, label: 'не восстановлено' });
  assert.equal(name, `${stamp(c.t)} План a b (не восстановлено).md`);
  assert.equal(readFileSync(path.join(backups.draftsDir, name), 'utf8'), 'черновик');
  const again = await backups.keepDraft({ title: 'План: a/b?', content: 'ещё', at: c.t, label: 'не восстановлено' });
  assert.equal(again, `${stamp(c.t)} План a b (не восстановлено) (2).md`);
  c.t += HOUR;
  await backups.keepDraft({ title: '', content: 'третий', at: c.t });
  assert.equal(readdirSync(backups.draftsDir).length, 2); // the oldest went
  await assert.rejects(backups.keepDraft({ title: 'x' }), { status: 400 });
});

test('file names lose what Windows refuses', () => {
  assert.equal(safeName('a<b>c:"d"|e?*'), 'a b c d e');
  assert.equal(safeName('  точки в конце... '), 'точки в конце');
  assert.equal(safeName(''), 'заметка');
  assert.equal(safeName('я'.repeat(80)).length, 60);
});
