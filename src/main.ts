import { registerAdvanced, advancedSettings } from './advanced';
import { Plugin, PluginSettingTab, Setting, Modal, Notice, FileSystemAdapter, WorkspaceLeaf, TFile, normalizePath, AbstractInputSuggest } from 'obsidian';
import { join, dirname, basename, extname } from 'node:path';
import { reconcileSavedRecipes } from './save-edits';
import { ExportPhotos } from './export';
import { trashPhotoFiles } from './system';
import { Bridge } from './bridge';
import { DEFAULT_SETTINGS, Settings, CatalogInfo, MetadataPatch, WriteResult, Recipe, Photo, freshRecipe, TagChange, parsePhotoTags } from './types';
import { TagsView, FiltersView, BrowserView, InspectorView, VIEW_TYPES } from './views';

export default class PhotoWorkspace extends Plugin {
  settings: Settings = structuredClone(DEFAULT_SETTINGS);
  bridge!: Bridge;
  catalog: CatalogInfo | null = null;
  activeBrowser: BrowserView | null = null;
  readonly events = new EventTarget();
  clipboard: { mode: 'copy' | 'move'; ids: number[]; catalog: string } | null = null;
  scanning = false;
  scanResult: { key: string; text: string; verified: boolean; errors: string[] } | null = null;
  busy = false;
  cancelled = false;
  status = 'Choose a photo folder to begin';
  private saveChain = Promise.resolve();

