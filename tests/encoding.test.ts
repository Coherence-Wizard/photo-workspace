import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputFormat, hasEdits, encodeCanvas } from '../src/encoding';
import { freshRecipe } from '../src/types';

test('original format preserves JPEG/PNG/WebP extensions and rejects unsupported encoders', () => {
  assert.deepEqual(outputFormat('original.JPEG', 'original'), { extension: '.jpeg', mime: 'image/jpeg' });
  assert.equal(outputFormat('original.webp', 'original').mime, 'image/webp');
  assert.equal(outputFormat('original.nef', 'png').extension, '.png');
  assert.equal(outputFormat('original.png', 'jpg').mime, 'image/jpeg');
  assert.throws(() => outputFormat('original.tif', 'original'), /Choose PNG\/JPG/);
});
test('only pixel changes require baking; selecting a crop ratio does not recompress originals', () => {
  assert.equal(hasEdits(), false); assert.equal(hasEdits(freshRecipe()), false);
  assert.equal(hasEdits({ ...freshRecipe(), quarterTurns: undefined, cropRatio: '1' }), false);
  assert.equal(hasEdits({ ...freshRecipe(), auto: 100 }), true);
  assert.equal(hasEdits({ ...freshRecipe(), crop: { x: .1, y: 0, width: .9, height: 1 } }), true);
});
test('encoder rejects a browser silently falling back to PNG', async () => {
  const canvas = { toBlob(fn: (b: Blob) => void) { fn(new Blob(['png'], { type: 'image/png' })); } } as unknown as HTMLCanvasElement;
  await assert.rejects(encodeCanvas(canvas, 'image/webp'), /encoder is unavailable/);
});

test('JPEG conversion flattens transparency onto white before encoding', async () => {
  const old = globalThis.document, calls: string[] = [];
  const context: any = { fillStyle: '', fillRect() { calls.push(context.fillStyle); }, drawImage() { calls.push('image'); } };
  const output: any = { width: 0, height: 0, getContext: () => context, toBlob(fn: any, mime: string, quality: number) { calls.push(mime, String(quality)); fn(new Blob(['jpg'], { type: mime })); } };
  (globalThis as any).document = { createElement: () => output };
  try { await encodeCanvas({ width: 3, height: 2 } as HTMLCanvasElement, 'image/jpeg', .9); assert.deepEqual(calls, ['#fff', 'image', 'image/jpeg', '0.9']); }
  finally { (globalThis as any).document = old; }
});
