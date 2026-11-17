import { ItemView, WorkspaceLeaf, Notice, Setting, normalizePath, FileSystemAdapter, Menu, TFolder, TFile, setIcon } from 'obsidian';
import { extname, join, dirname, relative, basename } from 'node:path';
import PhotoWorkspace, { TextPrompt } from './main';
import { Photo, Filters, Recipe, COLORS, PICKS, freshRecipe, rotateRecipe, toggleSelection, MetadataPatch, parsePhotoTags } from './types';
import { moveCrop, resizeCrop, drawCrop, fitCropRatio, type Handle } from './crop';
import { revealPhoto, openPhotoDefault, openPhotoWith } from './system';
import { ThumbnailCache, decodePhoto, renderPhoto, histogram, constrainCrop } from './image-engine';

export const VIEW_TYPES = { tags: 'photo-workspace-tags', filters: 'photo-workspace-filters', browser: 'photo-workspace-browser', inspector: 'photo-workspace-inspector' };
const colorHex = ['transparent', '#d86262', '#df994d', '#dec957', '#74b37a', '#6a9dd6', '#c580b5', '#9a9a9a', '#404040', '#f1f1f1'];

function button(parent: HTMLElement, text: string, action: () => void, title?: string): HTMLButtonElement {
  const b = parent.createEl('button', { text, attr: title ? { title, 'aria-label': title } : undefined }); b.addEventListener('click', action); return b;
}
function empty(parent: HTMLElement, title: string, text: string): void {
  const block = parent.createDiv('pw-empty'); block.createEl('strong', { text: title }); block.createEl('p', { text });
}

abstract class PhotoView extends ItemView {
  constructor(leaf: WorkspaceLeaf, readonly plugin: PhotoWorkspace) { super(leaf); }
  listen(type: string, callback: () => void): void { this.register(this.plugin.subscribe(type, callback)); }
  base(): void { this.contentEl.addClass('pw-view'); }
}

