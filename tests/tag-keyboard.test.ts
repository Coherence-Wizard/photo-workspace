import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';

test('tag entry queues with Enter and commits only on a second empty-field Enter', () => {
  let input: any, suggestion: any, focused = false;
  const element = (type?: string): any => {
    const el: any = { value:'', events:{} as any, empty(){}, setText(){}, focus(){focused=true;}, createDiv(){return element();}, createEl(tag: string){const child=element(tag); if(tag==='input') input=child; return child;}, addEventListener(name:string,fn:any){el.events[name]=fn;} };
    return el;
  };
  class Modal { titleEl=element(); contentEl=element(); closed=false; enter:any; scope={register:(_:any,key:string,fn:any)=>{if(key==='Enter')this.enter=fn;}}; constructor(_:unknown){} close(){this.closed=true;(this as any).onClose();} }
  class Suggest { constructor(_:any,__:any){suggestion=this;} setValue(v:string){input.value=v;} close(){} }
  class Setting { constructor(_:any){} addButton(fn:any){const c:any={}; for(const k of ['setButtonText','onClick','setCta'])c[k]=()=>c;fn(c);return this;} }
  const code=buildSync({entryPoints:['src/main.ts'],bundle:true,platform:'node',format:'cjs',external:['obsidian','electron'],loader:{'.py':'text'},write:false}).outputFiles[0].text;
  const module={exports:{} as any}, nativeRequire=createRequire(import.meta.url);
  new Function('require','module','exports',code)((name:string)=>name==='obsidian'?{Modal,AbstractInputSuggest:Suggest,Setting,Plugin:class{},PluginSettingTab:class{},ItemView:class{},Notice:class{},SuggestModal:class{}}:name==='electron'?{shell:{}}:nativeRequire(name),module,module.exports);
  const writes:any[]=[];
  const plugin={app:{},catalog:{key:'a'},activeBrowser:{selected:new Set([17]),contentEl:{focus(){focused=true;}}},availableTags:()=>['Art'],fail(e:unknown){throw e;},apply(p:any,ids:any){writes.push({p,ids});}};
  const dialog=new module.exports.TagPrompt(plugin);dialog.onOpen();
  const enter=(overrides={})=>({key:'Enter',repeat:false,isComposing:false,preventDefault(){},stopImmediatePropagation(){},...overrides});
  input.events.keydown(enter());assert.equal(dialog.closed,false);assert.equal(writes.length,0);
  input.value='ar';suggestion.selectSuggestion('Art');assert.equal(input.value,'');assert.equal(writes.length,0);
  input.events.keydown(enter({isComposing:true}));assert.equal(writes.length,0);
  input.value='Places/Coast, Travel';dialog.enter(enter());assert.equal(input.value,'');assert.equal(writes.length,0);
  input.events.keydown(enter());assert.deepEqual(writes,[{p:{addTags:['Art','Places/Coast','Travel']},ids:[17]}]);assert.equal(dialog.closed,true);assert.equal(focused,true);
});
