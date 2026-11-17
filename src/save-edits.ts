import { Notice } from 'obsidian';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import type PhotoWorkspace from './main';
import type { BrowserView } from './views';
import { type Photo, type Filters, type Recipe, freshRecipe } from './types';
import { decodePhoto, renderPhoto } from './image-engine';
import { hasEdits, outputFormat, encodeCanvas } from './encoding';

export function folderSaveFilters(filters: Filters): Filters | null {
  if (filters.folderAbsolute) return { folderAbsolute: filters.folderAbsolute, folderRecursive: filters.folderRecursive };
  if (filters.albumId) return { albumId: filters.albumId };
  if (filters.folderPath !== undefined) return { rootId: filters.rootId, folderPath: filters.folderPath, folderRecursive: filters.folderRecursive };
  return null;
}

export async function reconcileSavedRecipes(plugin: PhotoWorkspace): Promise<void> {
  if (!plugin.catalog) return;
  const state = await plugin.bridge.run<Record<string, { operation: string; recipe: Recipe }>>('pixel-state');
  plugin.settings.pixelOperations ??= {};
  let changed = false;
  for (const [id, entry] of Object.entries(state)) {
    const key = `${plugin.catalog.key}:${id}`;
    if (plugin.settings.pixelOperations[key] === entry.operation) continue;
    // Recover a save interrupted after replacing the file but before clearing its recipe.
    if (JSON.stringify(plugin.settings.recipes[key]) === JSON.stringify(entry.recipe)) delete plugin.settings.recipes[key];
    plugin.settings.pixelOperations[key] = entry.operation; changed = true;
  }
  if (changed) await plugin.save();
}

export async function saveEdits(plugin: PhotoWorkspace, browser: BrowserView): Promise<void> {
  if (plugin.busy || plugin.scanning || !plugin.catalog) return;
  const preview = browser.mode === 'preview', current = preview ? browser.current : null;
  const filters = preview ? null : folderSaveFilters(browser.filters);
  if (!preview && !filters) { new Notice('Choose a folder in the left pane before saving its edited photos.'); return; }
  if (preview && !current) return;
  if (browser.cropMode) browser.finishCrop(true);
  plugin.busy = true;
  try { await browser.flushRecipe(); } catch (error) { plugin.busy = false; throw error; }
  const connection = structuredClone(plugin.settings), catalog = plugin.catalog.key, recipes = structuredClone(plugin.settings.recipes);
  plugin.busy = true; plugin.cancelled = false; plugin.emit('status');
  let saved = 0, skipped = 0; const errors: string[] = [], batch = randomUUID();
  try {
    let photos: Photo[] = current ? [current] : [];
    if (!preview) for (let offset = 0; !plugin.cancelled; offset += 300) {
      const page = await plugin.bridge.run<{ photos: Photo[]; hasMore: boolean }>('query', { settings: connection, filters: { ...filters, offset, limit: 300 } });
      photos.push(...page.photos); if (!page.hasMore) break;
    }
    for (const photo of photos) {
      if (plugin.cancelled) break;
      const key = `${catalog}:${photo.id}`, recipe = recipes[key] ?? freshRecipe();
      if (!hasEdits(recipe)) { skipped++; continue; }
      plugin.status = `Saving edits ${saved + errors.length + 1}: ${photo.name}`; plugin.emit('status');
      let bitmap: ImageBitmap | undefined, canvas: HTMLCanvasElement | undefined;
      try {
        if (!photo.path) throw new Error('Photo is offline.');
        const format = outputFormat(photo.name, 'original');
        const expectedHash = createHash('sha256').update(await readFile(photo.path)).digest('hex');
        const decoded = await decodePhoto(photo, plugin.bridge); bitmap = decoded.bitmap;
        if (decoded.embeddedPreview) throw new Error('Saving an embedded preview would lose image quality. Export a developed photo instead.');
        if (bitmap.width * bitmap.height > 60_000_000) throw new Error('Image exceeds the 60 megapixel editing limit.');
        canvas = renderPhoto(bitmap, recipe, Math.max(bitmap.width, bitmap.height));
        const bytes = await encodeCanvas(canvas, format.mime);
        const result = await plugin.bridge.run<{ operation: string }>('save-pixels', { settings: connection, id: photo.id, expectedHash, data: Buffer.from(bytes).toString('base64'), width: canvas.width, height: canvas.height, recipe, batch });
        delete plugin.settings.recipes[key];
        if (plugin.settings.luckyUndo) { delete plugin.settings.luckyUndo[key]; if (!Object.keys(plugin.settings.luckyUndo).length) delete plugin.settings.luckyUndo; }
        (plugin.settings.pixelOperations ??= {})[key] = result.operation;
        if (browser.current?.id === photo.id) browser.resetAfterFileSave();
        await plugin.save(); saved++;
      } catch (error) { errors.push(`${photo.name}: ${String(error)}`); }
      finally { bitmap?.close(); if (canvas) canvas.width = canvas.height = 1; }
    }
  } catch (error) { errors.push(String(error)); }
  finally {
    plugin.busy = false;
    plugin.status = `${saved} saved to originals · ${skipped} unchanged · ${errors.length} issues${plugin.cancelled ? ' · cancelled' : ''}`;
    browser.clearThumbnailCache();
    plugin.emit('status');
    if (current && plugin.catalog?.key === catalog) await browser.openPhoto(await plugin.bridge.run<Photo>('photo', { id: current.id }));
    else await browser.reload(true);
    new Notice(plugin.status + (errors.length ? '\n' + errors.join('\n') : '\nOriginal backups are available through Undo saved edits.'), 12000);
  }
}

export async function undoSavedEdits(plugin: PhotoWorkspace, browser: BrowserView): Promise<void> {
  if (plugin.busy || plugin.scanning) return;
  const current = browser.mode === 'preview' ? browser.current : null;
  plugin.busy = true;
  try {
    const result = await plugin.bridge.run<{ restored: number; ids: number[]; errors: { error: string }[] }>('undo-pixels', current ? { id: current.id } : {});
    for (const id of result.ids) delete plugin.settings.recipes[plugin.recipeKey(id)];
    if (current && result.ids.includes(current.id)) browser.resetAfterFileSave();
    await plugin.save(); browser.clearThumbnailCache();
    plugin.status = `${result.restored} original files restored${result.errors.length ? ': ' + result.errors.map(e => e.error).join('; ') : ''}`;
    new Notice(plugin.status, 10000);
  } catch (error) { plugin.fail(error); }
  finally {
    plugin.busy = false; plugin.emit('status');
    if (current) await browser.openPhoto(await plugin.bridge.run<Photo>('photo', { id: current.id })); else await browser.reload(true);
  }
}
