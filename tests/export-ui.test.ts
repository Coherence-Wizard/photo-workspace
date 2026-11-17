import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';

// Exercise the actual dialog callbacks without launching Electron or exporting files.
test('export dialog exposes only settings required by the chosen scope and resize mode', () => {
  const settings: any[] = [];
  const element = () => ({ hidden: false, createEl: () => element(), createDiv: () => element(), setText() {} });
  const control = () => { const c: any = { onChange(fn: any) { c.change = fn; return c; } }; for (const name of ['addOptions', 'addOption', 'setValue', 'setButtonText', 'setCta', 'setDisabled', 'onClick']) c[name] = () => c; return c; };
  class Setting {
    settingEl = element(); name = ''; input: any;
    constructor(_: unknown) { settings.push(this); }
    setName(name: string) { this.name = name; return this; }
    setDesc(_: string) { return this; }
    addDropdown(fn: any) { this.input = control(); fn(this.input); return this; }
    addText(fn: any) { return this.addDropdown(fn); }
    addToggle(fn: any) { return this.addDropdown(fn); }
    addButton(fn: any) { fn(control()); return this; }
  }
  class Modal { titleEl = element(); contentEl = element(); constructor(_: unknown) {} }
  const code = buildSync({ entryPoints: ['src/export.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['obsidian'], write: false }).outputFiles[0].text;
  const module = { exports: {} as any }, nativeRequire = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', code)((name: string) => name === 'obsidian' ? { Setting, Modal, FileSystemAdapter: class {} } : nativeRequire(name), module, module.exports);
  const plugin = { app: {}, settings: { exportFolder: 'Exports' }, availableTags: () => ['Art'], catalog: { albums: [], roots: [] } };
  new module.exports.ExportPhotos(plugin).onOpen();
  const find = (name: string) => settings.find(s => s.name === name)!;
  const visible = (name: string) => !find(name).settingEl.hidden;
  assert.equal(visible('Tag'), false); assert.equal(visible('Collection folder'), false);
  find('Photos to export').input.change('tag');
  assert.equal(visible('Tag'), true); assert.equal(visible('Collection folder'), false);
  find('Photos to export').input.change('folder');
  assert.equal(visible('Tag'), false); assert.equal(visible('Collection folder'), true);
  find('Photos to export').input.change('filters');
  assert.equal(visible('Tag'), false); assert.equal(visible('Collection folder'), false);
  assert.equal(visible('Maximum width (pixels)'), true); assert.equal(visible('Percentage'), false);
  find('Resize').input.change('percent');
  assert.equal(visible('Maximum width (pixels)'), false); assert.equal(visible('Maximum height (pixels)'), false); assert.equal(visible('Percentage'), true);
  find('Resize').input.change('original');
  assert.equal(visible('Percentage'), false); assert.equal(visible('Allow enlarging smaller images'), false);
  find('Resize').input.change('inside');
  assert.equal(visible('Maximum width (pixels)'), true); assert.equal(visible('Allow enlarging smaller images'), true);
});
