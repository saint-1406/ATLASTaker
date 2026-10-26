import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPaste, detectLanguage } from '../src/codeDetect.js';

const samples = {
  python: 'import os\n\ndef walk(root):\n    for name in os.listdir(root):\n        print(name)\n',
  javascript: 'const items = await fetch(url).then((r) => r.json());\nitems.forEach((item) => {\n  console.log(item.id);\n});\n',
  typescript: 'interface Note { id: string; words: number }\nconst notes: Note[] = [];\nexport function add(n: Note): void { notes.push(n); }\n',
  sql: 'SELECT id, title\nFROM notes\nWHERE words > 100\nORDER BY updated DESC;',
  powershell: '$notes = Get-ChildItem -Path $env:APPDATA -Filter *.md\n$notes | Where-Object { $_.Length -gt 0 } | ForEach-Object { $_.Name }',
  json: '{\n  "theme": "dark",\n  "sidebar": true\n}',
  yaml: 'server:\n  port: 8080\n  host: localhost\nfeatures:\n  - search\n  - export\n',
  bash: '#!/usr/bin/env bash\nset -e\nnpm ci && npm test\n',
};

for (const [lang, code] of Object.entries(samples)) {
  test(`recognises ${lang}`, () => {
    assert.equal(detectLanguage(code), lang);
    assert.deepEqual(classifyPaste(code), { lang });
  });
}

test('prose stays prose', () => {
  const prose = 'Сегодня мы обсудили план на неделю и договорились о сроках.\nПотом Лена рассказала про новый дизайн, всем понравилось.\nВ пятницу созвон с клиентом в десять утра.';
  assert.equal(classifyPaste(prose), null);
});

test('a markdown list is not mistaken for YAML', () => {
  assert.equal(classifyPaste('- Купить: молоко\n- Позвонить: маме\n- Забрать посылку'), null);
  assert.equal(classifyPaste('- Buy: milk\n- Call: mom\n- Pick up the parcel'), null);
});

test('single lines and already fenced code are left alone', () => {
  assert.equal(classifyPaste('const x = 1;'), null);
  assert.equal(classifyPaste('```js\nconst x = 1;\n```'), null);
});
