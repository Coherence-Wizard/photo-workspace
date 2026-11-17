import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Bridge } from './bridge';
import type { Photo, Recipe } from './types';

const clamp = (x: number, low = 0, high = 255): number => Math.min(high, Math.max(low, x));

/** Pure color pipeline; input and output are sRGB byte values. */
export function adjustPixels(data: Uint8ClampedArray, recipe: Recipe, autoPoints?: [number, number]): void {
  const exposure = 2 ** recipe.exposure;
  const contrast = (100 + recipe.contrast) / 100;
  const black = recipe.black, white = Math.max(black + 1, recipe.white);
  const saturation = 1 + recipe.saturation / 100;
  const auto = recipe.auto / 100;
  const [lo, hi] = autoPoints ?? [0, 255];
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    const luma = (r * .2126 + g * .7152 + b * .0722) / 255;
    const tone = recipe.shadows * (1 - luma) ** 2 * .7 + recipe.highlights * luma ** 2 * .7;
    const channel = (v: number, balance: number) => {
      const autoValue = clamp((v - lo) * 255 / Math.max(1, hi - lo));
      v += (autoValue - v) * auto;
      v = ((v * exposure + balance + tone - 127.5) * contrast + 127.5 - black) / (white - black);
      return clamp(255 * clamp(v, 0, 1) ** (1 / recipe.gamma));
    };
    r = channel(r, recipe.temperature * .35 + recipe.tint * .15);
    g = channel(g, -recipe.tint * .25);
    b = channel(b, -recipe.temperature * .35 + recipe.tint * .15);
    const gray = r * .2126 + g * .7152 + b * .0722;
    const spread = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    const factor = saturation * (1 + recipe.vibrance / 100 * (1 - spread));
    data[i] = clamp(gray + (r - gray) * factor);
    data[i + 1] = clamp(gray + (g - gray) * factor);
    data[i + 2] = clamp(gray + (b - gray) * factor);
  }
}

export function histogram(data: Uint8ClampedArray): number[] {
  const bins = Array<number>(256).fill(0);
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]) bins[Math.round(data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722)]++;
  return bins;
}

export function autoLevels(bins: number[]): [number, number] {
  const total = bins.reduce((a, b) => a + b, 0);
  let count = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) { count += bins[i]; if (count >= total * .005) { lo = i; break; } }
  count = 0;
  for (let i = 255; i >= 0; i--) { count += bins[i]; if (count >= total * .005) { hi = i; break; } }
  return hi - lo < 32 ? [0, 255] : [lo, hi];
}

export function constrainCrop(x: number, y: number, width: number, height: number): Recipe['crop'] {
  x = clamp(x, 0, .99); y = clamp(y, 0, .99);
  return { x, y, width: clamp(width, .01, 1 - x), height: clamp(height, .01, 1 - y) };
}

export async function decodePhoto(photo: Photo, bridge: Bridge): Promise<{ bitmap: ImageBitmap; embeddedPreview: boolean }> {
  if (!photo.path) throw new Error('Choose an available photo folder in settings.');
  const ext = extname(photo.path).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'].includes(ext)) {
    const info = await stat(photo.path);
    if (info.size > 200 * 1024 * 1024) throw new Error('This image exceeds the 200 MB preview limit.');
    const bytes = await readFile(photo.path);
    return { bitmap: await createImageBitmap(new Blob([new Uint8Array(bytes)]), { imageOrientation: 'from-image' }), embeddedPreview: false };
  }
  const preview = await bridge.run<{ data: string; mime: string }>('preview', { id: photo.id });
  return { bitmap: await createImageBitmap(new Blob([new Uint8Array(Buffer.from(preview.data, 'base64'))], { type: preview.mime })), embeddedPreview: true };
}

