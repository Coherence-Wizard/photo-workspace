import { ItemView, Notice, Setting, WorkspaceLeaf } from 'obsidian';
import { basename } from 'node:path';
import type PhotoWorkspace from './main';
import type { Photo } from './types';

const titles = { duplicates: 'Duplicate wizard', people: 'People recognition', semantic: 'Semantic search' };
type Feature = keyof typeof titles;
const features = Object.keys(titles) as Feature[];
const viewId = (feature: Feature) => 'photo-workspace-' + feature;
const descriptions = {
  duplicates: 'Compare decoded pictures even when filenames, tags, or ratings differ. Downloads Pillow.',
  people: 'Name faces and review suggestions on other photos. Downloads OpenCV and two face models (about 39 MB of models).',
  semantic: 'Search image content with phrases like “rusty door”. Downloads ONNX Runtime, a tokenizer, and CLIP models (about 156 MB of models).'
};
const installations = new WeakSet<PhotoWorkspace>();

export function advancedSettings(el: HTMLElement, plugin: PhotoWorkspace): void {
  const section = el.createEl('details');
  section.createEl('summary', { text: 'Advanced' });
  section.createEl('p', { text: 'Set up the tools you want, then open them from the command palette. Setup downloads packages from PyPI and models from Hugging Face into this vault’s plugin folder. Searches and photo scans run locally.' });
  for (const feature of features) {
    const setting = new Setting(section).setName(titles[feature]).setDesc(descriptions[feature]);
    const status = section.createEl('small', { attr: { role: 'status' } });
    setting.addButton(button => {
      button.setButtonText('Set up').onClick(async () => {
        if (installations.has(plugin)) { new Notice('Another tool is being installed.'); return; }
        installations.add(plugin); button.setDisabled(true); status.setText('Downloading and installing…');
        try {
          await plugin.bridge.run('advanced-install', { feature });
          status.setText('Ready. Open ' + titles[feature] + ' from the command palette.');
          button.setButtonText('Repair');
        } catch (e) { status.setText(String(e) + ' If no compatible package is available, install Python 3.12 and retry.'); }
        finally { installations.delete(plugin); button.setDisabled(false); }
      });
      section.addEventListener('toggle', async () => {
        if (!section.open || installations.has(plugin)) return;
        try { if (await plugin.bridge.run('advanced-status', { feature })) { status.setText('Ready'); button.setButtonText('Repair'); } } catch (e) { status.setText(String(e)); }
      });
    });
  }
}

export function registerAdvanced(plugin: PhotoWorkspace): void {
  for (const feature of features) {
    plugin.registerView(viewId(feature), leaf => new AnalysisView(leaf, plugin, feature));
    plugin.addCommand({ id: 'advanced-' + feature, name: titles[feature], callback: async () => {
      const leaf = await plugin.ensureView(viewId(feature), 'right');
      await plugin.app.workspace.revealLeaf(leaf);
    } });
  }
}

