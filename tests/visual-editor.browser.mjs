// Browser regressions for the real editor/controller, independent of the user's notes or accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const bundle = await build({ stdin: { resolveDir: root, loader: 'js', contents: `
import {createEditor} from './src/noteEditor.js';
import {createFormatBar} from './src/formatBar.js';
import {setLang} from './src/i18n.js';
import {TextSelection} from 'prosemirror-state';
import {insertDictation,showDictationPreview} from './src/editor.js';
setLang('ru',[]);
let editor;const changes=[];
const bar=createFormatBar({getView:()=>editor?.view,actions:{}});
document.querySelector('#app').append(bar.node);bar.node.hidden=false;
editor=createEditor({parent:document.querySelector('#editor'),onDocChange:u=>changes.push(u.state.doc.toString()),onSelectionChange:()=>bar.refresh(),resolveImage:async()=>null,openImage:()=>{},onImage:()=>{},onOpenLink:()=>{},onContextMenu:()=>{},onCopy:()=>{}});
document.querySelector('#editor').addEventListener('formatstatechange',()=>bar.refresh());
window.qa={editor,bar,changes,source:()=>editor.view.state.doc.toString(),set:md=>editor.show(editor.makeState(md)),end:()=>{const r=editor.view.rich;r.view.dispatch(r.view.state.tr.setSelection(TextSelection.atEnd(r.view.state.doc)));editor.view.focus();},selectText:(text)=>{const r=editor.view.rich;let found=false;r.view.state.doc.descendants((node,pos)=>{if(!found&&node.isText&&node.text.includes(text)){const at=pos+node.text.indexOf(text)+text.length;r.view.dispatch(r.view.state.tr.setSelection(TextSelection.create(r.view.state.doc,at)));found=true;}});editor.view.focus();},type:(id)=>editor.view.rich.command(id)};
window.qa.dictate=text=>insertDictation(editor.view,text);window.qa.preview=text=>showDictationPreview(editor.view,text);
` }, bundle: true, write: false, format: 'iife', logLevel: 'silent', loader: { '.md': 'text' } });
const server = http.createServer((req, res) => {
  if (req.url === '/qa.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); return; }
  if (req.url.startsWith('/dist/')) {
    const file = path.join(root, req.url.slice(1));
    if (file.startsWith(path.join(root, 'dist')) && fs.existsSync(file)) { res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'application/octet-stream'); res.end(fs.readFileSync(file)); return; }
    res.writeHead(404).end(); return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end('<!doctype html><html lang="ru" data-skin="minimal" data-theme="light" data-accent="lime"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/dist/styles.css"><style>#app{height:100dvh;display:flex;flex-direction:column}.sheet{flex:1;min-height:0}</style><div id="app" class="app"><section class="sheet"><div id="editor"></div></section></div><div id="overlays"></div><script src="/qa.js"></script></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const executablePath = process.env.ATLAS_BROWSER || (process.platform === 'win32' && fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe') ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true });
  page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForFunction(() => window.qa);
  const visual = page.locator('.atlas-rich-content');
  await visual.click();
  await page.getByRole('button', { name: 'Жирный', exact: true }).click();
  await page.keyboard.type('Два слова ');
  assert.equal(await visual.locator('strong').innerText(), 'Два слова ');
  assert.equal(await page.getByRole('button', { name: 'Жирный', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.doesNotMatch(await visual.innerText(), /\*\*|~~|###/);
  await page.keyboard.press('Enter'); await page.keyboard.type('Обычный текст');
  assert.equal(await visual.locator('p').last().locator('strong').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Жирный', exact: true }).getAttribute('aria-pressed'), 'false');

  for (const [source, list] of [['- Первый', 'ul'], ['4. Первый', 'ol']]) {
    await page.evaluate((md) => { qa.set(md); qa.end(); }, source);
    await page.keyboard.press('Enter');
    const items = visual.locator(`:scope > ${list} > li`);
    assert.equal(await items.count(), 2);
    assert.equal(await items.last().textContent(), '');
    if (list === 'ol') assert.equal(await visual.locator('ol').getAttribute('start'), '4');

    await visual.evaluate((element) => element.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertParagraph',
    })));
    await page.keyboard.type('После списка');
    assert.equal(await items.count(), 1);
    assert.equal(await items.first().innerText(), 'Первый');
    assert.equal(await visual.locator(':scope > p').last().innerText(), 'После списка');
  }

  await page.evaluate(() => qa.set('- [ ] ')); await page.evaluate(() => qa.end());
  await page.keyboard.press('Enter'); await page.keyboard.type('После чекбокса');
  assert.equal(await visual.locator('input[type=checkbox]').count(), 1);
  assert.equal(await visual.locator(':scope > p').last().innerText(), 'После чекбокса');

  await page.evaluate(() => { qa.set(''); qa.bar.setTools([]); }); await visual.click();
  await page.getByRole('button', { name: 'Вставить блок', exact: true }).click();
  await page.getByRole('menuitem', { name: /Аккордеон/ }).click();
  await page.keyboard.type('Планы'); await page.keyboard.press('Enter'); await page.keyboard.type('Подробности');
  assert.equal(await visual.locator('summary').innerText(), 'Планы');
  assert.match(await visual.locator('[data-details-content]').innerText(), /Подробности/);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Вторая строка');
  const paragraphGap = await visual.locator('[data-details-content] > p').evaluateAll(([first, second]) =>
    second.getBoundingClientRect().top - first.getBoundingClientRect().bottom);
  assert.ok(paragraphGap >= 0 && paragraphGap < 3, `Accordion paragraph gap: ${paragraphGap}px`);
  await page.getByRole('button', { name: 'Свернуть: Планы', exact: true }).click();
  assert.equal(await visual.locator('[data-details-content]').isVisible(), false);
  await page.getByRole('button', { name: 'Абзац после блока', exact: true }).click();
  await page.keyboard.type('Снаружи');
  assert.equal(await visual.locator(':scope > p').last().innerText(), 'Снаружи');

  const before = await page.evaluate(() => qa.source());
  await page.evaluate(() => qa.editor.setEditable(false));
  await page.getByRole('button', { name: 'Раскрыть: Планы', exact: true }).click();
  assert.equal(await page.evaluate(() => qa.source()), before);
  await page.evaluate(() => qa.editor.setEditable(true));

  await page.evaluate(() => { qa.set('Original  **text**\n\n- [ ] item\n'); qa.changes.length = 0; });
  assert.equal(await page.evaluate(() => qa.source()), 'Original  **text**\n\n- [ ] item\n');
  assert.equal(await page.evaluate(() => qa.changes.length), 0, 'opening alone does not save');
  await page.evaluate(() => qa.editor.setMode('source'));
  assert.equal(await page.locator('.note-source-host').isVisible(), true);
  await page.evaluate(() => qa.editor.setMode('visual'));
  assert.equal(await page.evaluate(() => qa.source()), 'Original  **text**\n\n- [ ] item\n');

  await page.evaluate(() => { qa.set('first'); window.first=qa.editor.view.state; qa.set('second'); });
  assert.equal(await page.evaluate(() => qa.editor.steps().canUndo), false, 'new note does not inherit another note history');
  await page.evaluate(() => { qa.editor.show(window.first); qa.end(); });
  await page.keyboard.type(' edited');
  await page.evaluate(() => { window.edited=qa.editor.view.state; qa.set('other'); qa.editor.show(window.edited); qa.editor.undo(); });
  assert.equal(await page.evaluate(() => qa.source()), 'first');

  await page.evaluate(() => qa.set('')); await visual.click(); await page.keyboard.type('hello');
  await page.evaluate(() => { qa.editor.setMode('source'); qa.editor.undo(); qa.editor.setMode('visual'); });
  assert.equal(await page.evaluate(() => qa.editor.steps().canRedo), true, 'source undo retains redo in visual mode');
  await page.evaluate(() => qa.editor.redo());
  assert.equal(await visual.innerText(), 'hello');
  await page.evaluate(() => { qa.editor.setMode('source'); qa.editor.view.focus(); });
  await page.keyboard.press('Control+End'); await page.keyboard.type(' source');
  await page.keyboard.press('Control+z');
  await page.evaluate(() => qa.editor.setMode('visual'));
  assert.equal(await page.evaluate(() => qa.editor.steps().canRedo), true);
  await page.keyboard.press('Control+y');
  assert.equal(await visual.innerText(), 'hello source');

  await page.evaluate(() => { qa.set('| a | b |\n| --- | --- |\n| x | y |'); qa.selectText('x'); });
  await page.keyboard.press('Enter'); await page.keyboard.type('kept');
  await page.evaluate(() => { const saved=qa.source(); qa.set(saved); qa.selectText('a'); });
  await page.keyboard.press('Shift+Enter'); await page.keyboard.type('more');
  await page.evaluate(() => qa.set(qa.source()));
  assert.match(await visual.locator('table').innerText(), /kept/);
  assert.match(await visual.locator('table').innerText(), /more/);

  await page.evaluate(() => { qa.set('<details open>\n<summary>A * B</summary>\n\n# heading\n\n</details>'); qa.selectText('A * B'); });
  await page.keyboard.press('Enter'); await page.keyboard.type('plain');
  await page.evaluate(() => qa.set(qa.source()));
  assert.equal(await visual.locator('summary').innerText(), 'A * B');
  assert.equal(await visual.locator('[data-details-content] > p').first().innerText(), 'plain');
  assert.equal(await visual.locator('[data-details-content] > h1').innerText(), 'heading');

  await page.evaluate(() => { qa.set(''); qa.end(); window.clipboardExecuted=false; });
  await page.evaluate(() => {
    const data=new DataTransfer();data.setData('text/html','<p><strong>pasted</strong> <a href="javascript:alert(1)">safe</a><img src="x" onerror="window.clipboardExecuted=true"></p><script>window.clipboardExecuted=true</script>');
    qa.editor.view.rich.view.dom.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
  });
  assert.equal(await page.evaluate(() => window.clipboardExecuted), false);
  assert.equal(await visual.locator('strong').innerText(), 'pasted');
  assert.equal(await visual.locator('a[href^="javascript:"]').count(), 0);

  await page.evaluate(() => { qa.set('needle needle'); qa.end(); }); await page.keyboard.press('Control+f');
  await page.getByRole('searchbox', { name: 'Найти в заметке' }).fill('needle');
  assert.equal(await visual.locator('.rich-search-match').count(), 2);
  await page.getByRole('textbox', { name: 'Заменить на' }).fill('changed');
  await page.getByRole('button', { name: 'Заменить', exact: true }).click();
  assert.match(await visual.innerText(), /changed/);
  await page.evaluate(() => { qa.set('# heading'); qa.end(); });
  const blocks = await visual.locator(':scope > *').count();
  await visual.evaluate((element) => element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph', isComposing: true })));
  assert.equal(await visual.locator(':scope > *').count(), blocks);
  await visual.evaluate((element) => element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertParagraph', isComposing: false })));
  assert.equal(await visual.locator(':scope > p').count(), 1);

  await page.evaluate(() => { qa.set('Начало'); qa.end(); qa.preview('продолжение'); });
  assert.equal(await page.evaluate(() => qa.source()), 'Начало');
  await page.evaluate(() => qa.dictate('продолжение'));
  assert.equal(await visual.innerText(), 'Начало продолжение');
  await page.evaluate(() => { qa.set('before'); qa.editor.view.dispatch({changes:{from:0,to:6,insert:'**incoming**'},selection:{anchor:2,head:10}}); });
  assert.equal(await visual.locator('strong').innerText(), 'incoming');
  assert.equal(await page.evaluate(() => qa.source()), '**incoming**');

  await page.evaluate(() => { qa.set('# План на неделю\n\nОбычный **жирный** и ~~зачёркнутый~~ текст.\n\n- [ ] Позвонить\n- [x] Подготовить заметки\n\n<details open>\n<summary>Подробности</summary>\n\nЗдесь можно редактировать текст.\n\n</details>'); qa.bar.setTools(null); });
  await page.getByRole('button', { name: '×', exact: true }).click();

  for (const width of [360, 390, 430, 1100]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => document.documentElement.dataset.theme=value, theme);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width} ${theme} overflow`);
      if (width === 390 || width === 1100) {
        fs.mkdirSync(path.join(root, 'out'), { recursive: true });
        await page.screenshot({ path: path.join(root, `out/visual-editor-${width}-${theme}.png`), fullPage: true, animations: 'disabled' });
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log('PASS: visual formatting/Enter, checkbox exit, discoverable accordion, read-only, unchanged source, modes, per-note undo and responsive themes.');
} finally { await browser.close(); await new Promise((resolve) => server.close(resolve)); }
