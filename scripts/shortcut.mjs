// Puts "ATLAS Notetaker" shortcuts on the Desktop and in the Start menu.
//   node scripts/shortcut.mjs            → runs server/launch.js with the Node that runs this script
//   node scripts/shortcut.mjs --browser  → opens the installed single-file build in an Edge app window
//                                          (npm run install:browser puts it in place first)

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function browserLink() {
  const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ATLAS Notetaker', 'browser');
  const html = path.join(dir, 'ATLAS-Notetaker.html');
  if (!fs.existsSync(html)) throw new Error(`нет ${html} — сначала npm run install:browser`);
  const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter(Boolean)
    .map((base) => path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    .find((file) => fs.existsSync(file));
  if (!edge) throw new Error('Microsoft Edge не найден');
  return {
    name: 'ATLAS Notetaker (браузер)',
    target: edge,
    args: `--app="${pathToFileURL(html).href}"`,
    dir,
    icon: path.join(dir, 'icon.ico'),
    style: 1,
  };
}

function serverLink() {
  return {
    name: 'ATLAS Notetaker',
    target: process.execPath,
    args: `"${path.join(ROOT, 'server', 'launch.js')}"`,
    dir: ROOT,
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    style: 7, // minimised: the launcher's console only flashes by
  };
}

const link = process.argv.includes('--browser') ? browserLink() : serverLink();
// WScript.Shell only takes ANSI paths, so the shortcut is saved under a Latin name and then renamed
// (the file system itself is fine with Cyrillic).
const script = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
$shell = New-Object -ComObject WScript.Shell
$places = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'))
foreach ($dir in $places) {
  $temp = Join-Path $dir 'atlas-notetaker-shortcut.lnk'
  $final = Join-Path $dir ${quote(`${link.name}.lnk`)}
  $lnk = $shell.CreateShortcut($temp)
  $lnk.TargetPath = ${quote(link.target)}
  $lnk.Arguments = ${quote(link.args)}
  $lnk.WorkingDirectory = ${quote(link.dir)}
  $lnk.IconLocation = ${quote(link.icon)}
  $lnk.WindowStyle = ${link.style}
  $lnk.Description = 'ATLAS Notetaker'
  $lnk.Save()
  if (Test-Path -LiteralPath $final) { Remove-Item -LiteralPath $final -Force }
  Rename-Item -LiteralPath $temp -NewName (Split-Path $final -Leaf)
  Write-Output $final
}`;

// -EncodedCommand (UTF-16LE): Windows PowerShell mangles non-ASCII text passed with -Command,
// and the shortcut names are Cyrillic.
const encoded = Buffer.from(script, 'utf16le').toString('base64');
const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8' });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
