import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { crc32, fileNameFor, makeZip } from '../src/backup.js';

test('crc32 matches zlib', () => {
  const bytes = new TextEncoder().encode('Экспедиция на север — день 1');
  assert.equal(crc32(bytes), zlib.crc32(bytes));
});

test('file names are safe and never collide', () => {
  const used = new Set();
  assert.equal(fileNameFor('План: неделя 1/2', used), 'План неделя 1 2.md');
  assert.equal(fileNameFor('план  НЕДЕЛЯ 1 2', used), 'план НЕДЕЛЯ 1 2 (2).md');
  assert.equal(fileNameFor('', used), 'Без названия.md');
  assert.equal(fileNameFor('   ', used), 'Без названия (2).md');
});

function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(local, true), 0x04034b50);
    const dataAt = local + 30 + view.getUint16(local + 26, true);
    const data = bytes.subarray(dataAt, dataAt + size);
    assert.equal(zlib.crc32(data), crc, `${name}: bad checksum`);
    entries.push({ name, text: decoder.decode(data) });
    at += 46 + nameLength;
  }
  return entries;
}

test('the zip holds every note, byte for byte', () => {
  const files = [
    { name: 'Экспедиция.md', text: '# Экспедиция\n\n- [ ] палатка\n', date: Date.UTC(2026, 9, 26, 12) },
    { name: 'Пустая.md', text: '' },
  ];
  assert.deepEqual(readZip(makeZip(files)), files.map(({ name, text }) => ({ name, text })));
});