interface Hit { id: number; path: string; key: string; preview: string; guess: string; hash: string; tags: string[]; rating: number; }
class AnalysisView extends ItemView {
  private fuzz = 50;
  private offset = 0;
  private query = '';
  private controller?: AbortController;
  private results!: HTMLElement;
  private status!: HTMLElement;
  private revision = 0;
  constructor(leaf: WorkspaceLeaf, private plugin: PhotoWorkspace, private feature: Feature) { super(leaf); }
  getViewType() { return viewId(this.feature); }
  getDisplayText() { return titles[this.feature]; }
  getIcon() { return { duplicates: 'copy', people: 'users', semantic: 'search' }[this.feature]; }
  async onClose() { this.controller?.abort(); this.revision++; }
  async onOpen() {
    this.contentEl.empty();
    this.contentEl.createEl('h3', { text: this.getDisplayText() });
    this.status = this.contentEl.createEl('p', { attr: { role: 'status' } });
    if (!await this.plugin.bridge.run('advanced-status', { feature: this.feature }).catch(() => false)) {
      this.status.setText('Set up this tool under Coherence Photo settings → Advanced. Then reopen this tab.');
      new Setting(this.contentEl).addButton(b => b.setButtonText('Check setup').onClick(() => this.onOpen()));
      return;
    }
    const controls = new Setting(this.contentEl);
    controls.addButton(b => b.setButtonText('Scan collection').onClick(async () => {
      if (this.controller) return;
      const controller = new AbortController(); this.controller = controller;
      b.setDisabled(true); this.status.setText('Opening the local collection…');
      try {
        const r = await this.plugin.bridge.run<{processed:number; reused:number; errors:number}>('advanced-scan', { feature: this.feature }, p => this.status.setText('Scanned ' + p.processed + ' of ' + p.total), controller.signal);
        this.offset = 0; await this.show();
        this.status.setText('Scanned ' + r.processed + ' · reused ' + r.reused + ' · skipped ' + r.errors);
      } catch (e) { this.status.setText(controller.signal.aborted ? 'Paused. Scan again to resume.' : String(e)); }
      finally { this.controller = undefined; b.setDisabled(false); }
    })).addButton(b => b.setButtonText('Pause').onClick(() => this.controller?.abort()));
    if (this.feature === 'people') new Setting(this.contentEl).setName('Match fuzziness').setDesc('Higher values suggest looser matches. Confirm a name to teach it.').addSlider(s => s.setLimits(0,100,1).setValue(this.fuzz).setDynamicTooltip().onChange(v => { this.fuzz = v; })).addButton(b => b.setButtonText('Update suggestions').onClick(() => this.show()));
    if (this.feature === 'semantic') new Setting(this.contentEl).addText(t => {
      t.setPlaceholder('Search photos, e.g. rusty door').onChange(v => this.query = v.trim());
      t.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') void this.show(); });
    }).addButton(b => b.setButtonText('Search').onClick(() => this.show()));
    this.results = this.contentEl.createDiv('pw-analysis-results');
    await this.show();
  }
  private openPhoto(hit: Hit, collection: string) {
    if (collection !== this.plugin.connectionKey()) return;
    void (async () => {
      const photo = await this.plugin.bridge.run<Photo>('photo', { id: hit.id });
      if (photo.path !== hit.path) throw new Error('Photo location changed. Scan again.');
      const leaf = await this.plugin.ensureView('photo-workspace-browser','center');
      const browser = leaf.view as import('./views').BrowserView;
      await this.app.workspace.revealLeaf(leaf); await browser.openPhoto(photo);
    })().catch(e => this.plugin.fail(e));
  }
  private async show() {
    const rev = ++this.revision, collection = this.plugin.connectionKey();
    this.results.empty();
    if (!this.plugin.hasConnection()) { this.status.setText('Choose a photo folder in settings first.'); return; }
    if (this.feature === 'semantic' && !this.query) { this.status.setText('Scan the collection, then enter a description.'); return; }
    this.status.setText('Loading results…');
    try {
      const rows = await this.plugin.bridge.run<(Hit | Hit[])[]>('advanced-results', { feature:this.feature, query:this.query, offset:this.offset, fuzz:this.fuzz });
      if (rev !== this.revision || collection !== this.plugin.connectionKey()) return;
      this.status.setText(rows.length ? '' : 'No results on this page. Scan the collection to index photos.');
      for (const row of rows) {
        if (Array.isArray(row)) this.group(row, collection);
        else {
          const card = this.results.createDiv('pw-analysis-card');
          if (row.preview) card.createEl('img',{attr:{src:'data:image/jpeg;base64,'+row.preview, width:'80', alt:'Detected face'}});
          const open = card.createEl('button',{ text:basename(row.path),attr:{title:row.path} }); open.onclick = () => this.openPhoto(row,collection);
          if (this.feature === 'people') {
            const input = card.createEl('input',{placeholder:'Person name'}); input.value = row.guess;
            const confirm = card.createEl('button',{text:'Confirm name'});
            confirm.onclick = async () => {
              if (collection !== this.plugin.connectionKey() || this.plugin.busy || this.plugin.scanning) return;
              this.plugin.busy = true; confirm.disabled = true;
              try { await this.plugin.bridge.run('advanced-name',{feature:this.feature,id:row.id,key:row.key,name:input.value}); await this.show(); this.plugin.catalog = await this.plugin.bridge.run('catalog'); this.plugin.emit('tags'); }
              catch (e) { this.status.setText(String(e)); } finally { this.plugin.busy = false; confirm.disabled = false; }
            };
          }
        }
      }
      const size = this.feature === 'duplicates' ? 10 : 24;
      if (this.feature !== 'semantic') {
        if (this.offset) this.results.createEl('button',{text:'Previous'}).onclick = () => { this.offset = Math.max(0,this.offset-size); void this.show(); };
        if (rows.length === size) this.results.createEl('button',{text:'Next'}).onclick = () => { this.offset += size; void this.show(); };
      }
    } catch (e) { if (rev === this.revision) this.status.setText(String(e)); }
  }
  private group(items: Hit[], collection: string) {
    const card = this.results.createDiv('pw-analysis-card'); card.createEl('strong',{text:items.length+' identical pictures'});
    const keep = new Set(items.map(x => x.id));
    const remove = card.createEl('button',{text:'Trash unchecked copies…'}); remove.disabled = true;
    for (const hit of items) {
      const label = card.createEl('label'), check = label.createEl('input',{type:'checkbox'}); check.checked = true;
      label.appendText(' Keep '+hit.path);
      card.createEl('small',{text:[hit.rating ? hit.rating+' stars' : 'Unrated', ...hit.tags].join(' · ')});
      card.createEl('button',{text:'Preview'}).onclick = () => this.openPhoto(hit,collection);
      check.onchange = () => { if (check.checked) keep.add(hit.id); else keep.delete(hit.id); remove.disabled = !keep.size || keep.size === items.length; };
    }
    remove.onclick = () => {
      if (collection !== this.plugin.connectionKey() || !keep.size) return;
      const keeper = items.find(h => keep.has(h.id))!;
      this.plugin.deletePhotos(items.filter(h => !keep.has(h.id)).map(h => h.id), async id => {
        if (collection !== this.plugin.connectionKey()) throw new Error('Collection changed.');
        await this.plugin.bridge.run('advanced-verify',{feature:'duplicates', hash:keeper.hash, items:[keeper,items.find(h => h.id===id)]});
      });
    };
  }
}
