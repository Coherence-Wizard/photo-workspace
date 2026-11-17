import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';

function loadViews() {
  const doc = {}, handlers: any[] = [];
  const element = (): any => ({ ownerDocument: doc, addClass() {}, createDiv: element, createEl: element, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, focus() {} });
  class ItemView {
    contentEl = element(); app = {};
    register() {} registerEvent() {} registerDomEvent(target: any, type: string, callback: any) { handlers.push({ target, type, callback }); }
  }
  const code = buildSync({ entryPoints: ['src/views.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['obsidian', 'electron'], loader: { '.py': 'text' }, write: false }).outputFiles[0].text;
  const module = { exports: {} as any }, native = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', code)((name: string) => name === 'obsidian' ? { ItemView, Plugin: class {}, PluginSettingTab: class {}, Modal: class {}, AbstractInputSuggest: class {}, SuggestModal: class {} } : name === 'electron' ? {} : native(name), module, module.exports);
  return { View: module.exports.BrowserView, handlers, doc };
}

test('thumbnail arrows select, extend selection and load the next page; T opens tags', async () => {
  const { View, handlers } = loadViews(); let tags = 0;
  const plugin: any = { settings: { recipes: {} }, subscribe: () => () => {}, emit() {}, tagPrompt() { tags++; } };
  const view = new View({}, plugin); view.renderToolbar = view.renderFooter = () => {};
  await view.onOpen();
  view.photos = [{ id: 1 }, { id: 2 }]; view.selected = new Set([1]); view.current = view.photos[0];
  view.grid = { querySelectorAll: () => [], querySelector: () => ({ focus() {}, scrollIntoView() {} }) };
  await view.navigate(1); assert.deepEqual([...view.selected], [2]); assert.equal(view.current.id, 2);
  view.hasMore = true; view.loadMore = async () => { view.photos.push({ id: 3 }); view.hasMore = false; };
  await view.navigate(1, true); assert.deepEqual([...view.selected], [2, 3]); assert.equal(view.current.id, 3);
  const keydown = handlers.find(h => h.target === view.contentEl).callback;
  keydown({ key: 't', target: { closest: () => null }, preventDefault() {} }); assert.equal(tags, 1);
  keydown({ key: 't', target: { closest: () => ({}) }, preventDefault() {} }); assert.equal(tags, 1);
});

test('save and undo shortcuts are scoped to photo panes and preserve text-field undo', async () => {
  const { View, handlers, doc } = loadViews();
  const plugin: any = { settings: { recipes: {} }, subscribe: () => () => {}, emit() {} };
  const view = new View({}, plugin); view.renderToolbar = view.renderFooter = () => {};
  await view.onOpen(); let saved = 0, undone = 0, redone = 0;
  view.saveEdits = async () => { saved++; }; view.undoEdit = async () => { undone++; }; view.redoRecipe = () => { redone++; };
  const callback = handlers.find(h => h.target === doc).callback;
  const event = (key: string, text = false, shiftKey = false) => ({ key, ctrlKey: true, shiftKey, target: { closest: (selector: string) => selector === '.pw-view' ? {} : selector.startsWith('textarea') && text ? {} : null }, preventDefault() {}, stopImmediatePropagation() {} });
  callback(event('s')); callback(event('z')); callback(event('z', false, true));
  assert.deepEqual([saved, undone, redone], [1, 1, 1]);
  callback(event('z', true)); assert.equal(undone, 1);
  plugin.busy = true; callback(event('s')); assert.equal(saved, 1);
});
