import test from 'node:test';
import assert from 'node:assert/strict';
import { commentTarget, commentsUnder, formatStamp, isCommentLine, planComment } from '../src/comments.js';

const date = new Date(2026, 9, 26, 17, 52);

test('the stamp is day.month.year hours:minutes', () => {
  assert.equal(formatStamp(new Date(2026, 0, 5, 9, 3)), '05.01.2026 09:03');
});

test('a comment lands right under a task, aligned with its text', () => {
  const lines = ['# План', '- [ ] Позвонить подрядчику', '- [ ] Купить краску'];
  assert.deepEqual(planComment(lines, 2, '  перенесли на четверг \n', date), {
    afterLine: 2,
    text: '      💬 26.10.2026 17:52 · перенесли на четверг',
  });
});

test('plain lines get comments at their own indentation', () => {
  assert.deepEqual(planComment(['Просто строка'], 1, 'ок', date), { afterLine: 1, text: '💬 26.10.2026 17:52 · ок' });
});

test('new comments queue after the existing thread', () => {
  const lines = ['- [ ] Позвонить', '      💬 25.10.2026 10:00 · не взяли трубку', '- [ ] Купить краску'];
  assert.equal(planComment(lines, 1, 'дозвонился', date).afterLine, 2);
});

test('right-clicking a comment adds to its task thread', () => {
  const lines = ['- [ ] Позвонить', '      💬 25.10.2026 10:00 · не взяли трубку', '      💬 25.10.2026 12:00 · перезвонят'];
  assert.equal(commentTarget(lines, 3), 1);
  const plan = planComment(lines, 3, 'готово', date);
  assert.equal(plan.afterLine, 3);
  assert.ok(plan.text.startsWith('      💬 '));
  assert.deepEqual(commentsUnder(lines, 1).map((c) => c.text), ['не взяли трубку', 'перезвонят']);
});

test('multi-line text becomes one line, empty text is ignored', () => {
  assert.equal(planComment(['x'], 1, 'раз\n\nдва', date).text, '💬 26.10.2026 17:52 · раз / два');
  assert.equal(planComment(['x'], 1, '   \n ', date), null);
});

test('isCommentLine only accepts the exact format', () => {
  assert.ok(isCommentLine('  💬 26.10.2026 17:52 · текст'));
  assert.ok(!isCommentLine('💬 просто эмодзи'));
  assert.ok(!isCommentLine(undefined));
});
