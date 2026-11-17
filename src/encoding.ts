import { extname } from 'node:path';
import { type Recipe, freshRecipe } from './types';

export function hasEdits(recipe?: Recipe): boolean {
  if (!recipe) return false;
  const base = freshRecipe();
  return Object.keys(base).some(key => key === 'crop' ? Object.keys(base.crop).some(k => recipe.crop[k as keyof Recipe['crop']] !== base.crop[k as keyof Recipe['crop']]) : key !== 'cropRatio' && (recipe[key as keyof Recipe] ?? base[key as keyof Recipe]) !== base[key as keyof Recipe]);
}
export function outputFormat(name: string, choice: string): { extension: string; mime: string } {
  const extension = choice === 'png' ? '.png' : choice === 'jpg' ? '.jpg' : extname(name).toLowerCase();
  const mime = ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' } as Record<string, string>)[extension];
  if (!mime) throw new Error('Edited or resized copies can keep JPEG, PNG, or WebP format. Choose PNG/JPG for this photo, or keep dimensions with no edits to copy the original unchanged.');
  return { extension, mime };
}
export async function encodeCanvas(canvas: HTMLCanvasElement, mime: string, quality = .95): Promise<Uint8Array> {
  // JPEG has no alpha channel. Use white instead of the browser's black flattening.
  let output = canvas;
  if (mime === 'image/jpeg') {
    output = document.createElement('canvas'); output.width = canvas.width; output.height = canvas.height;
    const ctx = output.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, output.width, output.height); ctx.drawImage(canvas, 0, 0);
  }
  try {
    const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(new Error('Image encoding failed.')), mime, quality));
    if (blob.type !== mime) throw new Error('This image encoder is unavailable; the original was not changed.');
    return new Uint8Array(await blob.arrayBuffer());
  } finally { if (output !== canvas) output.width = output.height = 1; }
}
