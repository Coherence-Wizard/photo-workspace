import { spawn } from 'node:child_process';
import { App, SuggestModal } from 'obsidian';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { access, readdir, readFile } from 'node:fs/promises';
// Electron's public shell module is exposed by Obsidian desktop.
const shell = require('electron').shell as { showItemInFolder(path: string): void; openPath(path: string): Promise<string> };
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', error = '';
    process.stdout.on('data', data => { out += String(data); }); process.stderr.on('data', data => { error += String(data); });
    process.on('error', reject); process.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(error || 'The system application chooser could not be opened.')));
  });
}
export async function revealPhoto(path: string): Promise<void> { await access(path); shell.showItemInFolder(path); }
export async function openPhotoDefault(path: string): Promise<void> { await access(path); const error = await shell.openPath(path); if (error) throw new Error(error); }
export async function openPhotoWith(path: string, app: App): Promise<void> {
  await access(path);
  if (process.platform === 'darwin') {
    // Native installed-application chooser; no photo path is interpolated into script code.
    try { const application = await run('/usr/bin/osascript', ['-e', 'POSIX path of (choose application with prompt "Choose an application to open this photo" as alias)']); if (application) await run('/usr/bin/open', ['-a', application, path]); }
    catch (error) { if (!String(error).includes('(-128)')) throw error; }
  } else if (process.platform === 'win32') {
    await run('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', path]);
  } else {
    const entries: { name: string; path: string }[] = [];
    const directories = [join(homedir(), '.local/share/applications'), '/usr/share/applications', '/usr/local/share/applications'];
    for (const directory of directories) {
      let names: string[]; try { names = await readdir(directory); } catch { continue; }
      for (const name of names.filter(name => name.endsWith('.desktop'))) {
        const desktop = join(directory, name); let text: string; try { text = await readFile(desktop, 'utf8'); } catch { continue; }
        if (/^(Hidden|NoDisplay)=true$/m.test(text) || !/^MimeType=.*image\//m.test(text)) continue;
        entries.push({ name: /^Name=(.*)$/m.exec(text)?.[1] || name, path: desktop });
      }
    }
    if (!entries.length) throw new Error('No installed image applications were found in the standard application folders.');
    const chosen = await new Promise<string | null>(resolve => { new ApplicationPicker(app, entries, resolve).open(); });
    if (chosen) await run('gio', ['launch', chosen, path]);

  }
}
export async function trashPhotoFiles(paths: string[]): Promise<void> {
  const trash = require('electron').shell as { trashItem(path: string): Promise<void> };
  // Sidecars first: a failed companion operation leaves the original image present.
  for (const path of [...paths].reverse()) await trash.trashItem(path);
}

class ApplicationPicker extends SuggestModal<{ name: string; path: string }> {
  private selected = false;
  constructor(app: App, private entries: { name: string; path: string }[], private done: (path: string | null) => void) { super(app); this.setPlaceholder('Choose an installed image application'); }
  getSuggestions(query: string): { name: string; path: string }[] { return this.entries.filter(e => e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())); }
  renderSuggestion(entry: { name: string; path: string }, el: HTMLElement): void { el.setText(entry.name); }
  onChooseSuggestion(entry: { name: string; path: string }): void { this.selected = true; this.done(entry.path); }
  onClose(): void { queueMicrotask(() => { if (!this.selected) this.done(null); }); }
}
