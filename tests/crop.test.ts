import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawCrop, fitCropRatio, moveCrop, resizeCrop, type Handle } from '../src/crop';
import { freshRecipe, rotateRecipe } from '../src/types';
import { renderPhoto } from '../src/image-engine';

test('crop handles preserve opposite anchors and stay inside the image', () => {
  const crop = { x: .2, y: .2, width: .5, height: .4 };
  assert.deepEqual(moveCrop(crop, -1, 1), { ...crop, x: 0, y: .6 });
  for (const handle of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as Handle[]) {
    for (const dx of [-2, .1, 2]) for (const dy of [-2, .1, 2]) {
      const next = resizeCrop(crop, handle, dx, dy, 1.25);
      assert.ok(next.x >= -1e-10 && next.y >= -1e-10);
      assert.ok(next.x + next.width <= 1 + 1e-10 && next.y + next.height <= 1 + 1e-10);
      assert.ok(Math.abs(next.width / next.height - 1.25) < 1e-10);
    }
  }
  const resized = resizeCrop(crop, 'nw', -.1, -.1);
  assert.ok(Math.abs(resized.x + resized.width - .7) < 1e-10);
  assert.ok(Math.abs(resized.y + resized.height - .6) < 1e-10);
});
test('crop drawing supports every direction and fixed ratio fitting', () => {
  for (const end of [{x: .1,y: .1}, {x: .9,y: .1}, {x: .9,y: .9}, {x: .1,y: .9}]) {
    const crop = drawCrop({x:.5,y:.5}, end, 2);
    assert.equal(crop.width / crop.height, 2);
    assert.ok(crop.width > 0 && crop.height > 0);
    assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= 1 && crop.y + crop.height <= 1);
  }
  assert.deepEqual(fitCropRatio({x:0,y:0,width:1,height:1},2),{x:0,y:.25,width:1,height:.5});
});
test('four clockwise turns restore crop and preserve adjustment settings', () => {
  let recipe = { ...freshRecipe(), crop: {x:.1,y:.2,width:.6,height:.5}, exposure: 1, cropRatio:'1.2' };
  const first = rotateRecipe(recipe);
  assert.equal(first.quarterTurns, 1); assert.equal(first.crop.width, .5); assert.equal(first.crop.height, .6);
  for (let i=0;i<4;i++) recipe = rotateRecipe(recipe);
  assert.equal(recipe.quarterTurns,0); assert.equal(recipe.exposure,1);
  for (const key of ['x','y','width','height'] as const) assert.ok(Math.abs(recipe.crop[key] - ({x:.1,y:.2,width:.6,height:.5})[key]) < 1e-10);
});
test('90-degree rendering swaps canvas dimensions without zooming or clipping', () => {
  const rotations: number[] = [], scales: number[][] = [];
  const old = globalThis.document;
  const context = { translate() {}, rotate(n: number) { rotations.push(n); }, scale(...n: number[]) { scales.push(n); }, drawImage() {}, resetTransform() {}, getImageData() { return {data: new Uint8ClampedArray(0)}; }, putImageData() {} };
  globalThis.document = { createElement: () => ({width:0,height:0,getContext:()=>context}) } as unknown as Document;
  try {
    const output = renderPhoto({width:600,height:400} as ImageBitmap, rotateRecipe(freshRecipe()));
    assert.equal(output.width,400); assert.equal(output.height,600);
    assert.equal(rotations[0],Math.PI/2); assert.deepEqual(scales[0],[1,1]);
  } finally { globalThis.document = old; }
});