export class TagsView extends PhotoView {
  private search = '';
  private selectedTags = new Set<string>();
  private tagAnchor: string | null = null;
  private tagCatalog = '';
  private collapsed = new Set<string>();
  private foldersClosed = new Set<string>();
  private tagsAllClosed = false;
  private foldersAllClosed = true;
  getViewType(): string { return VIEW_TYPES.tags; }
  getDisplayText(): string { return 'Photo tags'; }
  getIcon(): string { return 'tags'; }
  async onOpen(): Promise<void> {
    this.base(); for (const entry of this.app.vault.getAllLoadedFiles()) if (entry instanceof TFolder) this.foldersClosed.add(entry.path); this.contentEl.addClass('pw-navigation'); this.listen('catalog', () => this.render()); this.listen('tags', () => this.render());
    this.registerEvent(this.app.vault.on('create', () => this.render()));
    this.registerEvent(this.app.vault.on('delete', () => this.render()));
    this.registerEvent(this.app.vault.on('rename', () => this.render()));
    this.render();
  }
  render(): void {
    const previousUpper = this.contentEl.querySelector<HTMLElement>('.pw-tags-section'), previousLower = this.contentEl.querySelector<HTMLElement>('.pw-folders-section');
    const upperScroll = previousUpper?.scrollTop ?? 0, lowerScroll = previousLower?.scrollTop ?? 0, upperHeight = previousUpper?.style.height;
    this.contentEl.empty();
    const upper = this.contentEl.createDiv('pw-tags-section');
    const head = upper.createDiv('pw-panel-head'); head.createEl('strong', { text: 'Photo tags' });
    const collapseTags = button(head, '', () => { this.tagsAllClosed = !this.tagsAllClosed; this.collapsed.clear(); if (this.tagsAllClosed) for (const tag of this.plugin.availableTags()) for (let i = 1; i <= tag.split('/').length; i++) this.collapsed.add(tag.split('/').slice(0, i).join('/')); this.render(); }, this.tagsAllClosed ? 'Expand all tags' : 'Collapse all tags');
    setIcon(collapseTags, this.tagsAllClosed ? 'unfold-vertical' : 'fold-vertical');
    button(head, '+', () => new TextPrompt(this.plugin, 'Create photo tags', 'Separate tags with commas, for example Art, Adventure, Places/Oregon/Coast. Tags are saved to photo metadata when assigned.', '', value => {
      let tags: string[]; try { tags = parsePhotoTags(value); } catch (error) { this.plugin.fail(error); return; }
      if (!tags.length || !this.plugin.catalog) return;
      const key = this.plugin.catalog.key;
      this.plugin.settings.customTags[key] = [...new Set([...(this.plugin.settings.customTags[key] ?? []), ...tags])];
      void this.plugin.save(); this.render();
    }).open(), 'Create tag');
    upper.createEl('p', { cls: 'pw-hint', text: 'Cmd/Ctrl-click selects multiple tags; Shift-click selects a range.' });
    const search = upper.createEl('input', { type: 'search', placeholder: 'Find a tag…', cls: 'pw-search' }); search.value = this.search;
    const tree = upper.createDiv('pw-tag-tree');
    const renderTree = () => {
      tree.empty(); const catalog = this.plugin.catalog;
      if (!catalog) { empty(tree, 'Connect a collection', 'Choose a photo folder to see its tags.'); button(tree, 'Connect', () => this.plugin.openSettings()); return; }
      if (this.tagCatalog !== catalog.key) { this.selectedTags.clear(); this.tagAnchor = null; this.tagCatalog = catalog.key; }
      const all = button(tree, 'All photos', () => { if (this.plugin.activeBrowser) { this.selectedTags.clear(); this.plugin.activeBrowser.filters = { sort: this.plugin.activeBrowser.filters.sort, ascending: this.plugin.activeBrowser.filters.ascending }; renderTree(); void this.plugin.activeBrowser.reload(); } }); all.addClass('pw-tree-all');
      const paths = [...new Set([...catalog.tags, ...(this.plugin.settings.customTags[catalog.key] ?? [])])];
      const nodes = new Set<string>(); for (const tag of paths) { const parts = tag.split('/'); for (let i = 1; i <= parts.length; i++) nodes.add(parts.slice(0, i).join('/')); }
      const sorted = [...nodes].sort((a, b) => a.localeCompare(b));
      const parents = new Set(sorted.filter(tag => tag.includes('/')).map(tag => tag.slice(0, tag.lastIndexOf('/'))));
      const visible = sorted.filter(path => (!this.search || path.toLocaleLowerCase().includes(this.search.toLocaleLowerCase())) && (this.search || !path.split('/').slice(0, -1).some((_, i) => this.collapsed.has(path.split('/').slice(0, i + 1).join('/')))));
      for (const path of visible) {
        const parts = path.split('/'), depth = parts.length - 1;
        const hasChildren = parents.has(path);
        const row = tree.createDiv('pw-tag-row'); row.style.setProperty('--pw-depth', String(depth)); row.dataset.photoTag = path; row.dataset.catalog = catalog.key;
        if (hasChildren) button(row, this.collapsed.has(path) ? '›' : '⌄', () => { if (this.collapsed.has(path)) this.collapsed.delete(path); else this.collapsed.add(path); renderTree(); }, 'Expand or collapse tag').addClass('pw-tree-toggle');
        else row.createSpan({ cls: 'pw-tree-spacer' });
        const label = row.createEl('button', { text: parts.at(-1)!, cls: 'pw-tag-label', attr: { title: path, 'aria-pressed': String(this.selectedTags.has(path)) } });
        row.toggleClass('is-selected', this.selectedTags.has(path));
        label.addEventListener('click', event => {
          this.selectedTags = toggleSelection(this.selectedTags, visible, path, this.tagAnchor, event.shiftKey, event.metaKey || event.ctrlKey);
          if (!event.shiftKey) this.tagAnchor = path;
          if (!(event.shiftKey || event.metaKey || event.ctrlKey) && this.plugin.activeBrowser) {
            this.plugin.activeBrowser.filters = { sort: this.plugin.activeBrowser.filters.sort, ascending: this.plugin.activeBrowser.filters.ascending, tag: path };
            void this.plugin.activeBrowser.reload(); this.plugin.emit('filters');
          }
          renderTree();
        });
        row.createSpan({ cls: 'pw-tree-count', text: (catalog.tagCounts?.[path] ?? 0).toLocaleString(), attr: { title: 'Photos with this tag or its subtags' } });
        row.addEventListener('contextmenu', event => {
          event.preventDefault();
          if (!this.selectedTags.has(path)) { this.selectedTags = new Set([path]); this.tagAnchor = path; renderTree(); }
          const tags = [...this.selectedTags], menu = new Menu();
          if (tags.length === 1) menu.addItem(item => item.setTitle('Rename tag…').setIcon('pencil').onClick(() => this.plugin.manageTag(path, false)));
          menu.addItem(item => item.setTitle(tags.length > 1 ? `Delete ${tags.length} selected tags from photos…` : 'Delete tag from photos…').setIcon('trash-2').onClick(() => this.plugin.deleteTags(tags))).showAtMouseEvent(event);
        });
        row.addEventListener('dragover', event => {
          if (!event.dataTransfer?.types.includes('application/x-photo-workspace')) return;
          event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; row.addClass('pw-drop-target');
        });
        row.addEventListener('dragleave', () => row.removeClass('pw-drop-target'));
        row.addEventListener('drop', event => {
          event.preventDefault(); row.removeClass('pw-drop-target');
          try {
            const payload = JSON.parse(event.dataTransfer?.getData('application/x-photo-workspace') || '{}');
            if (payload.catalog !== catalog.key || !Array.isArray(payload.ids)) return;
            void this.plugin.apply({ addTags: [path] }, payload.ids.filter((id: unknown) => Number.isSafeInteger(id)));
          } catch { new Notice('The dragged selection could not be read.'); }
        });
      }
      if (!paths.length) tree.createEl('p', { cls: 'pw-hint', text: 'No photo tags yet. Use + to create a hierarchy.' });
    };
    search.addEventListener('input', () => { this.search = search.value; renderTree(); }); renderTree();
    const notes = upper.createEl('details', { cls: 'pw-note-tags' }); notes.createEl('summary', { text: 'Vault note tags' });
    notes.createEl('p', { cls: 'pw-hint', text: 'Note tags are separate from image metadata. Use “Create photo note” in the inspector to connect notes and photos.' });
    const noteTags = new Set<string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      for (const tag of cache?.tags ?? []) noteTags.add(tag.tag);
      const frontmatter = cache?.frontmatter?.tags;
      if (Array.isArray(frontmatter)) {
        for (const tag of frontmatter) if (typeof tag === 'string') noteTags.add('#' + tag.replace(/^#/, ''));
      } else if (typeof frontmatter === 'string') noteTags.add('#' + frontmatter.replace(/^#/, ''));
    }
    notes.createEl('p', { cls: 'pw-hint', text: [...noteTags].sort().join(' · ') || 'No vault note tags.' });
    const lower = this.contentEl.createDiv('pw-folders-section');
    const folderHead = lower.createDiv('pw-panel-head'); folderHead.createEl('strong', { text: 'Vault folders' });
    const toggle = button(folderHead, '', () => { this.foldersAllClosed = !this.foldersAllClosed; this.foldersClosed.clear(); if (this.foldersAllClosed) for (const entry of this.app.vault.getAllLoadedFiles()) if (entry instanceof TFolder) this.foldersClosed.add(entry.path); this.render(); }, this.foldersAllClosed ? 'Expand all folders' : 'Collapse all folders');
    setIcon(toggle, this.foldersAllClosed ? 'unfold-vertical' : 'fold-vertical');
    const folderTree = lower.createDiv('pw-folder-tree');
    const adapter = this.app.vault.adapter;
    const openFolder = async (path: string) => {
      if (!(adapter instanceof FileSystemAdapter)) return;
      if (!this.plugin.activeBrowser) await this.plugin.openWorkspace();
      const browser = this.plugin.activeBrowser;
      if (browser) { browser.filters = { sort: browser.filters.sort, ascending: browser.filters.ascending, folderAbsolute: join(adapter.getBasePath(), path), folderRecursive: this.plugin.settings.includeSubfolders, groupFolders: this.plugin.settings.includeSubfolders }; await browser.reload(); await this.app.workspace.revealLeaf(browser.leaf); this.plugin.emit('filters'); }
    };
    const count = (row: HTMLElement, path: string) => {
      const absolute = adapter instanceof FileSystemAdapter ? join(adapter.getBasePath(), path) : '';
      const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
      row.createSpan({ cls: 'pw-tree-count', text: (this.plugin.catalog?.folderCounts?.[key] ?? 0).toLocaleString(), attr: { title: 'Indexed photos in this folder and its subfolders' } });
    };
    const rootRow = folderTree.createDiv('pw-folder-row');
    button(rootRow, 'All vault photos', () => { void openFolder(''); }).addClass('pw-folder-label'); count(rootRow, '');
    const walk = (folder: TFolder, parent: HTMLElement, depth: number) => {
      for (const child of folder.children.filter((entry): entry is TFolder => entry instanceof TFolder).sort((a, b) => a.name.localeCompare(b.name))) {
        const row = parent.createDiv('pw-folder-row'); row.style.setProperty('--pw-depth', String(depth));
        const closed = this.foldersClosed.has(child.path);
        if (child.children.some(entry => entry instanceof TFolder)) {
          const toggle = button(row, '', () => { if (closed) this.foldersClosed.delete(child.path); else this.foldersClosed.add(child.path); this.render(); }, closed ? 'Expand folder' : 'Collapse folder');
          toggle.addClass('pw-tree-toggle'); setIcon(toggle, closed ? 'chevron-right' : 'chevron-down');
        } else row.createSpan({ cls: 'pw-tree-spacer' });
        const entry = button(row, '', () => { void openFolder(child.path); }, child.path); entry.addClass('pw-folder-label');
        setIcon(entry.createSpan(), 'folder'); entry.createSpan({ text: child.name }); count(row, child.path);
        row.addEventListener('contextmenu', event => { event.preventDefault(); if (adapter instanceof FileSystemAdapter) new Menu().addItem(i => i.setTitle('Paste').setIcon('clipboard-paste').setDisabled(!this.plugin.clipboard).onClick(() => this.plugin.pastePhotos(join(adapter.getBasePath(), child.path)))).showAtMouseEvent(event); });
        if (!closed) walk(child, parent, depth + 1);
      }
    };
    walk(this.app.vault.getRoot(), folderTree, 0);
    if (upperHeight) upper.style.height = upperHeight;
    upper.scrollTop = upperScroll; lower.scrollTop = lowerScroll;
  }
}

export class FiltersView extends PhotoView {
  getViewType(): string { return VIEW_TYPES.filters; }
  getDisplayText(): string { return 'Photo filters'; }
  getIcon(): string { return 'list-filter'; }
  async onOpen(): Promise<void> { this.base(); this.listen('catalog', () => this.render()); this.listen('filters', () => this.render()); this.render(); }
  render(): void {
    this.contentEl.empty(); this.contentEl.createDiv('pw-panel-head').createEl('strong', { text: 'Photo filters' });
    const browser = this.plugin.activeBrowser;
    if (!browser) { empty(this.contentEl, 'Open a photo workspace', 'Filters apply to the active photo tab.'); return; }
    const filters = { ...browser.filters };
    const dropdown = (name: string, key: keyof Filters, options: [string, string][]) => new Setting(this.contentEl).setName(name).addDropdown(d => {
      for (const [value, label] of options) d.addOption(value, label);
      d.setValue(String(filters[key] ?? '')).onChange(value => { (filters as Record<string, unknown>)[key] = value; });
    });
    const text = (name: string, key: keyof Filters, type = 'text') => new Setting(this.contentEl).setName(name).addText(t => { t.inputEl.type = type; t.setValue(String(filters[key] ?? '')).onChange(v => { (filters as Record<string, unknown>)[key] = v; }); });
    dropdown('Collection', 'rootId', [['', 'All collections'], ...(this.plugin.catalog?.roots.map(r => [String(r.id), r.label] as [string, string]) ?? [])]);
    const albums = this.plugin.catalog?.albums ?? [];
    dropdown('Album / folder', 'albumId', [['', 'All albums'], ...albums.map(a => [String(a.id), a.path || '/'] as [string, string])]);
    text('Filename, title, caption', 'search');
    text('Photo tag', 'tag');
    new Setting(this.contentEl).setName('Include subtags').addToggle(t => t.setValue(filters.descendants !== false).onChange(v => { filters.descendants = v; }));
    dropdown('Minimum stars', 'rating', [['', 'Any rating'], ['0', '0+'], ['1', '1+'], ['2', '2+'], ['3', '3+'], ['4', '4+'], ['5', '5']]);
    new Setting(this.contentEl).setName('Exact rating').addToggle(t => t.setValue(filters.ratingAtLeast === false).onChange(v => { filters.ratingAtLeast = !v; }));
    dropdown('Color label', 'color', [['', 'Any color'], ...COLORS.map((v, i) => [String(i), v] as [string, string])]);
    dropdown('Pick label', 'pick', [['', 'Any pick'], ...PICKS.map((v, i) => [String(i), v] as [string, string])]);
    text('From date', 'dateFrom', 'date'); text('Through date', 'dateTo', 'date');
    text('Camera', 'camera'); text('Lens', 'lens'); text('Format', 'format');
    dropdown('Orientation', 'orientation', [['', 'Any orientation'], ['landscape', 'Landscape'], ['portrait', 'Portrait'], ['square', 'Square']]);
    dropdown('GPS', 'hasGps', [['', 'Any location'], ['yes', 'Has coordinates'], ['no', 'No coordinates']]);
    new Setting(this.contentEl).setName('Untagged only').addToggle(t => t.setValue(!!filters.untagged).onChange(v => { filters.untagged = v; }));
    const actions = this.contentEl.createDiv('pw-actions');
    button(actions, 'Apply filters', () => { browser.filters = filters; void browser.reload(); }).addClass('mod-cta');
    button(actions, 'Clear', () => { browser.filters = { sort: 'date' }; void browser.reload(); this.render(); });
    button(actions, 'Save filter', () => new TextPrompt(this.plugin, 'Save filter', 'Name this reusable filter.', '', name => {
      if (!name.trim()) return;
      this.plugin.settings.savedFilters.push({ name: name.trim(), filters: { ...filters, offset: 0 } }); void this.plugin.save(); this.render();
    }).open());
    if (this.plugin.settings.savedFilters.length) {
      this.contentEl.createEl('p', { cls: 'pw-eyebrow', text: 'Saved filters' });
      this.plugin.settings.savedFilters.forEach((saved, index) => {
        const row = this.contentEl.createDiv('pw-saved-filter');
        button(row, saved.name, () => { browser.filters = { ...saved.filters }; void browser.reload(); this.render(); });
        button(row, '×', () => { this.plugin.settings.savedFilters.splice(index, 1); void this.plugin.save(); this.render(); }, 'Remove saved filter');
      });
    }
  }
}

export class BrowserView extends PhotoView {
  filters: Filters = { sort: 'date', descendants: true };
  photos: Photo[] = [];
  selected = new Set<number>();
  current: Photo | null = null;
  recipe = freshRecipe();
  mode: 'grid' | 'preview' = 'grid';
  cropMode = false;
  cropDraft: Recipe['crop'] | null = null;
  embeddedPreview = false;
  private bitmap: ImageBitmap | null = null;
  private thumbnails!: ThumbnailCache;
  private observer: IntersectionObserver | null = null;
  private grid!: HTMLElement;
  private preview!: HTMLElement;
  private footer!: HTMLElement;
  private toolbar!: HTMLElement;
  private hasMore = false;
  private loading = false;
  private pageObserver: IntersectionObserver | null = null;
  private navigating = false;
  private requestId = 0;
  private previewId = 0;
  private anchor: number | null = null;
  private scrollTop = 0;
  private history: Recipe[] = [];
  private future: Recipe[] = [];
  private zoom: number | 'fit' = 'fit';
  private recipeTimer: ReturnType<typeof setTimeout> | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private recipeCatalog = '';
  private cancelDrag: (() => void) | null = null;

  getViewType(): string { return VIEW_TYPES.browser; }
  getDisplayText(): string { return this.current && this.mode === 'preview' ? this.current.name : 'Photos'; }
  getIcon(): string { return 'images'; }
  getState(): Record<string, unknown> { return { filters: this.filters }; }
  async setState(state: { filters?: Filters }, result: { history: boolean }): Promise<void> { if (state.filters) this.filters = state.filters; await super.setState(state, result); if (this.grid) await this.reload(); }
  async onOpen(): Promise<void> {
    this.base(); this.contentEl.addClass('pw-browser'); this.contentEl.tabIndex = 0;
    this.thumbnails = new ThumbnailCache(this.plugin.bridge, photo => this.plugin.settings.recipes[this.plugin.recipeKey(photo.id)]);
    this.plugin.activeBrowser = this; this.plugin.emit('filters');
    this.toolbar = this.contentEl.createDiv('pw-toolbar');
    this.grid = this.contentEl.createDiv('pw-grid'); this.grid.setAttribute('role', 'listbox'); this.grid.setAttribute('aria-multiselectable', 'true'); this.grid.setAttribute('aria-label', 'Photo thumbnails');
    this.preview = this.contentEl.createDiv('pw-preview'); this.preview.hidden = true;
    this.footer = this.contentEl.createDiv('pw-footer');
    this.listen('catalog', () => { void this.reload(); }); this.listen('status', () => this.renderFooter());
    this.registerDomEvent(this.contentEl, 'keydown', event => {
      if (event.defaultPrevented || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]') || event.altKey) return;
      if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.repeat && /^[1-5]$/.test(event.key)) { event.preventDefault(); void this.plugin.apply({ rating: Number(event.key) }); return; }
      if (!event.metaKey && !event.ctrlKey && this.mode === 'preview' && event.key.toLowerCase() === 't') { event.preventDefault(); this.plugin.tagPrompt(); return; }
      if (this.cropMode && (event.key === 'Escape' || event.key === 'Enter')) { event.preventDefault(); this.finishCrop(event.key === 'Enter'); return; }
      if (event.key === 'Escape' && this.mode === 'preview') { event.preventDefault(); this.showGrid(); }
      if (event.key === 'Enter' && this.mode === 'grid') { const photo = this.photos.find(p => p.id === [...this.selected][0]); if (photo) void this.openPhoto(photo); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && this.mode === 'grid') { event.preventDefault(); this.selected = new Set(this.photos.map(p => p.id)); this.selectionChanged(); }
      if (!event.metaKey && !event.ctrlKey && this.mode === 'preview' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); void this.navigate(event.key === 'ArrowLeft' ? -1 : 1); }
    });
    this.renderToolbar(); this.renderFooter(); if (this.plugin.catalog) await this.reload(); else empty(this.grid, 'Your photos, connected', 'Open connection settings to choose a photo folder.');
  }
  async onClose(): Promise<void> {
    this.pageObserver?.disconnect(); this.requestId++; this.previewId++; this.cancelDrag?.(); this.observer?.disconnect(); this.thumbnails.dispose(); this.bitmap?.close();
    if (this.recipeTimer) clearTimeout(this.recipeTimer); if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.current && this.mode === 'preview') await this.plugin.saveRecipe(this.current.id, this.recipe, this.recipeCatalog);
    if (this.plugin.activeBrowser === this) this.plugin.activeBrowser = null;
  }
  renderToolbar(): void {
    this.toolbar.empty();
    if (this.mode === 'preview') {
      button(this.toolbar, '← Grid', () => this.showGrid());
      button(this.toolbar, '‹', () => this.navigate(-1), 'Previous photo'); button(this.toolbar, '›', () => this.navigate(1), 'Next photo');
      this.toolbar.createSpan({ cls: 'pw-photo-name', text: this.current?.name ?? '' });
      const zoom = this.toolbar.createEl('input', { type: 'range', cls: 'pw-zoom-slider', attr: { min: '10', max: '400', step: '5', 'aria-label': 'Preview zoom' } });
      const zoomLabel = this.toolbar.createSpan({ cls: 'pw-zoom-label' });
      const syncZoom = () => { zoom.value = String(this.zoom === 'fit' ? 100 : this.zoom * 100); zoomLabel.setText(this.zoom === 'fit' ? 'Fit' : Math.round(this.zoom * 100) + '%'); };
      zoom.addEventListener('input', () => { this.setZoom(Number(zoom.value) / 100); syncZoom(); });
      button(this.toolbar, 'Fit', () => { this.setZoom('fit'); syncZoom(); });
      button(this.toolbar, '100%', () => { this.setZoom(1); syncZoom(); }); syncZoom();
      button(this.toolbar, 'Rotate', () => { void this.rotateSelected(); });
      const compare = button(this.toolbar, 'Before', () => {}, 'Hold to view the original');
      compare.addEventListener('pointerdown', () => this.renderPreview(true)); compare.addEventListener('pointerup', () => this.renderPreview()); compare.addEventListener('pointerleave', () => this.renderPreview());
      button(this.toolbar, 'Undo', () => this.undoRecipe()); button(this.toolbar, 'Redo', () => this.redoRecipe());
      button(this.toolbar, 'Export copy', () => { void this.exportCopy(); }).addClass('mod-cta');
    } else {
      button(this.toolbar, 'Connect', () => this.plugin.openSettings());
      button(this.toolbar, 'Refresh', () => { void this.plugin.refresh(); });
      const search = this.toolbar.createEl('input', { type: 'search', placeholder: 'Search photos…', cls: 'pw-toolbar-search' }); search.value = this.filters.search ?? '';
      let searchTimer: ReturnType<typeof setTimeout>; search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { this.filters.search = search.value; void this.reload(); }, 350); });
      const sort = this.toolbar.createEl('select', { attr: { 'aria-label': 'Sort photos' } });
      for (const [value, text] of [['date', 'Capture date'], ['name', 'Filename'], ['rating', 'Rating'], ['color', 'Color label'], ['pick', 'Pick label'], ['size', 'File size']]) sort.createEl('option', { value, text });
      sort.value = this.filters.sort ?? 'date'; sort.addEventListener('change', () => { this.filters.sort = sort.value; void this.reload(); });
      button(this.toolbar, this.filters.ascending ? '↑' : '↓', () => { this.filters.ascending = !this.filters.ascending; void this.reload(); this.renderToolbar(); }, 'Reverse sort order');
      const size = this.toolbar.createEl('input', { type: 'range', attr: { min: '100', max: '360', step: '10', 'aria-label': 'Thumbnail size', title: 'Thumbnail size' } });
      size.value = String(this.plugin.settings.thumbnailSize); size.addEventListener('input', () => { this.plugin.settings.thumbnailSize = Number(size.value); this.grid.style.setProperty('--pw-thumbnail-size', size.value + 'px'); }); size.addEventListener('change', () => { void this.plugin.save(); });
      button(this.toolbar, 'Export photos…', () => this.plugin.exportPhotos());
      button(this.toolbar, 'I’m Feeling Lucky', () => { void this.plugin.luckyBatch().then(() => this.renderToolbar()); });
      if (this.plugin.settings.luckyUndo) button(this.toolbar, 'Undo batch adjustment', () => { void this.plugin.undoLuckyBatch(); this.renderToolbar(); });
      button(this.toolbar, 'Tag selection', () => this.plugin.tagPrompt()); button(this.toolbar, 'Undo metadata', () => { void this.plugin.undo(); });
    }
  }
  renderFooter(): void {
    this.footer.empty(); this.footer.createSpan({ text: this.mode === 'grid' ? `${this.photos.length.toLocaleString()} loaded · ${this.selected.size} selected${this.filters.tag ? ' · ' + this.filters.tag : ''}${this.filters.folderAbsolute ? ' · ' + this.filters.folderAbsolute : ''}` : this.embeddedPreview ? 'Embedded preview · export disabled for RAW preview' : 'Edits preserve the original' });
    this.footer.createSpan({ cls: 'pw-status', text: this.plugin.status });
    if (this.plugin.busy) button(this.footer, 'Cancel batch', () => { this.plugin.cancelled = true; });
  }
  async reload(preserveSelection = false): Promise<void> {
    this.pageObserver?.disconnect();
    this.cancelDrag?.();
    const restoreFocus = this.contentEl.contains(this.contentEl.ownerDocument.activeElement);
    const previousSelection = preserveSelection ? new Set(this.selected) : new Set<number>();
    const previousScroll = preserveSelection ? this.grid.scrollTop : 0;
    if (this.current && this.mode === 'preview') await this.plugin.saveRecipe(this.current.id, this.recipe, this.recipeCatalog);
    const token = ++this.requestId;
    this.observer?.disconnect(); this.photos = []; this.selected.clear(); this.current = null; this.mode = 'grid';
    this.previewId++; this.bitmap?.close(); this.bitmap = null; this.preview.hidden = true; this.grid.hidden = false; this.grid.empty();
    this.renderToolbar(); this.loading = false; this.hasMore = false; this.plugin.emit('selection');
    if (!this.plugin.catalog) { empty(this.grid, 'Connect a collection', 'Choose a photo folder in settings.'); this.renderFooter(); return; }
    this.grid.createDiv({ cls: 'pw-loading', text: 'Loading photos…' });
    await this.loadMore(token, true);
    if (preserveSelection && token === this.requestId) {
      this.selected = new Set(this.photos.filter(p => previousSelection.has(p.id)).map(p => p.id));
      this.current = this.photos.find(p => this.selected.has(p.id)) ?? null;
      this.grid.scrollTop = previousScroll; this.selectionChanged();
      if (restoreFocus) this.contentEl.focus({ preventScroll: true });
    }
  }
  private async loadMore(token = this.requestId, first = false): Promise<void> {
    if (this.loading) return; this.loading = true;
    try {
      const page = await this.plugin.bridge.run<{ photos: Photo[]; hasMore: boolean }>('query', { filters: { ...this.filters, offset: this.photos.length, limit: 120 } });
      if (token !== this.requestId) return;
      if (first) this.grid.empty();
      this.photos.push(...page.photos); this.hasMore = page.hasMore;
      this.renderGrid(first);
      if (!this.photos.length) empty(this.grid, 'No matching photos', 'Adjust the filters or choose another collection.');
      this.renderFooter();
    } catch (error) { if (token === this.requestId) { this.grid.empty(); empty(this.grid, 'Could not load photos', String(error)); this.plugin.fail(error); } }
    finally { if (token === this.requestId) { this.loading = false; this.observeNextPage(); } }
  }
  private observeNextPage(): void {
    this.pageObserver?.disconnect();
    const next = this.grid.querySelector('.pw-load-more');
    if (!next || this.mode !== 'grid') return;
    this.pageObserver = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting) && !this.loading && this.mode === 'grid') void this.loadMore(); }, { root: this.grid, rootMargin: '300px' });
    this.pageObserver.observe(next);
  }
  private renderGrid(reset = false): void {
    this.grid.style.setProperty('--pw-thumbnail-size', this.plugin.settings.thumbnailSize + 'px');
    if (reset) { this.observer?.disconnect(); this.grid.empty(); }
    this.grid.querySelector('.pw-load-more')?.remove();
    if (!this.observer) this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        this.observer?.unobserve(entry.target);
        const id = Number((entry.target as HTMLElement).dataset.id), photo = this.photos.find(p => p.id === id);
        if (!photo) continue;
        void this.thumbnails.get(photo).then(url => {
          if (!entry.target.isConnected) return;
          const img = entry.target.querySelector('img'); if (img) { img.src = url; img.alt = photo.name; }
          entry.target.querySelector('.pw-thumb-placeholder')?.remove();
        }).catch(error => { if (entry.target.isConnected) { const hint = entry.target.querySelector('.pw-thumb-placeholder'); if (hint) { hint.textContent = photo.path ? 'Preview unavailable' : 'Map collection'; (hint as HTMLElement).title = String(error); } } });
      }
    }, { root: this.grid, rootMargin: '250px' });
    const existing = new Set([...this.grid.querySelectorAll<HTMLElement>('.pw-tile')].map(el => Number(el.dataset.id)));
    let previousFolder: string | undefined;
    for (const photo of this.photos) {
      const folder = photo.path ? dirname(photo.path) : photo.relativePath;
      const beginsFolder = folder !== previousFolder; previousFolder = folder;
      if (existing.has(photo.id)) continue;
      if (this.filters.folderAbsolute && this.filters.groupFolders && beginsFolder) {
        const rel = relative(this.filters.folderAbsolute, folder);
        this.grid.createEl('h3', { cls: 'pw-folder-divider', text: rel || basename(this.filters.folderAbsolute), attr: { title: folder } });
      }
      const tile = this.grid.createDiv('pw-tile'); tile.dataset.id = String(photo.id); tile.tabIndex = 0; tile.draggable = false;
      tile.setAttribute('role', 'option'); tile.setAttribute('aria-selected', String(this.selected.has(photo.id))); tile.setAttribute('aria-label', photo.name);
      const image = tile.createDiv('pw-thumb'); image.createEl('img', { attr: { alt: '', draggable: 'false' } }); image.createSpan({ cls: 'pw-thumb-placeholder', text: 'Loading…' });
      tile.createDiv({ cls: 'pw-tile-name', text: photo.name });
      const badges = tile.createDiv('pw-badges'); badges.createSpan({ cls: 'pw-stars', text: photo.rating > 0 ? '★'.repeat(Math.min(5, photo.rating)) : 'Unrated' });
      if (photo.color) { const dot = badges.createSpan({ cls: 'pw-color-dot', attr: { title: COLORS[photo.color] } }); dot.style.setProperty('--pw-label-color', colorHex[photo.color]); }
      if (photo.pick) badges.createSpan({ text: PICKS[photo.pick] });
      if (photo.pending) badges.createSpan({ text: '↻', attr: { title: 'Metadata saved to file' } });
      let suppressClick = false;
      tile.addEventListener('click', event => { if (suppressClick) { suppressClick = false; return; } this.selected = toggleSelection(this.selected, this.photos.map(p => p.id), photo.id, this.anchor, event.shiftKey, event.metaKey || event.ctrlKey); if (!event.shiftKey) this.anchor = photo.id; this.current = this.selected.has(photo.id) ? photo : this.photos.find(p => this.selected.has(p.id)) ?? null; this.selectionChanged(); });
      tile.addEventListener('contextmenu', event => { if (!this.selected.has(photo.id)) { this.selected = new Set([photo.id]); this.current = photo; this.selectionChanged(); } this.photoMenu(event, photo); });
      tile.addEventListener('dblclick', () => { void this.openPhoto(photo); });
      // Pointer capture keeps a batch together across panes and supports precise pen/trackpad drags.
      let origin: { x: number; y: number; pointer: number } | null = null;
      let ghost: HTMLElement | null = null;
      let target: HTMLElement | null = null;
      const cleanup = () => {
        ghost?.remove(); ghost = null; target?.removeClass('pw-drop-target'); target = null;
        if (origin && tile.hasPointerCapture(origin.pointer)) tile.releasePointerCapture(origin.pointer);
        tile.ownerDocument.removeEventListener('pointermove', move, true);
        tile.ownerDocument.removeEventListener('pointerup', finish, true);
        tile.ownerDocument.removeEventListener('mouseup', finish, true);
        tile.ownerDocument.removeEventListener('pointercancel', cleanup, true);
        origin = null; this.cancelDrag = null;
      };
      tile.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        this.cancelDrag?.(); origin = { x: event.clientX, y: event.clientY, pointer: event.pointerId }; this.cancelDrag = cleanup;
        tile.setPointerCapture(event.pointerId);
        tile.ownerDocument.addEventListener('pointermove', move, true);
        tile.ownerDocument.addEventListener('pointerup', finish, true);
        tile.ownerDocument.addEventListener('mouseup', finish, true);
        tile.ownerDocument.addEventListener('pointercancel', cleanup, true);
      });
      const move = (event: PointerEvent) => {
        if (!origin || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 6) return;
        if (!ghost) {
          if (!this.selected.has(photo.id)) { this.selected = new Set([photo.id]); this.current = photo; this.selectionChanged(); }
          ghost = tile.ownerDocument.body.createDiv({ cls: 'pw-drag-ghost', text: `${this.selected.size} photo${this.selected.size === 1 ? '' : 's'}` });
        }
        ghost.style.left = event.clientX + 14 + 'px'; ghost.style.top = event.clientY + 14 + 'px';
        target?.removeClass('pw-drop-target');
        target = tile.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.pw-tag-row') ?? null;
        if (target && target.dataset.catalog === this.plugin.catalog?.key) { target.addClass('pw-drop-target'); ghost.setText(`Add ${this.selected.size} photos to ${target.dataset.photoTag}`); }
      };
      const finish = (event: MouseEvent) => {
        const moved = origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >= 6;
        if (moved) {
          const destination = tile.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.pw-tag-row');
          if (!this.selected.has(photo.id)) { this.selected = new Set([photo.id]); this.current = photo; this.selectionChanged(); }
          if (destination && destination.dataset.catalog === this.plugin.catalog?.key && destination.dataset.photoTag) void this.plugin.apply({ addTags: [destination.dataset.photoTag] }, [...this.selected]);
          suppressClick = true;
        }
        cleanup();
      };
      tile.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void this.openPhoto(photo); }
        if (event.key === ' ') { event.preventDefault(); event.stopPropagation(); this.selected = toggleSelection(this.selected, this.photos.map(p => p.id), photo.id, this.anchor, event.shiftKey, event.metaKey || event.ctrlKey); this.current = photo; this.selectionChanged(); }
      });
      this.observer.observe(tile);
    }
    if (this.hasMore) button(this.grid, 'Load next 120 photos', () => { void this.loadMore(); }).addClass('pw-load-more');
    this.selectionChanged(false);
  }
  refreshEditedThumbnails(): void { if (this.mode !== 'grid') return; const scroll = this.grid.scrollTop; this.renderGrid(true); this.grid.scrollTop = scroll; }
  selectionChanged(emit = true): void {
    this.grid.querySelectorAll<HTMLElement>('.pw-tile').forEach(tile => { const selected = this.selected.has(Number(tile.dataset.id)); tile.toggleClass('is-selected', selected); tile.setAttribute('aria-selected', String(selected)); });
    this.renderFooter(); if (emit) this.plugin.emit('selection');
  }
  updatePhoto(id: number, patch: MetadataPatch & { tags: string[] }): void {
    const photo = this.photos.find(p => p.id === id); if (photo) Object.assign(photo, patch, { pending: true });
    if (this.current?.id === id) Object.assign(this.current, patch, { pending: true });
    const tile = this.grid.querySelector<HTMLElement>(`.pw-tile[data-id="${id}"]`);
    if (tile && photo) {
      const badges = tile.querySelector<HTMLElement>('.pw-badges');
      if (badges) { badges.empty(); badges.createSpan({ text: photo.rating > 0 ? '★'.repeat(Math.min(5, photo.rating)) : 'Unrated' }); if (photo.color) badges.createSpan({ text: COLORS[photo.color] }); if (photo.pick) badges.createSpan({ text: PICKS[photo.pick] }); badges.createSpan({ text: '↻', attr: { title: 'Metadata saved to file' } }); }
    }
  }
  async openPhoto(photo: Photo): Promise<void> {
    if (this.current && this.mode === 'preview') await this.plugin.saveRecipe(this.current.id, this.recipe, this.recipeCatalog);
    const token = ++this.previewId;
    if (this.mode === 'grid') this.scrollTop = this.grid.scrollTop;
    this.mode = 'preview'; this.pageObserver?.disconnect(); this.contentEl.focus({ preventScroll: true }); this.current = photo; this.selected = new Set([photo.id]); this.grid.hidden = true; this.preview.hidden = false;
    this.recipeCatalog = this.plugin.catalog?.key ?? '';
    this.cropMode = false; this.cropDraft = null; this.zoom = 'fit'; this.recipe = structuredClone(this.plugin.settings.recipes[this.plugin.recipeKey(photo.id)] ?? freshRecipe());
    this.history = []; this.future = []; this.bitmap?.close(); this.bitmap = null; this.preview.empty(); empty(this.preview, 'Opening photo…', photo.name);
    this.renderToolbar(); this.renderFooter(); this.plugin.emit('selection');
    try {
      const decoded = await decodePhoto(photo, this.plugin.bridge);
      if (token !== this.previewId) { decoded.bitmap.close(); return; }
      this.bitmap = decoded.bitmap; this.embeddedPreview = decoded.embeddedPreview; this.renderPreview(); this.renderFooter(); this.plugin.emit('selection');
    } catch (error) { if (token === this.previewId) { this.preview.empty(); empty(this.preview, 'Preview unavailable', String(error)); } }
  }
  showGrid(): void {
    if (this.current) void this.plugin.saveRecipe(this.current.id, this.recipe, this.recipeCatalog);
    this.previewId++; this.mode = 'grid'; this.bitmap?.close(); this.bitmap = null; this.preview.empty(); this.preview.hidden = true; this.grid.hidden = false;
    this.refreshEditedThumbnails(); this.grid.scrollTop = this.scrollTop; this.renderToolbar(); this.selectionChanged(); this.observeNextPage();
  }
  async navigate(delta: number): Promise<void> {
    if (this.navigating || this.mode !== 'preview' || !this.current) return;
    this.navigating = true;
    const currentId = this.current.id, token = this.requestId;
    try {
      const index = this.photos.findIndex(p => p.id === currentId);
      if (delta > 0 && index === this.photos.length - 1 && this.hasMore) await this.loadMore();
      if (token !== this.requestId || this.mode !== 'preview' || this.current?.id !== currentId) return;
      const next = this.photos[index + delta]; if (next) await this.openPhoto(next);
    } finally { this.navigating = false; }
  }
  commitRecipe(next: Recipe, saveHistory = true): void {
    if (saveHistory) { this.history.push(structuredClone(this.recipe)); if (this.history.length > 60) this.history.shift(); this.future = []; }
    this.recipe = structuredClone(next);
    if (this.renderTimer) clearTimeout(this.renderTimer); this.renderTimer = setTimeout(() => this.renderPreview(), 40);
    if (this.recipeTimer) clearTimeout(this.recipeTimer);
    const id = this.current?.id, recipe = structuredClone(this.recipe), catalog = this.recipeCatalog;
    if (id !== undefined) this.recipeTimer = setTimeout(() => { void this.plugin.saveRecipe(id, recipe, catalog); }, 250);
  }
  undoRecipe(): void { const previous = this.history.pop(); if (!previous) return; this.future.push(structuredClone(this.recipe)); this.commitRecipe(previous, false); this.plugin.emit('selection'); }
  redoRecipe(): void { const next = this.future.pop(); if (!next) return; this.history.push(structuredClone(this.recipe)); this.commitRecipe(next, false); this.plugin.emit('selection'); }
  async rotateSelected(): Promise<void> {
    if (this.mode === 'preview') {
      this.cropMode = false; this.cropDraft = null;
      this.commitRecipe(rotateRecipe(this.recipe)); this.plugin.emit('selection');
    } else {
      const catalog = this.plugin.catalog?.key;
      for (const id of this.selected) await this.plugin.saveRecipe(id, rotateRecipe(this.plugin.settings.recipes[this.plugin.recipeKey(id)] ?? freshRecipe()), catalog);
      await this.reload(true);
    }
  }
  private photoMenu(event: MouseEvent, photo: Photo): void {
    event.preventDefault();
    const invoke = (action: () => Promise<void>) => { void action().catch(error => this.plugin.fail(error)); };
    new Menu()
      .addItem(i => i.setTitle('Open With Explorer').setIcon('folder-open').setDisabled(!photo.path).onClick(() => invoke(() => revealPhoto(photo.path!))))
      .addItem(i => i.setTitle('Open with default application').setIcon('external-link').setDisabled(!photo.path).onClick(() => invoke(() => openPhotoDefault(photo.path!))))
      .addItem(i => i.setTitle('Open With App').setIcon('app-window').setDisabled(!photo.path).onClick(() => invoke(() => openPhotoWith(photo.path!, this.app))))
      .addSeparator()
      .addItem(i => i.setTitle('Cut').setIcon('scissors').onClick(() => this.plugin.copyPhotos([...this.selected], true)))
      .addItem(i => i.setTitle('Copy').setIcon('copy').onClick(() => this.plugin.copyPhotos([...this.selected])))
      .addItem(i => i.setTitle('Paste').setIcon('clipboard-paste').setDisabled(!this.plugin.clipboard || !photo.path).onClick(() => this.plugin.pastePhotos(dirname(photo.path!))))
      .addItem(i => i.setTitle('Rename').setIcon('pencil').onClick(() => this.plugin.renamePhoto(photo)))
      .addItem(i => i.setTitle('Delete').setIcon('trash-2').onClick(() => this.plugin.deletePhotos([...this.selected])))
      .addSeparator()
      .addItem(i => i.setTitle('I’m Feeling Lucky').setIcon('wand-sparkles').onClick(() => { if (this.mode === 'preview') { this.commitRecipe({ ...this.recipe, auto: 100 }); this.plugin.emit('selection'); } else void this.plugin.luckyBatch(); }))
      .addItem(i => i.setTitle('Export photos…').setIcon('download').onClick(() => this.plugin.exportPhotos()))
      .addItem(i => i.setTitle('Rotate').setIcon('rotate-cw').onClick(() => { void this.rotateSelected(); }))
      .addItem(i => i.setTitle('Add Tag').setIcon('tags').onClick(() => this.plugin.tagPrompt()))
      .addItem(i => i.setTitle('Create photo note').setIcon('file-plus').onClick(() => invoke(() => this.plugin.createPhotoNote(photo))))
      .addItem(i => i.setTitle(this.mode === 'preview' ? 'Return to thumbnails' : 'Open preview').setIcon('image').onClick(() => { if (this.mode === 'preview') this.showGrid(); else void this.openPhoto(photo); }))
      .showAtMouseEvent(event);
  }
  private setZoom(value: number | 'fit'): void {
    let canvas = this.preview.querySelector<HTMLCanvasElement>('canvas');
    const wasFit = this.zoom === 'fit';
    const oldWidth = canvas?.getBoundingClientRect().width || 1, oldHeight = canvas?.getBoundingClientRect().height || 1;
    const centerX = wasFit ? .5 : (this.preview.scrollLeft + this.preview.clientWidth / 2) / oldWidth;
    const centerY = wasFit ? .5 : (this.preview.scrollTop + this.preview.clientHeight / 2) / oldHeight;
    this.zoom = value;
    if (wasFit && value !== 'fit') { this.renderPreview(); canvas = this.preview.querySelector<HTMLCanvasElement>('canvas'); }
    this.preview.toggleClass('pw-preview-fit', value === 'fit');
    if (canvas) {
      canvas.style.width = value === 'fit' ? '' : Number(canvas.dataset.fullWidth) * value + 'px';
      canvas.style.height = value === 'fit' ? '' : Number(canvas.dataset.fullHeight) * value + 'px';
      this.preview.scrollLeft = centerX * canvas.getBoundingClientRect().width - this.preview.clientWidth / 2;
      this.preview.scrollTop = centerY * canvas.getBoundingClientRect().height - this.preview.clientHeight / 2;
    }
  }
  renderPreview(before = false): void {
    if (!this.bitmap || this.mode !== 'preview') return;
    const recipe = before ? freshRecipe() : structuredClone(this.recipe);
    if (this.cropMode) recipe.crop = { x: 0, y: 0, width: 1, height: 1 };
    const canvas = renderPhoto(this.bitmap, recipe, this.zoom === 'fit' ? 1800 : Math.min(6000, Math.max(this.bitmap.width, this.bitmap.height)));
    const scale = Math.max(this.bitmap.width, this.bitmap.height) / Math.max(1, Math.min(this.zoom === 'fit' ? 1800 : 6000, Math.max(this.bitmap.width, this.bitmap.height)));
    canvas.dataset.fullWidth = String(canvas.width * scale); canvas.dataset.fullHeight = String(canvas.height * scale);
    this.preview.empty(); this.preview.toggleClass('pw-preview-fit', this.zoom === 'fit');
    canvas.addEventListener('contextmenu', event => { if (this.current) this.photoMenu(event, this.current); });
    const frame = this.preview.createDiv('pw-image-frame'); frame.appendChild(canvas); canvas.addClass('pw-image-canvas');
    if (this.zoom !== 'fit') { canvas.style.width = Number(canvas.dataset.fullWidth) * this.zoom + 'px'; canvas.style.height = Number(canvas.dataset.fullHeight) * this.zoom + 'px'; }
    if (!this.cropMode) {
      let pan: { x: number; y: number; left: number; top: number } | null = null;
      canvas.addClass('pw-pannable');
      canvas.addEventListener('pointerdown', event => { if (this.zoom === 'fit') return; event.preventDefault(); pan = { x: event.clientX, y: event.clientY, left: this.preview.scrollLeft, top: this.preview.scrollTop }; canvas.setPointerCapture(event.pointerId); });
      canvas.addEventListener('pointermove', event => { if (pan) { this.preview.scrollLeft = pan.left - event.clientX + pan.x; this.preview.scrollTop = pan.top - event.clientY + pan.y; } });
      canvas.addEventListener('pointerup', () => { pan = null; });
      canvas.addEventListener('pointercancel', () => { pan = null; });
    }
    if (this.cropMode) {
      frame.addClass('pw-cropping');
      const pixelRatio = this.recipe.cropRatio === 'original' ? ((this.recipe.quarterTurns ?? 0) % 2 ? this.bitmap.height / this.bitmap.width : this.bitmap.width / this.bitmap.height) : Number(this.recipe.cropRatio);
      const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio * canvas.height / canvas.width : 0;
      this.cropDraft = fitCropRatio(this.cropDraft ?? this.recipe.crop, ratio);
      const overlay = frame.createDiv('pw-crop-overlay'); overlay.tabIndex = 0; overlay.setAttribute('aria-label', 'Move crop area with arrow keys; Enter applies, Escape cancels');
      const handles: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      for (const handle of handles) {
        const control = overlay.createEl('button', { cls: 'pw-crop-handle pw-crop-' + handle, attr: { 'aria-label': 'Resize crop ' + handle, 'data-handle': handle } });
        control.addEventListener('keydown', event => adjustKey(event, handle));
      }
      const paint = () => { const crop = this.cropDraft!; overlay.style.left = crop.x * 100 + '%'; overlay.style.top = crop.y * 100 + '%'; overlay.style.width = crop.width * 100 + '%'; overlay.style.height = crop.height * 100 + '%'; };
      const adjustKey = (event: KeyboardEvent, handle?: Handle) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const step = event.shiftKey ? 10 : 1, rect = canvas.getBoundingClientRect();
        const dx = (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0) / rect.width;
        const dy = (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) / rect.height;
        this.cropDraft = handle ? resizeCrop(this.cropDraft!, handle, dx, dy, ratio) : moveCrop(this.cropDraft!, dx, dy); paint();
      };
      overlay.addEventListener('keydown', event => { if (event.target === overlay) adjustKey(event); });
      const point = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }; };
      let drag: { start: { x: number; y: number }; crop: Recipe['crop']; mode: Handle | 'move' | 'draw' } | null = null;
      frame.addEventListener('pointerdown', event => {
        if (event.button !== 0) return; event.preventDefault(); event.stopPropagation();
        const target = event.target as HTMLElement, handle = target.dataset.handle as Handle | undefined;
        drag = { start: point(event), crop: { ...this.cropDraft! }, mode: handle ?? (overlay.contains(target) ? 'move' : 'draw') };
        frame.setPointerCapture(event.pointerId); (handle ? target : overlay).focus();
      });
      frame.addEventListener('pointermove', event => {
        if (!drag) return; const end = point(event), dx = end.x - drag.start.x, dy = end.y - drag.start.y;
        this.cropDraft = drag.mode === 'move' ? moveCrop(drag.crop, dx, dy) : drag.mode === 'draw' ? drawCrop(drag.start, end, ratio) : resizeCrop(drag.crop, drag.mode, dx, dy, ratio); paint();
      });
      frame.addEventListener('pointerup', event => { drag = null; if (frame.hasPointerCapture(event.pointerId)) frame.releasePointerCapture(event.pointerId); });
      frame.addEventListener('pointercancel', () => { if (drag) this.cropDraft = drag.crop; drag = null; paint(); });
      paint();
    }
  }
  beginCrop(): void { this.cropMode = true; this.cropDraft = { ...this.recipe.crop }; this.renderPreview(); this.plugin.emit('selection'); }
  finishCrop(apply: boolean): void {
    const draft = this.cropDraft; this.cropMode = false; this.cropDraft = null;
    if (apply && draft) this.commitRecipe({ ...this.recipe, crop: draft });
    this.renderPreview(); this.plugin.emit('selection'); this.contentEl.focus();
  }

  drawHistogram(canvas: HTMLCanvasElement): void {
    if (!this.bitmap) return;
    const sample = renderPhoto(this.bitmap, this.recipe, 300), context = sample.getContext('2d')!;
    const bins = histogram(context.getImageData(0, 0, sample.width, sample.height).data), max = Math.max(...bins, 1);
    canvas.width = 256; canvas.height = 65; const out = canvas.getContext('2d')!;
    out.fillStyle = '#8aa9b8'; bins.forEach((value, i) => out.fillRect(i, 65 - value / max * 65, 1, value / max * 65)); sample.width = sample.height = 1;
  }
  async exportCopy(): Promise<void> {
    if (!this.bitmap || !this.current) return;
    if (this.embeddedPreview) { new Notice('This is an embedded preview. Export from a developed JPEG or PNG to preserve full image quality.'); return; }
    if (this.bitmap.width * this.bitmap.height > 60_000_000) { new Notice('This image exceeds the 60 megapixel editing export limit.'); return; }
    const photo = this.current, recipe = structuredClone(this.recipe), catalog = this.recipeCatalog, connection = structuredClone(this.plugin.settings);
    try {
      const canvas = renderPhoto(this.bitmap, recipe, Math.max(this.bitmap.width, this.bitmap.height));
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PNG export failed')), 'image/png'));
      const folder = normalizePath(this.plugin.settings.exportFolder);
      if (folder.startsWith('/') || folder.split('/').includes('..') || /^[a-z]:/i.test(folder)) throw new Error('Choose an export folder inside the vault.');
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      const stem = photo.name.slice(0, -extname(photo.name).length).replace(/[\\/:*?"<>|]/g, '-');
      let path = normalizePath(`${folder}/${stem}-edited.png`), suffix = 2;
      while (this.app.vault.getAbstractFileByPath(path)) path = normalizePath(`${folder}/${stem}-edited-${suffix++}.png`);
      await this.app.vault.createBinary(path, await blob.arrayBuffer());
      await this.plugin.saveRecipe(photo.id, recipe, catalog);
      let metadataSaved = false;
      const adapter = this.app.vault.adapter;
      if (adapter instanceof FileSystemAdapter) {
        try {
          await this.plugin.bridge.run('export-metadata', { settings: connection, id: photo.id, outputPath: join(adapter.getBasePath(), path), exportRoot: join(adapter.getBasePath(), folder), width: canvas.width, height: canvas.height });
          metadataSaved = true;
        } catch (error) { new Notice(`The image was exported, but metadata copying failed: ${String(error)}`, 10000); }
      }
      canvas.width = canvas.height = 1;
      new Notice(`Saved ${path}${metadataSaved ? ' with photo metadata' : ''}. Export is an sRGB PNG copy.`);
    } catch (error) { this.plugin.fail(error); }
  }
}

export class InspectorView extends PhotoView {
  getViewType(): string { return VIEW_TYPES.inspector; }
  getDisplayText(): string { return 'Photo inspector'; }
  getIcon(): string { return 'sliders-horizontal'; }
  async onOpen(): Promise<void> { this.base(); this.listen('selection', () => this.render()); this.listen('catalog', () => this.render()); this.render(); }
  render(): void {
    const scroll = this.contentEl.scrollTop; this.contentEl.empty();
    this.contentEl.createDiv('pw-panel-head').createEl('strong', { text: 'Photo inspector' });
    const browser = this.plugin.activeBrowser;
    const selected = browser?.photos.filter(p => browser.selected.has(p.id)) ?? [];
    if (browser?.current && !selected.some(p => p.id === browser.current!.id) && browser.mode === 'preview') selected.push(browser.current);
    if (!browser || !selected.length) { empty(this.contentEl, 'Select a photo', 'Properties, tags, ratings, and editing tools appear here.'); return; }
    const photo = selected[0], multiple = selected.length > 1;
    this.contentEl.createEl('p', { cls: 'pw-inspector-title', text: multiple ? `${selected.length} photos selected` : photo.name });
    const shared = (key: keyof Photo) => selected.every(p => p[key] === photo[key]) ? String(photo[key] ?? '') : 'mixed';
    const label = (name: string, value: string) => { const row = this.contentEl.createDiv('pw-property'); row.createSpan({ text: name }); row.createSpan({ text: value }); };
    if (!multiple) {
      label('Dimensions', `${photo.width ?? '?'} × ${photo.height ?? '?'}`); label('Captured', photo.date ?? 'Unknown');
      label('Camera', photo.camera || 'Unknown'); if (photo.lens) label('Lens', photo.lens);
      label('Format', photo.format || extname(photo.name)); label('Size', photo.fileSize ? (photo.fileSize / 1048576).toFixed(1) + ' MB' : 'Unknown');
      this.contentEl.createEl('p', { cls: 'pw-file-path', text: photo.path ?? 'Collection folder is not mapped.' });
    }
    for (const [name, key, values] of [['Rating', 'rating', ['Unrated', '★', '★★', '★★★', '★★★★', '★★★★★']], ['Color', 'color', COLORS], ['Pick', 'pick', PICKS]] as const) {
      new Setting(this.contentEl).setName(name).addDropdown(d => {
        if (shared(key) === 'mixed') d.addOption('mixed', 'Mixed');
        values.forEach((v, i) => d.addOption(String(i), v)); d.setValue(shared(key));
        d.onChange(value => { if (value !== 'mixed') void this.plugin.apply({ [key]: Number(value) }); });
      });
    }
    const commonTags = photo.tags.filter(tag => selected.every(p => p.tags.includes(tag)));
    this.contentEl.createEl('p', { cls: 'pw-eyebrow', text: multiple ? 'Shared tags' : 'Tags' });
    const tags = this.contentEl.createDiv('pw-tag-chips');
    for (const tag of commonTags) button(tags, tag + ' ×', () => { void this.plugin.apply({ removeTags: [tag] }); }, `Remove ${tag} from selection`).addClass('pw-tag-chip');
    button(tags, '+ Add tags', () => this.plugin.tagPrompt());
    if (multiple && selected.some(p => p.tags.length !== commonTags.length)) this.contentEl.createEl('p', { cls: 'pw-hint', text: 'Some photos have additional tags. Existing tags are preserved.' });
    for (const [name, key] of [['Title', 'title'], ['Caption', 'caption']] as const) {
      const current = shared(key);
      new Setting(this.contentEl).setName(name).setDesc(current === 'mixed' ? 'Mixed values' : current || 'Not set').addButton(b => b.setButtonText('Edit').onClick(() => new TextPrompt(this.plugin, `Edit ${name.toLowerCase()}`, `Apply to ${selected.length} selected photo${multiple ? 's' : ''}.`, current === 'mixed' ? '' : current, value => { void this.plugin.apply({ [key]: value }); }).open()));
    }
    if (selected.some(p => p.pending)) this.contentEl.createEl('p', { cls: 'pw-sync-note', text: 'Metadata saved to files' });
    if (!multiple) button(this.contentEl, 'Create photo note', () => { void this.plugin.createPhotoNote(photo).catch(error => this.plugin.fail(error)); });
    if (browser.mode === 'preview' && !multiple) this.editor(browser);
    else if (!multiple) button(this.contentEl, 'Open preview & edit', () => { void browser.openPhoto(photo); });
    this.contentEl.scrollTop = scroll;
  }
  private editor(browser: BrowserView): void {
    const section = this.contentEl.createDiv('pw-editor'); section.createEl('p', { cls: 'pw-eyebrow', text: 'Image adjustments' });
    if (browser.embeddedPreview) section.createEl('p', { cls: 'pw-hint', text: 'RAW / embedded preview. Adjustments can be previewed, but full-quality export requires a developed image.' });
    const histogramCanvas = section.createEl('canvas', { cls: 'pw-histogram', attr: { 'aria-label': 'Luminance histogram' } }); browser.drawHistogram(histogramCanvas);
    button(section, 'I’m Feeling Lucky', () => { browser.commitRecipe({ ...browser.recipe, auto: 100 }); this.render(); }).addClass('pw-lucky');
    const slider = (name: string, key: keyof Recipe, min: number, max: number, step: number) => {
      const row = section.createDiv('pw-adjustment'); const heading = row.createDiv('pw-adjustment-label'); heading.createSpan({ text: name }); const value = heading.createSpan({ text: String(browser.recipe[key]) });
      const input = row.createEl('input', { type: 'range', attr: { min: String(min), max: String(max), step: String(step), 'aria-label': name } }); input.value = String(browser.recipe[key]);
      let baseline: Recipe | null = null;
      input.addEventListener('pointerdown', () => { baseline = structuredClone(browser.recipe); });
      input.addEventListener('input', () => {
        const next = { ...browser.recipe, [key]: Number(input.value) };
        if (key === 'black') next.black = Math.min(next.black, next.white - 1);
        if (key === 'white') next.white = Math.max(next.white, next.black + 1);
        value.setText(String(next[key])); browser.commitRecipe(next, baseline === null); baseline ??= structuredClone(browser.recipe);
      });
      input.addEventListener('change', () => { if (baseline) { const final = structuredClone(browser.recipe); browser.recipe = baseline; browser.commitRecipe(final); baseline = null; } browser.drawHistogram(histogramCanvas); });
    };
    slider('Automatic strength', 'auto', 0, 100, 1);
    slider('Exposure', 'exposure', -3, 3, .05); slider('Contrast', 'contrast', -75, 100, 1);
    slider('Highlights', 'highlights', -100, 100, 1); slider('Shadows', 'shadows', -100, 100, 1);
    slider('Temperature', 'temperature', -100, 100, 1); slider('Tint', 'tint', -100, 100, 1);
    slider('Saturation', 'saturation', -100, 100, 1); slider('Vibrance', 'vibrance', -100, 100, 1);
    section.createEl('p', { cls: 'pw-eyebrow', text: 'Levels' });
    slider('Black point', 'black', 0, 254, 1); slider('White point', 'white', 1, 255, 1); slider('Midtone gamma', 'gamma', .2, 3, .05);
    section.createEl('p', { cls: 'pw-eyebrow', text: 'Geometry' }); slider('Straighten', 'angle', -15, 15, .1);
    new Setting(section).setName('Crop ratio').addDropdown(d => {
      for (const [value, label] of [['free', 'Free'], ['original', 'Original'], ['1', '1:1'], [String(4 / 3), '4:3'], [String(3 / 2), '3:2'], [String(16 / 9), '16:9'], [String(2 / 3), '2:3'], [String(3 / 4), '3:4']]) d.addOption(value, label);
      if (!['free', 'original', '1', String(4 / 3), String(3 / 2), String(16 / 9), String(2 / 3), String(3 / 4)].includes(browser.recipe.cropRatio)) d.addOption(browser.recipe.cropRatio, 'Custom');
      d.setValue(browser.recipe.cropRatio).onChange(value => browser.commitRecipe({ ...browser.recipe, cropRatio: value }));
    });
    const actions = section.createDiv('pw-actions');
    if (browser.cropMode) { button(actions, 'Apply crop', () => browser.finishCrop(true)); button(actions, 'Cancel crop', () => browser.finishCrop(false)); }
    else button(actions, 'Adjust crop', () => browser.beginCrop());
    button(actions, 'Custom ratio', () => new TextPrompt(this.plugin, 'Custom crop ratio', 'Enter width:height, such as 5:7.', '5:7', value => { const [w, h] = value.split(':').map(Number); if (!(w > 0 && h > 0)) { new Notice('Use a positive width:height ratio.'); return; } browser.commitRecipe({ ...browser.recipe, cropRatio: String(w / h) }); this.render(); }).open());

    button(actions, 'Reset crop', () => { browser.commitRecipe({ ...browser.recipe, crop: { x: 0, y: 0, width: 1, height: 1 } }); });
    if (browser.cropMode) section.createEl('p', { cls: 'pw-hint', text: 'Drag the crop area to move it, or drag its handles to resize. Apply crop (Enter) commits; Escape cancels. Focus a handle and use arrow keys for fine adjustments.' });
    button(section, 'Reset all adjustments', () => { browser.commitRecipe(freshRecipe()); this.render(); });
    section.createEl('p', { cls: 'pw-hint', text: 'Recipes are saved in this vault. Export creates an sRGB PNG copy. Original image pixels are unchanged.' });
  }
}
