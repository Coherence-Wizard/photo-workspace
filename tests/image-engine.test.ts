import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustPixels, autoLevels, constrainCrop, histogram } from '../src/image-engine';
import { freshRecipe, toggleSelection, parsePhotoTags } from '../src/types';

test('neutral adjustments preserve pixel values and alpha', () => {
  const pixels = new Uint8ClampedArray([0, 20, 100, 255, 250, 128, 42, 120]);
  const before = new Uint8ClampedArray(pixels); adjustPixels(pixels, freshRecipe());
  assert.deepEqual(pixels, before);
});
test('exposure and saturation produce bounded pixels', () => {
  const pixels = new Uint8ClampedArray([64, 64, 64, 255, 240, 50, 20, 120]);
  adjustPixels(pixels, { ...freshRecipe(), exposure: 1, saturation: -100 });
  assert.equal(pixels[0], 128); assert.equal(pixels[1], 128); assert.equal(pixels[2], 128);
  assert.equal(pixels[4], pixels[5]); assert.equal(pixels[5], pixels[6]); assert.equal(pixels[7], 120);
});
test('crop cannot leave the image or produce empty dimensions', () => {
  assert.deepEqual(constrainCrop(-1, 2, 0, 100), { x: 0, y: .99, width: .01, height: 1 - .99 });
});
test('automatic levels do not amplify a flat image', () => {
  const data = new Uint8ClampedArray([100, 100, 100, 255, 100, 100, 100, 255]);
  assert.deepEqual(autoLevels(histogram(data)), [0, 255]);
});
test('shift and command selection work independently of the viewport', () => {
  assert.deepEqual([...toggleSelection(new Set([1]), [1, 2, 3, 4], 4, 1, true, false)], [1, 2, 3, 4]);
  assert.deepEqual([...toggleSelection(new Set([1, 2]), [1, 2, 3], 2, 1, false, true)], [1]);
});


test('resize fits both bounds, preserves proportions and respects no enlargement', async () => {
  const { resizeDimensions } = await import('../src/image-engine');
  assert.deepEqual(resizeDimensions(4000, 3000, 'inside', 1920, 1080, 50, false), { width: 1440, height: 1080 });
  assert.deepEqual(resizeDimensions(640, 420, 'inside', 1920, 1080, 50, false), { width: 640, height: 420 });
  assert.deepEqual(resizeDimensions(640, 420, 'percent', 0, 0, 50, false), { width: 320, height: 210 });
  assert.throws(() => resizeDimensions(4000, 3000, 'percent', 0, 0, 400, true), /limit/);
});

test('comma separated photo tags retain hierarchy and reject empty components', () => {
  assert.deepEqual(parsePhotoTags('Art, Adventure, Places / Oregon / Coast, Art, '), ['Art', 'Adventure', 'Places/Oregon/Coast']);
  assert.throws(() => parsePhotoTags('Art, Places//Coast'));
  assert.throws(() => parsePhotoTags('Places|Coast'));
  assert.deepEqual(parsePhotoTags(' , '), []);
});

test('tag selection supports additive and visible-range selection', () => {
  const tags = ['A', 'A/Child', 'B', 'C'];
  assert.deepEqual([...toggleSelection(new Set(['A']), tags, 'C', 'A', false, true)], ['A', 'C']);
  assert.deepEqual([...toggleSelection(new Set(['A']), tags, 'B', 'A', true, false)], ['A', 'A/Child', 'B']);
  assert.deepEqual([...toggleSelection(new Set(['A', 'B']), tags, 'A', 'B', false, true)], ['B']);
});
