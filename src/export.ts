import { FileSystemAdapter, Modal, Setting } from 'obsidian';
import { isAbsolute, join, basename, extname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { copyOriginalFiles } from './copy-original';
import { hasEdits, outputFormat, encodeCanvas } from './encoding';

import type PhotoWorkspace from './main';
import { type Photo, type Filters, freshRecipe } from './types';
import { decodePhoto, renderPhoto, resizeDimensions } from './image-engine';

export class ExportPhotos extends Modal {
  private cancel = () => {};
  onClose(): void { this.cancel(); }
  constructor(private plugin: PhotoWorkspace) { super(plugin.app); }
  onOpen(): void {
    this.titleEl.setText('Export photos');
    this.contentEl.createEl('p', { text: 'Create copies in the original format, PNG, or JPG, with saved adjustments applied. Unedited originals at original dimensions are copied exactly. Resize preserves proportions. Originals are kept; existing destination files are never overwritten.' });
    let scope = 'selection', tag = '', album = '', destination = this.plugin.settings.exportFolder, mode = 'inside', width = 1920, height = 1080, percent = 50, upscale = false, format = 'original', quality = 95;
    new Setting(this.contentEl).setName('Photos to export').addDropdown(d => d.addOptions({ selection: 'Selected photos', filters: 'All photos matching current filters', tag: 'Photos with a tag (including subtags)', folder: 'Photos in a collection folder (including subfolders)' }).onChange(v => { scope = v; updateOptions(); }));
    const tagSetting = new Setting(this.contentEl).setName('Tag').addDropdown(d => { d.addOption('', 'Choose tag'); for (const value of this.plugin.availableTags()) d.addOption(value, value); d.onChange(v => { tag = v; }); });
    const albumSetting = new Setting(this.contentEl).setName('Collection folder').addDropdown(d => { d.addOption('', 'Choose folder'); for (const a of this.plugin.catalog?.albums ?? []) d.addOption(String(a.id), `${this.plugin.catalog?.roots.find(r => r.id === a.rootId)?.label ?? ''}: ${a.path}`); d.onChange(v => { album = v; }); });
    new Setting(this.contentEl).setName('Destination folder').setDesc('A folder name creates it inside the vault. You can also enter a full path to a folder elsewhere on this computer.').addText(t => t.setValue(destination).onChange(v => { destination = v.trim(); }));
    new Setting(this.contentEl).setName('Format').addDropdown(d => d.addOptions({ original: 'Keep as is (original format)', png: 'Convert to PNG', jpg: 'Convert to JPG' }).onChange(v => { format = v; updateOptions(); }));
    const qualitySetting = new Setting(this.contentEl).setName('JPG / WebP quality').setDesc('Used when encoding JPG or WebP. Transparent pixels become white in JPG.').addText(t => t.setValue(String(quality)).onChange(v => { quality = Number(v); }));
    new Setting(this.contentEl).setName('Resize').addDropdown(d => d.addOptions({ inside: 'Fit within width and height', percent: 'Percentage of edited dimensions', original: 'Keep edited dimensions' }).onChange(v => { mode = v; updateOptions(); }));
    const widthSetting = new Setting(this.contentEl).setName('Maximum width (pixels)').addText(t => t.setValue(String(width)).onChange(v => { width = Number(v); }));
    const heightSetting = new Setting(this.contentEl).setName('Maximum height (pixels)').addText(t => t.setValue(String(height)).onChange(v => { height = Number(v); }));
    const percentSetting = new Setting(this.contentEl).setName('Percentage').addText(t => t.setValue(String(percent)).onChange(v => { percent = Number(v); }));
    const upscaleSetting = new Setting(this.contentEl).setName('Allow enlarging smaller images').addToggle(t => t.setValue(false).onChange(v => { upscale = v; }));
    const updateOptions = () => {
      qualitySetting.settingEl.hidden = format === 'png';
      tagSetting.settingEl.hidden = scope !== 'tag'; albumSetting.settingEl.hidden = scope !== 'folder';
      widthSetting.settingEl.hidden = heightSetting.settingEl.hidden = mode !== 'inside';
      percentSetting.settingEl.hidden = mode !== 'percent'; upscaleSetting.settingEl.hidden = mode === 'original';
    };
    updateOptions();
    const progress = this.contentEl.createEl('p', { attr: { 'aria-live': 'polite' } });
    let cancelled = false, running = false;
    new Setting(this.contentEl).addButton(b => b.setButtonText('Cancel export').onClick(() => { cancelled = true; if (!running) this.close(); })).addButton(b => b.setButtonText('Export copies').setCta().onClick(async () => {
      if (this.plugin.busy || this.plugin.scanning) { progress.setText('Wait for the current operation to finish.'); return; }
      if (!(quality >= 1 && quality <= 100) || !destination || (mode === 'inside' && ![width, height].every(v => Number.isFinite(v) && v >= 1 && v <= 30000)) || (mode === 'percent' && !(percent > 0 && percent <= 400))) { progress.setText('Enter a destination and valid resize dimensions (1–30,000 pixels or 1–400%).'); return; }
      if (scope === 'tag' && !tag || scope === 'folder' && !album) { progress.setText('Choose the tag or folder to export.'); return; }
      const adapter = this.app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter) || !this.plugin.catalog) return;
      const connection = structuredClone(this.plugin.settings), key = this.plugin.catalog.key, recipes = structuredClone(this.plugin.settings.recipes);
      const root = isAbsolute(destination) ? resolve(destination) : resolve(adapter.getBasePath(), destination);
      if (!isAbsolute(destination) && destination.split(/[\\/]/).includes('..')) { progress.setText('Use a full path for destinations outside the vault.'); return; }
      running = true; cancelled = false; this.plugin.busy = true; b.setDisabled(true);
      this.contentEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select').forEach(el => { el.disabled = true; });
      let exported = 0; const errors: string[] = [];
      try {
        let photos: Photo[] = [];
        if (scope === 'selection') {
          for (const id of this.plugin.activeBrowser?.selected ?? []) photos.push(await this.plugin.bridge.run<Photo>('photo', { settings: connection, id }));
        } else {
          const selectedAlbum = this.plugin.catalog.albums.find(a => String(a.id) === album);
          const filters: Filters = scope === 'filters' ? { ...this.plugin.activeBrowser?.filters } : scope === 'tag' ? { tag, descendants: true } : { rootId: String(selectedAlbum!.rootId), folderPath: selectedAlbum!.path };
          for (let offset = 0; !cancelled; offset += 300) { const page = await this.plugin.bridge.run<{ photos: Photo[]; hasMore: boolean }>('query', { settings: connection, filters: { ...filters, limit: 300, offset } }); photos.push(...page.photos); if (!page.hasMore) break; }
        }
        if (!photos.length) { progress.setText('No photos match this export.'); return; }
        await mkdir(root, { recursive: true });
        for (const photo of photos) {
          if (cancelled) break;
          progress.setText(`Exporting ${exported + errors.length + 1} of ${photos.length}: ${photo.name}`);
          let bitmap: ImageBitmap | undefined, rendered: HTMLCanvasElement | undefined, output: HTMLCanvasElement | undefined;
          try {
            const recipe = recipes[`${key}:${photo.id}`] ?? freshRecipe();
            const stem = basename(photo.name, extname(photo.name)).replace(/[\\/:*?"<>|]/g, '-');
            if (format === 'original' && mode === 'original' && !hasEdits(recipe)) {
              if (!photo.path) throw new Error('Photo is offline.');
              const related = await this.plugin.bridge.run<string[]>('file-paths', { settings: connection, id: photo.id });
              await copyOriginalFiles(photo.path, related, root);
              exported++; continue;
            }
            const chosenFormat = outputFormat(photo.name, format);
            const decoded = await decodePhoto(photo, this.plugin.bridge); bitmap = decoded.bitmap;
            if (decoded.embeddedPreview) throw new Error('Full-quality export is unavailable for embedded RAW previews.');
            if (bitmap.width * bitmap.height > 60_000_000) throw new Error('Image exceeds the 60 megapixel editing limit.');
            rendered = renderPhoto(bitmap, recipe, Math.max(bitmap.width, bitmap.height)); bitmap.close(); bitmap = undefined;
            const size = resizeDimensions(rendered.width, rendered.height, mode, width, height, percent, upscale);
            output = document.createElement('canvas'); output.width = size.width; output.height = size.height;
            const context = output.getContext('2d')!; context.imageSmoothingQuality = 'high'; context.drawImage(rendered, 0, 0, output.width, output.height); rendered.width = rendered.height = 1;
            const bytes = await encodeCanvas(output, chosenFormat.mime, quality / 100);
            let path = join(root, stem + '-export' + chosenFormat.extension);
            for (let suffix = 2;; suffix++) { try { await writeFile(path, bytes, { flag: 'wx' }); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; path = join(root, `${stem}-export-${suffix}${chosenFormat.extension}`); } }
            exported++;
            try { await this.plugin.bridge.run('export-metadata', { settings: connection, id: photo.id, outputPath: path, exportRoot: root, width: output.width, height: output.height }); }
            catch (error) { errors.push(`${photo.name}: image exported, but metadata copy failed: ${String(error)}`); }
          } catch (error) { errors.push(`${photo.name}: ${String(error)}`); }
          finally { bitmap?.close(); if (rendered) rendered.width = rendered.height = 1; if (output) output.width = output.height = 1; }
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        progress.setText(`${exported} exported${cancelled ? ' (cancelled)' : ''} to ${root}. ${errors.length} issues.${errors.length ? '\n' + errors.join('\n') : ''}`);
      } catch (error) { progress.setText(String(error)); }
      finally { running = false; this.plugin.busy = false; b.setDisabled(false); this.contentEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select').forEach(el => { el.disabled = false; }); }
    }));
    this.cancel = () => { cancelled = true; };
  }
}