  async onload(): Promise<void> {
    const stored = { ...await this.loadData() };
    // Retire connection settings without touching saved recipes, tags, or undo data.
    delete stored.sourceMode; delete stored.databasePath; delete stored.rootMappings;
    this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...stored };
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) { new Notice('Coherence Photo requires desktop filesystem access.'); return; }
    this.bridge = new Bridge(() => this.settings, join(adapter.getBasePath(), this.app.vault.configDir, 'plugins', this.manifest.id, 'local-data'));
    this.registerView(VIEW_TYPES.tags, leaf => new TagsView(leaf, this));
    this.registerView(VIEW_TYPES.filters, leaf => new FiltersView(leaf, this));
    this.registerView(VIEW_TYPES.browser, leaf => new BrowserView(leaf, this));
    this.registerView(VIEW_TYPES.inspector, leaf => new InspectorView(leaf, this));
    this.addRibbonIcon('images', 'Open photo library', () => { void this.openWorkspace(); });
    this.addCommand({ id: 'open-workspace', name: 'Open photo library', callback: () => { void this.openWorkspace(); } });
    this.addCommand({ id: 'reset-layout', name: 'Reset photo pane layout', callback: () => {
      for (const type of Object.values(VIEW_TYPES)) this.app.workspace.detachLeavesOfType(type);
      void this.openWorkspace();
    } });
    this.addCommand({ id: 'configure', name: 'Configure collection connection', callback: () => this.openSettings() });
    this.addCommand({ id: 'refresh', name: 'Refresh photo catalog', callback: () => { void this.refresh(); } });
    this.addCommand({ id: 'assign-tags', name: 'Assign tags to selected photos', callback: () => this.tagPrompt() });
    this.addCommand({ id: 'undo-metadata', name: 'Undo last metadata batch', callback: () => { void this.undo(); } });
    const photoCommand = (id: string, name: string, available: () => boolean, run: () => void) => this.addCommand({ id, name, checkCallback: checking => { const enabled = available(); if (enabled && !checking) run(); return enabled; } });
    const hasPhotos = () => !!this.activeBrowser && !!this.catalog;
    const hasSelection = () => hasPhotos() && !!this.activeBrowser?.selected.size && !this.busy && !this.scanning;
    for (let rating = 0; rating <= 5; rating++) photoCommand(`rate-${rating}`, rating ? `Assign ${rating}-star rating to selected photos` : 'Clear rating of selected photos', hasSelection, () => { void this.apply({ rating }); });
    photoCommand('preview-photo', 'Open photo preview', () => hasPhotos() && !!this.activeBrowser?.photos.length, () => {
      const browser = this.activeBrowser!;
      const photo = browser.photos.find(p => browser.selected.has(p.id)) ?? browser.photos[0];
      if (photo) void browser.openPhoto(photo);
    });
    photoCommand('adjust-crop', 'Adjust or cancel crop', () => hasPhotos() && this.activeBrowser?.mode === 'preview', () => { const browser = this.activeBrowser!; if (browser.cropMode) browser.finishCrop(false); else browser.beginCrop(); });
    photoCommand('rotate-photo', 'Rotate selected photos clockwise', hasSelection, () => { void this.activeBrowser?.rotateSelected(); });
    photoCommand('previous-photo', 'Select previous photo', hasPhotos, () => { void this.activeBrowser?.navigate(-1); });
    photoCommand('next-photo', 'Select next photo', hasPhotos, () => { void this.activeBrowser?.navigate(1); });
    photoCommand('save-edits', 'Save image edits to original files', hasPhotos, () => { void this.activeBrowser?.saveEdits(); });
    photoCommand('undo-edits', 'Undo photo adjustment', hasPhotos, () => { void this.activeBrowser?.undoEdit(); });
    photoCommand('redo-edits', 'Redo photo adjustment', hasPhotos, () => this.activeBrowser?.redoRecipe());
    photoCommand('undo-saved-edits', 'Undo saved image edits', hasPhotos, () => { void this.activeBrowser?.undoSavedEdits(); });
    photoCommand('show-grid', 'Return to photo thumbnails', () => hasPhotos() && this.activeBrowser?.mode === 'preview', () => this.activeBrowser?.showGrid());
    photoCommand('export-photos', 'Export photos', hasPhotos, () => this.exportPhotos());
    photoCommand('feeling-lucky', 'Apply I’m Feeling Lucky to selected photos', hasSelection, () => { void this.luckyBatch(); });
    registerAdvanced(this);
    this.addSettingTab(new PhotoSettings(this));
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => {
      if (leaf?.view instanceof BrowserView) { this.activeBrowser = leaf.view; this.emit('selection'); this.emit('filters'); }
    }));
    this.registerObsidianProtocolHandler('photo-workspace', async params => {
      await this.openWorkspace();
      if (params.catalog !== this.catalog?.key) { new Notice('This link belongs to a different photo catalog.'); return; }
      try {
        const photo = await this.bridge.run<Photo>('photo', { id: Number(params.id) });
        await this.activeBrowser?.openPhoto(photo);
      } catch (error) { this.fail(error); }
    });
    this.app.workspace.onLayoutReady(() => { if (this.hasConnection()) void this.refresh(); });
  }
  onunload(): void { this.bridge?.stop(); }
  save(): Promise<void> {
    this.saveChain = this.saveChain.catch(() => {}).then(() => this.saveData(this.settings));
    return this.saveChain;
  }
  emit(type: string): void { this.events.dispatchEvent(new Event(type)); }
  subscribe(type: string, listener: () => void): () => void {
    this.events.addEventListener(type, listener); return () => this.events.removeEventListener(type, listener);
  }
  fail(error: unknown): void { this.status = error instanceof Error ? error.message : String(error); this.emit('status'); new Notice(this.status, 9000); }
  async ensureView(type: string, side: 'left' | 'right' | 'center'): Promise<WorkspaceLeaf> {
    let leaf = this.app.workspace.getLeavesOfType(type)[0];
    if (!leaf) {
      leaf = side === 'left' ? this.app.workspace.getLeftLeaf(false)! : side === 'right' ? this.app.workspace.getRightLeaf(false)! : this.app.workspace.getLeaf('tab');
      if (!leaf) throw new Error('Could not create photo workspace pane.');
      await leaf.setViewState({ type, active: true });
    }
    return leaf;
  }
  async openWorkspace(): Promise<void> {
    try {
      await this.ensureView(VIEW_TYPES.filters, 'left');
      const tags = await this.ensureView(VIEW_TYPES.tags, 'left');
      const inspector = await this.ensureView(VIEW_TYPES.inspector, 'right');
      const browser = await this.ensureView(VIEW_TYPES.browser, 'center');
      await this.app.workspace.revealLeaf(tags); await this.app.workspace.revealLeaf(inspector);
      await this.app.workspace.revealLeaf(browser);
      if (browser.view instanceof BrowserView) this.activeBrowser = browser.view;
      if (!this.catalog && this.hasConnection()) await this.refresh();
      else this.emit('selection');
      if (!this.hasConnection()) this.openSettings();
    } catch (error) { this.fail(error); }
  }
  hasConnection(): boolean { return !!this.settings.photoFolder; }
  connectionKey(settings = this.settings): string { return JSON.stringify([settings.photoFolder]); }
  openSettings(): void { new ConnectionModal(this).open(); }
  async refresh(): Promise<void> {
    if (this.busy || this.scanning) return;
    this.scanning = true; this.scanResult = null;
    const key = this.connectionKey();
    try {
      this.status = 'Finding photos…'; this.emit('status');
      const scanned = await this.bridge.run<CatalogInfo>('scan', {}, progress => {
        this.status = `Reading metadata: ${progress.processed.toLocaleString()} / ${progress.total.toLocaleString()}${progress.errors ? ` · ${progress.errors} unreadable` : ''}`; this.emit('status');
      });
      if (key !== this.connectionKey()) return;
      await this.bridge.run('recover');
      this.catalog = await this.bridge.run<CatalogInfo>('catalog');
      await reconcileSavedRecipes(this);
      const report = scanned?.scanReport;
      const failed = report?.failed ?? 0;
      this.status = `${this.catalog.count.toLocaleString()} photos${failed ? ` · ${failed} unreadable` : ''}`;
      this.scanResult = { key, verified: !failed, text: `${failed ? 'Scan completed with warnings' : '✓ Verified'} · ${this.catalog.count.toLocaleString()} photos · ${this.catalog.tags.length.toLocaleString()} tags${failed ? ` · ${failed} unreadable` : ''}`, errors: report?.errors ?? [] };
      this.emit('catalog');
    } catch (error) {
      this.scanResult = { key, verified: false, text: `Scan failed: ${error instanceof Error ? error.message : String(error)}`, errors: [] }; this.fail(error);
    } finally { this.scanning = false; this.emit('status'); }
  }
  async apply(patch: MetadataPatch, ids = [...(this.activeBrowser?.selected ?? [])], tagChange?: TagChange): Promise<void> {
    if (this.scanning) { new Notice('Wait for the photo scan to finish.'); return; }
    if (!ids.length) { new Notice('Select one or more photos first.'); return; }
    if (!this.settings.writesEnabled) { new Notice('Enable metadata writing in the connection settings first.'); this.openSettings(); return; }
    if (this.busy) { new Notice('A metadata batch is already running.'); return; }
    this.busy = true; this.cancelled = false;
    this.emit('status');
    const connection = structuredClone(this.settings);
    const browser = this.activeBrowser;
    const batch = crypto.randomUUID(), errors: { id: number; error: string }[] = [];
    let complete = 0;
    try {
      // Small batches expose progress and provide a cancellation boundary between groups.
      for (let start = 0; start < ids.length && !this.cancelled; start += 5) {
        this.status = `Saving metadata: ${start} / ${ids.length}…`; this.emit('status');
        const result = await this.bridge.run<WriteResult>('write', { settings: connection, ids: ids.slice(start, start + 5), patch, batch, tagChange });
        errors.push(...result.errors); complete += result.successes.length;
        for (const success of result.successes) browser?.updatePhoto(success.id, success.metadata);
      }
      this.status = `${complete} saved · ${errors.length} failed${this.cancelled ? ' · batch cancelled' : ''} · metadata saved to files`;
      new Notice(this.status, 7000);
      if (errors.length) new MessageModal(this, 'Metadata results', errors.map(e => `Photo ${e.id}: ${e.error}`).join('\n\n')).open();
      if (tagChange && !errors.length && !this.cancelled && this.catalog) {
        const key = this.catalog.key;
        this.settings.customTags[key] = (this.settings.customTags[key] ?? []).flatMap(tag => (tagChange.fromTags ?? [tagChange.from]).some(from => tag === from || (tagChange.descendants && tag.startsWith(from + '/'))) ? (tagChange.to ? [tagChange.to + tag.slice(tagChange.from.length)] : []) : [tag]);
        await this.save();
      }
      this.catalog = await this.bridge.run<CatalogInfo>('catalog', { settings: connection }); this.emit('tags'); this.emit('selection');
      if (browser?.mode === 'grid' && this.connectionKey() === this.connectionKey(connection)) await browser.reload(true);
    } catch (error) { this.fail(error); }
    finally {
      this.busy = false; this.emit('status');
      if (this.connectionKey() !== this.connectionKey(connection)) await this.refresh();
    }
  }
  async undo(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const result = await this.bridge.run<{ restored: number; errors: { error: string }[] }>('undo');
      new Notice(`Restored metadata for ${result.restored} photos.`);
      if (result.errors.length) new MessageModal(this, 'Undo conflicts', result.errors.map(e => e.error).join('\n')).open();
    } catch (error) { this.fail(error); }
    finally { this.busy = false; await this.refresh(); }
  }
  copyPhotos(ids: number[], cut = false): void {
    if (!this.catalog || !ids.length) return;
    this.clipboard = { mode: cut ? 'move' : 'copy', ids: [...ids], catalog: this.catalog.key };
    new Notice(`${ids.length} photos ready to ${cut ? 'move' : 'copy'}. Choose Paste on a destination photo or folder.`);
  }
  pastePhotos(directory: string): void {
    const clipboard = this.clipboard;
    if (!clipboard || clipboard.catalog !== this.catalog?.key) { new Notice('Copy or cut photos from this collection first.'); return; }
    new TextPrompt(this, 'Paste photos', 'Enter a destination folder inside this photo collection. Existing files are never overwritten; copies receive a new filename when needed.', directory, destination => {
      if (clipboard.catalog !== this.catalog?.key) { new Notice('Collection changed. Copy or cut the photos again.'); return; }
      void this.fileBatch(clipboard.ids, async (id, connection) => {
        const photo = await this.bridge.run<Photo>('photo', { settings: connection, id });
        let path = join(destination.trim(), photo.name);
        if (clipboard.mode === 'copy') { const { existsSync } = await import('node:fs'); let suffix = 2; while (existsSync(path)) path = join(destination.trim(), `${basename(photo.name, extname(photo.name))}-copy-${suffix++}${extname(photo.name)}`); }
        await this.bridge.run('file-operation', { settings: connection, id, operation: clipboard.mode, destination: path });
      }).then(() => { if (clipboard.mode === 'move') this.clipboard = null; });
    }).open();
  }
  renamePhoto(photo: Photo): void {
    if (!photo.path) return;
    const catalog = this.catalog?.key;
    new TextPrompt(this, 'Rename photo', 'Enter a filename, keeping its extension. Associated sidecars move with it.', photo.name, name => {
      if (!name.trim() || name !== basename(name) || /[\\/:*?"<>|]/.test(name)) { new Notice('Enter a filename without folder separators.'); return; }
      if (catalog !== this.catalog?.key) { new Notice('Collection changed. Reopen Rename.'); return; }
      void this.fileBatch([photo.id], (id, connection) => this.bridge.run('file-operation', { settings: connection, id, operation: 'move', destination: join(dirname(photo.path!), name.trim()) }));
    }).open();
  }
  deletePhotos(ids: number[], verify?: (id: number) => Promise<void>): void {
    const catalog = this.catalog?.key;
    new ConfirmAction(this, 'Delete photos', `Move ${ids.length} photos and their associated sidecars to the system Trash/Recycle Bin? Restore them there if needed. Metadata Undo does not restore deleted files.`, 'Move to Trash', () => {
      if (catalog !== this.catalog?.key) { new Notice('Collection changed. Reopen Delete.'); return; }
      void this.fileBatch(ids, async (id, connection) => { await verify?.(id); const paths = await this.bridge.run<string[]>('file-paths', { settings: connection, id }); await trashPhotoFiles(paths); await this.bridge.run('file-deleted', { settings: connection, id }); });
    }).open();
  }
  private async fileBatch(ids: number[], action: (id: number, connection: Settings) => Promise<unknown>): Promise<void> {
    if (this.busy) { new Notice('Wait for the current operation to finish.'); return; }
    this.busy = true; this.cancelled = false; const connection = structuredClone(this.settings); const errors: string[] = []; let done = 0;
    try { for (const id of ids) { if (this.cancelled) break; this.status = `Updating files ${done + 1}/${ids.length}`; this.emit('status'); try { await action(id, connection); done++; } catch (error) { errors.push(`Photo ${id}: ${String(error)}`); } } }
    finally { this.busy = false; await this.refresh(); }
    new Notice(`${done} file operations completed. ${errors.length} failed.`, 9000);
    if (errors.length) new MessageModal(this, 'File operation results', errors.join('\n\n')).open();
  }
  async luckyBatch(): Promise<void> {
    const browser = this.activeBrowser, catalog = this.catalog?.key;
    if (!browser || !catalog || !browser.selected.size) { new Notice('Select photos first.'); return; }
    if (this.busy || this.scanning) return;
    if (browser.mode === 'preview') { browser.commitRecipe({ ...browser.recipe, auto: 100 }); this.emit('selection'); return; }
    this.settings.luckyUndo = {};
    for (const id of browser.selected) { this.settings.luckyUndo[`${catalog}:${id}`] = this.settings.recipes[`${catalog}:${id}`] ? structuredClone(this.settings.recipes[`${catalog}:${id}`]) : null; const recipe = structuredClone(this.settings.recipes[`${catalog}:${id}`] ?? freshRecipe()); recipe.auto = 100; this.settings.recipes[`${catalog}:${id}`] = recipe; }
    await this.save(); browser.refreshEditedThumbnails(); new Notice(`Automatic adjustment saved for ${browser.selected.size} photos. Save or export applies it to image pixels.`);
  }
  async undoLuckyBatch(): Promise<void> { for (const [key, recipe] of Object.entries(this.settings.luckyUndo ?? {})) { if (recipe) this.settings.recipes[key] = recipe; else delete this.settings.recipes[key]; } delete this.settings.luckyUndo; await this.save(); this.activeBrowser?.refreshEditedThumbnails(); new Notice('Restored recipes from before the last batch adjustment.'); }
  exportPhotos(): void { if (this.busy || this.scanning) return; void (async () => { await this.activeBrowser?.flushRecipe(); new ExportPhotos(this).open(); })().catch(error => this.fail(error)); }
  availableTags(): string[] { return [...new Set([...(this.catalog?.tags ?? []), ...(this.settings.customTags[this.catalog?.key ?? ''] ?? [])])].sort((a, b) => a.localeCompare(b)); }
  tagPrompt(): void { new TagPrompt(this).open(); }
  deleteTags(tags: string[]): void { new DeleteTagsModal(this, tags).open(); }
  manageTag(tag: string, deleting: boolean): void { new ManageTagModal(this, tag, deleting).open(); }
  recipeKey(id: number): string { return `${this.catalog?.key}:${id}`; }
  async saveRecipe(id: number, recipe: Recipe, catalog = this.catalog?.key): Promise<void> { if (!catalog) return; this.settings.recipes[`${catalog}:${id}`] = structuredClone(recipe); await this.save(); }
  async createPhotoNote(photo: Photo): Promise<void> {
    const folder = 'Photo notes';
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const link = `obsidian://photo-workspace?catalog=${encodeURIComponent(this.catalog!.key)}&id=${photo.id}`;
    const filename = photo.name.replace(/[\\/:*?"<>|\[\]#^]/g, '-');
    const notePath = normalizePath(`${folder}/${filename} (${photo.id}).md`);
    let note = this.app.vault.getAbstractFileByPath(notePath);
    if (!note) note = await this.app.vault.create(notePath, `---\nphoto_catalog: ${JSON.stringify(this.catalog!.key)}\nphoto_id: ${photo.id}\n---\n\n# ${photo.name}\n\n[Open photo in Coherence Photo](${link})\n\n`);
    if (note instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(note);
  }
}

class ConfirmAction extends Modal {
  constructor(plugin: PhotoWorkspace, private heading: string, private message: string, private actionLabel: string, private action: () => void) { super(plugin.app); }
  onOpen(): void { this.titleEl.setText(this.heading); this.contentEl.createEl('p', { text: this.message }); new Setting(this.contentEl).addButton(b => b.setButtonText('Cancel').onClick(() => this.close())).addButton(b => b.setButtonText(this.actionLabel).setWarning().onClick(() => { this.close(); this.action(); })); }
}
class TagSuggestions extends AbstractInputSuggest<string> {
  constructor(private plugin: PhotoWorkspace, input: HTMLInputElement, private choose: (tag: string) => void) { super(plugin.app, input); this.limit = 30; }
  getSuggestions(query: string): string[] { const term = query.trim().toLocaleLowerCase(); return term ? this.plugin.availableTags().filter(tag => tag.toLocaleLowerCase().includes(term)) : []; }
  renderSuggestion(tag: string, el: HTMLElement): void { el.setText(tag); }
  selectSuggestion(tag: string): void { this.choose(tag); this.setValue(''); this.close(); }
}
export class TagPrompt extends Modal {
  private suggestions?: TagSuggestions;
  constructor(private plugin: PhotoWorkspace) { super(plugin.app); }
  onOpen(): void {
    const ids = [...(this.plugin.activeBrowser?.selected ?? [])], catalog = this.plugin.catalog?.key;
    this.titleEl.setText('Add tags'); this.contentEl.createEl('p', { text: 'Type to find an existing tag, or enter new tags separated by commas. Select suggestions with the mouse or arrow keys and Enter. Press Enter to queue a tag. When the field is empty, press Enter again to save all queued tags. Export is not required.' });
    const input = this.contentEl.createEl('input', { type: 'text', cls: 'pw-tag-entry', placeholder: 'Search or create a tag…', attr: { 'aria-label': 'Search or create a tag' } });
    const queue = this.contentEl.createDiv('pw-tag-queue'), chosen = new Set<string>();
    const add = (value: string): boolean => { try { for (const tag of parsePhotoTags(value)) chosen.add(tag); input.value = ''; render(); return true; } catch (error) { this.plugin.fail(error); return false; } };
    const render = () => { queue.empty(); for (const tag of chosen) { const chip = queue.createEl('button', { text: tag + ' ×' }); chip.onclick = () => { chosen.delete(tag); render(); }; } };
    this.suggestions = new TagSuggestions(this.plugin, input, add);
    const apply = () => {
      if (!add(input.value) || !chosen.size) return;
      if (catalog !== this.plugin.catalog?.key) { new Notice('The collection changed. Reopen Add tags.'); return; }
      void this.plugin.apply({ addTags: [...chosen] }, ids); this.close();
    };
    // Capture the empty-field key before the suggestion popup can consume it.
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing || event.repeat) return;
      if (!input.value.trim()) { event.preventDefault(); event.stopImmediatePropagation(); apply(); }
    }, true);
    this.scope.register([], 'Enter', event => {
      if (event.isComposing || event.repeat) return false;
      if (input.value.trim()) { if (add(input.value)) this.suggestions?.close(); }
      else apply();
      return false;
    });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Add typed tag').onClick(() => add(input.value))).addButton(b => b.setButtonText('Apply tags').setCta().onClick(apply));
    input.focus();
  }
  onClose(): void { this.suggestions?.close(); this.plugin.activeBrowser?.contentEl.focus(); }
}
class DeleteTagsModal extends Modal {
  constructor(private plugin: PhotoWorkspace, private tags: string[]) { super(plugin.app); }
  onOpen(): void {
    const catalog = this.plugin.catalog?.key;
    this.titleEl.setText(`Delete ${this.tags.length} selected tag${this.tags.length === 1 ? '' : 's'}`);
    this.contentEl.createEl('p', { text: 'Remove these tags from all matching photos in the connected collection. Photo files and unrelated tags are kept. Metadata Undo can restore successful writes.' });
    this.contentEl.createEl('p', { text: this.tags.join(', ') });
    let descendants = true;
    const confirmation = this.contentEl.createDiv();
    new Setting(this.contentEl).setName('Include subtags').addToggle(t => t.setValue(true).onChange(value => { descendants = value; confirmation.empty(); }));
    const review = new Setting(this.contentEl).addButton(b => b.setButtonText('Review affected photos').onClick(async () => {
      b.setDisabled(true); confirmation.empty(); const include = descendants;
      try {
        const ids = await this.plugin.bridge.run<number[]>('tag-ids', { tags: this.tags, descendants: include });
        if (catalog !== this.plugin.catalog?.key) throw new Error('Collection changed. Reopen this dialog.');
        if (include !== descendants) return;
        confirmation.createEl('p', { text: `${ids.length.toLocaleString()} distinct photos will be updated. Unavailable or unsupported files are reported individually.` });
        new Setting(confirmation).addButton(confirm => confirm.setButtonText(`Delete tags from ${ids.length.toLocaleString()} photos`).setWarning().onClick(() => {
          if (catalog !== this.plugin.catalog?.key || include !== descendants) { new Notice('Review the selection again.'); return; }
          if (ids.length) void this.plugin.apply({}, ids, { from: this.tags[0], fromTags: this.tags, to: null, descendants: include });
          else if (catalog) {
            this.plugin.settings.customTags[catalog] = (this.plugin.settings.customTags[catalog] ?? []).filter(tag => !this.tags.some(from => tag === from || (include && tag.startsWith(from + '/'))));
            void this.plugin.save(); this.plugin.emit('tags');
          }
          this.close();
        }));
      } catch (error) { this.plugin.fail(error); } finally { b.setDisabled(false); }
    }));
    review.settingEl.after(confirmation);
  }
}
class ManageTagModal extends Modal {
  constructor(private plugin: PhotoWorkspace, private tag: string, private deleting: boolean) { super(plugin.app); }
  onOpen(): void {
    this.titleEl.setText(this.deleting ? 'Delete tag from photos' : 'Rename tag');
    const catalog = this.plugin.catalog?.key;
    this.contentEl.createEl('p', { text: `Tag: ${this.tag}. This applies to the entire connected collection, including photos outside the current view. Photo files are kept. Metadata Undo can restore successful changes.` });
    let destination = this.tag, descendants = true;
    if (!this.deleting) new Setting(this.contentEl).setName('New full tag name').addText(t => t.setValue(destination).onChange(value => { destination = value.trim(); }));
    new Setting(this.contentEl).setName('Include subtags').setDesc('Rename preserves the hierarchy below this tag; delete removes those descendant tags as well.').addToggle(t => t.setValue(true).onChange(v => { descendants = v; }));
    const result = this.contentEl.createEl('p');
    new Setting(this.contentEl).addButton(b => b.setButtonText('Review affected photos').setCta().onClick(async () => {
      if (!this.deleting && (!destination || destination === this.tag || destination.split('/').some(p => !p.trim()) || /[|\n\r]/.test(destination))) { new Notice('Enter a different valid tag name.'); return; }
      b.setDisabled(true);
      try {
        const from = this.tag, to = this.deleting ? null : destination, include = descendants;
        const ids = await this.plugin.bridge.run<number[]>('tag-ids', { tag: from, descendants: include });
        if (catalog !== this.plugin.catalog?.key) throw new Error('Collection changed. Reopen this dialog.');
        result.setText(`${ids.length} photos will be updated${to ? ' to ' + to : ''}. Unsupported or unavailable files are reported and remain unchanged.`);
        new Setting(this.contentEl).addButton(confirm => confirm.setButtonText(this.deleting ? `Delete from ${ids.length} photos` : `Rename in ${ids.length} photos`).setWarning().onClick(() => {
          if (catalog !== this.plugin.catalog?.key) { new Notice('Collection changed. Reopen this dialog.'); return; }
          if (!ids.length) { const key = catalog!; this.plugin.settings.customTags[key] = (this.plugin.settings.customTags[key] ?? []).flatMap(tag => tag === from || (include && tag.startsWith(from + '/')) ? (to ? [to + tag.slice(from.length)] : []) : [tag]); void this.plugin.save(); this.plugin.emit('tags'); }
          else void this.plugin.apply({}, ids, { from, to, descendants: include });
          this.close();
        }));
      } catch (error) { this.plugin.fail(error); b.setDisabled(false); }
    }));
  }
}

export class TextPrompt extends Modal {
  constructor(private plugin: PhotoWorkspace, private heading: string, private description: string, private initial: string, private submit: (text: string) => void) { super(plugin.app); }
  onOpen(): void {
    this.titleEl.setText(this.heading); this.contentEl.createEl('p', { text: this.description });
    const input = this.contentEl.createEl('textarea', { cls: 'pw-prompt-input' }); input.value = this.initial; input.rows = 4;
    new Setting(this.contentEl).addButton(b => b.setButtonText('Cancel').onClick(() => this.close())).addButton(b => b.setButtonText('Apply').setCta().onClick(() => { this.submit(input.value); this.close(); }));
    input.focus();
  }
}
class MessageModal extends Modal {
  constructor(plugin: PhotoWorkspace, private heading: string, private message: string) { super(plugin.app); }
  onOpen(): void { this.titleEl.setText(this.heading); this.contentEl.createEl('pre', { cls: 'pw-message', text: this.message }); }
}
class ConnectionModal extends Modal {
  constructor(private plugin: PhotoWorkspace) { super(plugin.app); }
  onOpen(): void { this.titleEl.setText('Coherence Photo connection'); this.modalEl.addClass('pw-connection-modal'); renderSettings(this.contentEl, this.plugin); }
}
class PhotoSettings extends PluginSettingTab {
  constructor(private plugin: PhotoWorkspace) { super(plugin.app, plugin); }
  display(): void { this.containerEl.empty(); renderSettings(this.containerEl, this.plugin); }
}

function renderSettings(el: HTMLElement, plugin: PhotoWorkspace): void {
  const settings = plugin.settings;
  setupHelp(el, plugin);
  new Setting(el).setName('Include subfolders when browsing').setDesc('On: show the selected folder first, then its subfolders in alphabetical hierarchy order with dividers as you scroll. Off: show only photos directly in the selected folder. Photo sorting applies within each folder.').addToggle(t => t.setValue(settings.includeSubfolders).onChange(async value => { settings.includeSubfolders = value; await plugin.save(); const browser = plugin.activeBrowser; if (browser?.filters.folderAbsolute) { browser.filters.folderRecursive = value; browser.filters.groupFolders = value; await browser.reload(); plugin.emit('filters'); } }));
  el.createEl('p', { cls: 'pw-hint', text: 'Keyboard: ← / → moves through previews, 1–5 rates selected photos, and T opens Add tags in either view. Cmd/Ctrl+S saves edits to originals; Cmd/Ctrl+Z undoes adjustments. You can assign your own shortcuts in Obsidian Settings → Hotkeys; search for Coherence Photo.' });
    new Setting(el).setName('Photo folder').setDesc('Paste the full folder path. All subfolders are included; hidden folders are skipped. Click Scan photos after adding, moving, or changing files outside the plugin.').addText(t => t.setValue(settings.photoFolder).onChange(async value => { settings.photoFolder = value.trim(); plugin.scanResult = null; plugin.emit('status'); await plugin.save(); })).addButton(b => b.setButtonText('Use this vault').onClick(async () => { const adapter = plugin.app.vault.adapter; if (adapter instanceof FileSystemAdapter) { settings.photoFolder = adapter.getBasePath(); plugin.scanResult = null; await plugin.save(); el.empty(); renderSettings(el, plugin); } }));
  new Setting(el).setName('Python executable').setDesc('Leave blank to detect Python 3.').addText(t => t.setValue(settings.pythonPath).onChange(async v => { settings.pythonPath = v.trim(); await plugin.save(); }));
  new Setting(el).setName('ExifTool executable').setDesc('Leave blank to detect a separately installed ExifTool, or enter its full executable path.').addText(t => t.setValue(settings.exiftoolPath).onChange(async v => { settings.exiftoolPath = v.trim(); await plugin.save(); }));
  const scanSetting = new Setting(el).setName('Scan photos').setDesc('Reads image files and their existing tags, ratings, and properties into a local index. Finds new or changed photos and removes missing ones from the index. It does not change your photos. Large first scans can take a while; later scans reuse unchanged files.');
  const scanStatus = scanSetting.controlEl.createSpan({ cls: 'pw-scan-result', attr: { role: 'status', 'aria-live': 'polite' } });
  const errors = el.createEl('details', { cls: 'pw-scan-errors' });
  const updateStatus = () => {
    const result = plugin.scanResult?.key === plugin.connectionKey() ? plugin.scanResult : null;
    scanStatus.setText(plugin.scanning ? plugin.status : result?.text ?? 'Not yet verified');
    scanStatus.toggleClass('is-verified', !plugin.scanning && !!result?.verified);
    scanStatus.toggleClass('is-warning', !plugin.scanning && !!result && !result.verified);
    errors.empty(); errors.hidden = !result?.errors.length;
    if (result?.errors.length) { errors.createEl('summary', { text: 'Files that could not be read (first 20)' }); for (const error of result.errors) errors.createEl('p', { text: error }); }
  };
  scanSetting.addButton(b => {
    const update = () => { updateStatus(); b.setDisabled(plugin.scanning); b.setButtonText(plugin.scanning ? 'Scanning…' : 'Scan photos'); };
    b.setCta().onClick(async () => { await plugin.refresh(); update(); if (plugin.scanResult?.verified) new Notice(plugin.scanResult.text, 7000); });
    const unsubscribe = plugin.subscribe('status', update);
    const observer = new MutationObserver(() => { if (!scanStatus.isConnected) { unsubscribe(); observer.disconnect(); } });
    observer.observe(document.body, { childList: true, subtree: true }); plugin.register(() => { unsubscribe(); observer.disconnect(); });
    update();
  });
  new Setting(el).setName('Metadata writing').setHeading();
  new Setting(el).setName('Enable metadata writing').setDesc('Writes photo metadata or sidecars when you assign tags, ratings or labels. Each operation is backed up locally for undo.').addToggle(t => t.setValue(settings.writesEnabled).onChange(async v => { settings.writesEnabled = v; await plugin.save(); }));
  new Setting(el).setName('Write destination').setDesc('Embedded writes update metadata inside the photo using ExifTool, preserving image pixels. Unsupported formats are reported; sidecars are never created automatically.').addDropdown(d => d.addOption('embedded', 'Inside image file (JPEG, PNG, TIFF, WebP)').addOption('sidecar', 'Separate XMP sidecar (optional)').setValue(settings.writeMode).onChange(async v => { settings.writeMode = v as Settings['writeMode']; await plugin.save(); el.empty(); renderSettings(el, plugin); }));
  if (settings.writeMode === 'sidecar') new Setting(el).setName('Sidecar filename').addDropdown(d => d.addOption('full', 'photo.jpg.xmp (full filename)').addOption('stem', 'photo.xmp (shared stem)').setValue(settings.sidecarNaming).onChange(async v => { settings.sidecarNaming = v as Settings['sidecarNaming']; await plugin.save(); }));
  el.createEl('p', { cls: 'pw-hint', text: settings.writeMode === 'embedded'
    ? 'Metadata is saved inside JPEG (.jpg, .jpeg), PNG, TIFF (.tif, .tiff), and WebP files. Local backups enable Undo. Existing sidecars are not removed; other applications may need to reread changed files.'
    : 'Metadata is saved in separate XMP files beside your photos. Keep these sidecars with the images when moving the collection.' });
  new Setting(el).setName('Edited exports').setHeading();
  new Setting(el).setName('Vault export folder').setDesc('Edited copies are saved here as sRGB PNG files. Original image files remain unchanged.').addText(t => t.setValue(settings.exportFolder).onChange(async v => { settings.exportFolder = v.trim() || 'Photo exports'; await plugin.save(); }));
  new Setting(el).addButton(b => b.setButtonText('Refresh workspace').onClick(() => { void plugin.refresh(); }));
  advancedSettings(el, plugin);
}

function setupHelp(el: HTMLElement, plugin: PhotoWorkspace): void {
  const help = el.createEl('details', { cls: 'pw-setup-help' }); help.open = !plugin.hasConnection();
  help.createEl('summary', { text: 'Getting started — what to install' });
  help.createEl('p', { text: 'Coherence Photo needs two free helpers: Python runs the local photo catalog, and ExifTool reads and changes photo metadata. They work on your computer; your photos are not uploaded.' });
  const step = (title: string, text: string, url: string, label: string) => { help.createEl('h4', { text: title }); help.createEl('p', { text }); help.createEl('a', { text: label, href: url, attr: { target: '_blank', rel: 'noopener noreferrer' } }); };
  step('1. Install Python', 'Visit Python’s download page and choose the current stable version for your computer (not a preview). On Mac, open the downloaded installer and follow its steps. On Windows, use the official installer/Install Manager and follow its setup prompts. On Linux, install Python 3 from your software manager. Restart Obsidian afterward. This plugin needs Python 3.10 or newer.', 'https://www.python.org/downloads/', 'Download Python');
  step('2. Install ExifTool', 'Mac: download the macOS package and run its installer. Windows: download and extract the Windows executable package, rename exiftool(-k).exe to exiftool.exe, and keep the exiftool_files folder beside it. Choose that executable below if it is not detected. Linux: install ExifTool from your software manager (often called libimage-exiftool-perl or perl-Image-ExifTool).', 'https://exiftool.org/install.html', 'ExifTool downloads and installation guide');
  help.createEl('h4', { text: '3. Choose your photo folder' });
  help.createEl('p', { text: 'Select “Use this vault” or paste a folder path, then click Scan photos. Your existing files and folders stay where they are; no separate photo application or database is needed.' });
  help.createEl('p', { text: '4. Click Check helpers below. If both are found, connect or scan your photos. Enable Metadata writing when you are ready to assign tags and ratings. Embedded writing supports JPEG, PNG, TIFF, and WebP; other formats report an error and never silently create sidecars. Image editing exports a separate PNG copy.' });
  const status = help.createEl('p', { cls: 'pw-hint' });
  new Setting(help).setName('Check installed helpers').addButton(b => b.setButtonText('Check helpers').onClick(async () => { b.setDisabled(true); status.setText('Checking…'); try { const result = await plugin.bridge.run<Record<string, string>>('diagnostics'); status.setText(`Python ${result.python} found. ${result.exiftoolVersion ? 'ExifTool ' + result.exiftoolVersion + ' found.' : result.exiftoolError + ' Complete step 2, then try again.'}`); } catch (error) { status.setText(String(error) + ' Complete step 1, restart Obsidian, then try again.'); } finally { b.setDisabled(false); } }));
}
