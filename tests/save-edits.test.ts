import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshRecipe } from '../src/types';

function loadSave() {
  const code = buildSync({ entryPoints: ['src/save-edits.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['obsidian', './image-engine'], write: false }).outputFiles[0].text;
  const module = { exports: {} as any }, native = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', code)((name: string) => name === 'obsidian' ? { Notice: class {} } : name === './image-engine' ? {
    decodePhoto: async () => ({ bitmap: { width: 2, height: 2, close() {} }, embeddedPreview: false }),
    renderPhoto: () => ({ width: 2, height: 2, toBlob(fn: any) { fn(new Blob(['encoded'], { type: 'image/png' })); } })
  } : native(name), module, module.exports);
  return module.exports;
}

test('folder save includes unloaded pages, skips neutral recipes, and isolates failed files', async () => {
  const api = loadSave(), dir = await mkdtemp(join(tmpdir(), 'coherence-save-'));
  try {
    const path = join(dir, 'test.png'); await writeFile(path, 'original');
    const photos = [1, 2, 3, 4].map(id => ({ id, path, name: 'test.png' }));
    const recipe = { ...freshRecipe(), auto: 100 };
    const calls: any[] = [], plugin: any = {
      catalog: { key: 'library' }, settings: { recipes: { 'library:1': recipe, 'library:2': freshRecipe(), 'library:3': recipe, 'library:4': recipe }, luckyUndo: { 'library:1': null } }, emit() {}, save: async () => {},
      bridge: { run: async (action: string, payload: any) => {
        calls.push({ action, payload });
        if (action === 'query') return payload.filters.offset === 0 ? { photos: photos.slice(0, 2), hasMore: true } : { photos: photos.slice(2), hasMore: false };
        if (payload.id === 3) throw new Error('read-only photo');
        return { operation: `operation-${payload.id}` };
      } }
    };
    const browser: any = { mode: 'grid', filters: { folderAbsolute: dir, folderRecursive: false, tag: 'restrictive', rating: '5' }, flushRecipe: async () => {}, clearThumbnailCache() {}, reload: async () => {} };
    await api.saveEdits(plugin, browser);
    assert.deepEqual(calls.filter(c => c.action === 'query').map(c => c.payload.filters.offset), [0, 300]);
    assert.equal(calls[0].payload.filters.tag, undefined); assert.equal(calls[0].payload.filters.folderRecursive, false);
    assert.deepEqual(calls.filter(c => c.action === 'save-pixels').map(c => c.payload.id), [1, 3, 4]);
    assert.equal(plugin.settings.recipes['library:1'], undefined); assert.equal(plugin.settings.recipes['library:4'], undefined);
    assert.deepEqual(plugin.settings.recipes['library:3'], recipe); assert.equal(plugin.settings.luckyUndo, undefined);
    assert.equal(plugin.busy, false); assert.match(plugin.status, /2 saved.*1 unchanged.*1 issues/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('crash reconciliation clears an already-baked recipe only once', async () => {
  const api = loadSave(), recipe = { ...freshRecipe(), auto: 100 };
  const plugin: any = { catalog: { key: 'library' }, settings: { recipes: { 'library:7': recipe } }, save: async () => {}, bridge: { run: async () => ({ '7': { operation: 'save-7', recipe } }) } };
  await api.reconcileSavedRecipes(plugin); assert.equal(plugin.settings.recipes['library:7'], undefined);
  plugin.settings.recipes['library:7'] = recipe;
  await api.reconcileSavedRecipes(plugin); assert.deepEqual(plugin.settings.recipes['library:7'], recipe);
  assert.equal(api.folderSaveFilters({ tag: 'All' }), null);
});