export function renderPhoto(bitmap: ImageBitmap, recipe: Recipe, maxEdge = 1800): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const baseWidth = Math.max(1, Math.round(bitmap.width * scale)), baseHeight = Math.max(1, Math.round(bitmap.height * scale));
  const turns = (recipe.quarterTurns ?? 0) % 4;
  const width = turns % 2 ? baseHeight : baseWidth, height = turns % 2 ? baseWidth : baseHeight;
  const source = document.createElement('canvas'); source.width = width; source.height = height;
  const context = source.getContext('2d', { willReadFrequently: true })!;
  const radians = recipe.angle * Math.PI / 180;
  // Zoom the rotated image to cover the original rectangle, avoiding empty corners.
  const zoom = Math.max((Math.abs(Math.cos(radians)) * width + Math.abs(Math.sin(radians)) * height) / width,
    (Math.abs(Math.sin(radians)) * width + Math.abs(Math.cos(radians)) * height) / height);
  context.translate(width / 2, height / 2); context.rotate(radians + turns * Math.PI / 2); context.scale(zoom, zoom);
  context.drawImage(bitmap, -baseWidth / 2, -baseHeight / 2, baseWidth, baseHeight); context.resetTransform();
  const crop = constrainCrop(recipe.crop.x, recipe.crop.y, recipe.crop.width, recipe.crop.height);
  const output = document.createElement('canvas');
  output.width = Math.max(1, Math.round(width * crop.width)); output.height = Math.max(1, Math.round(height * crop.height));
  const out = output.getContext('2d', { willReadFrequently: true })!;
  out.drawImage(source, width * crop.x, height * crop.y, width * crop.width, height * crop.height, 0, 0, output.width, output.height);
  const pixels = out.getImageData(0, 0, output.width, output.height);
  adjustPixels(pixels.data, recipe, autoLevels(histogram(pixels.data)));
  out.putImageData(pixels, 0, 0);
  source.width = source.height = 1;
  return output;
}

export class ThumbnailCache {
  private entries = new Map<string, string>();
  private pending = new Map<string, Promise<string>>();
  private active = 0;
  private queue: (() => void)[] = [];
  private disposed = false;
  constructor(private bridge: Bridge, private recipeFor: (photo: Photo) => Recipe | undefined = () => undefined) {}
  async get(photo: Photo): Promise<string> {
    const recipe = this.recipeFor(photo);
    const key = (photo.path ?? String(photo.id)) + ':' + JSON.stringify(recipe ?? null);
    const cached = this.entries.get(key);
    if (cached) { this.entries.delete(key); this.entries.set(key, cached); return cached; }
    if (this.pending.has(key)) return this.pending.get(key)!;
    const task = this.load(photo, key, recipe);
    this.pending.set(key, task);
    try { return await task; } finally { this.pending.delete(key); }
  }
  private async load(photo: Photo, key: string, recipe?: Recipe): Promise<string> {
    if (this.active >= 3) await new Promise<void>(resolve => this.queue.push(resolve));
    this.active++;
    try {
      if (this.disposed) throw new Error('View closed');
      const { bitmap } = await decodePhoto(photo, this.bridge);
      const canvas = recipe ? renderPhoto(bitmap, recipe, 600) : document.createElement('canvas');
      if (!recipe) { const scale = Math.min(1, 600 / Math.max(bitmap.width, bitmap.height)); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale)); canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height); }
      bitmap.close();
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Thumbnail encoding failed')), 'image/jpeg', .8));
      canvas.width = canvas.height = 1;
      if (this.disposed) throw new Error('View closed');
      const url = URL.createObjectURL(blob); this.entries.set(key, url);
      while (this.entries.size > 400) { const oldest = this.entries.keys().next().value!; URL.revokeObjectURL(this.entries.get(oldest)!); this.entries.delete(oldest); }
      return url;
    } finally { this.active--; this.queue.shift()?.(); }
  }
  dispose(): void { this.disposed = true; for (const url of this.entries.values()) URL.revokeObjectURL(url); this.entries.clear(); }
}

export function resizeDimensions(width: number, height: number, mode: string, maxWidth: number, maxHeight: number, percent: number, upscale: boolean): { width: number; height: number } {
  let scale = mode === 'inside' ? Math.min(maxWidth / width, maxHeight / height) : mode === 'percent' ? percent / 100 : 1;
  if (!upscale) scale = Math.min(1, scale);
  if (!(scale > 0 && Number.isFinite(scale))) throw new Error('Invalid resize dimensions.');
  const result = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  if (result.width * result.height > 60_000_000 || Math.max(result.width, result.height) > 30000) throw new Error('Export exceeds the 60 megapixel / 30,000 pixel limit.');
  return result;
}
