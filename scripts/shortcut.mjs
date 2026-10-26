// Puts "ATLAS Notetaker" shortcuts on the Desktop and in the Start menu. They run server/launch.js
// with the Node that runs this script, so no extra executable is involved.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

const script = `
$shell = New-Object -ComObject WScript.Shell
$places = @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'))
foreach ($dir in $places) {
  $lnk = $shell.CreateShortcut((Join-Path $dir 'ATLAS Notetaker.lnk'))
  $lnk.TargetPath = ${quote(process.execPath)}
  $lnk.Arguments = ${quote(`"${path.join(ROOT, 'server', 'launch.js')}"`)}
  $lnk.WorkingDirectory = ${quote(ROOT)}
  $lnk.IconLocation = ${quote(path.join(ROOT, 'assets', 'icon.ico'))}
  $lnk.WindowStyle = 7
  $lnk.Description = 'ATLAS Notetaker'
  $lnk.Save()
  Write-Output $lnk.FullName
}`;

const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
