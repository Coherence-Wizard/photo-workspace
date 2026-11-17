import type { Recipe } from './types';
export type Crop = Recipe['crop'];
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
export function moveCrop(crop: Crop, dx: number, dy: number): Crop {
  return { ...crop, x: clamp(crop.x + dx, 0, 1 - crop.width), y: clamp(crop.y + dy, 0, 1 - crop.height) };
}
// Ratio is width/height in normalized coordinates, accounting for image aspect ratio.
export function fitCropRatio(crop: Crop, ratio: number): Crop {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return { ...crop };
  const width = Math.min(crop.width, crop.height * ratio), height = width / ratio;
  return { x: crop.x + (crop.width - width) / 2, y: crop.y + (crop.height - height) / 2, width, height };
}
export function resizeCrop(crop: Crop, handle: Handle, dx: number, dy: number, ratio = 0): Crop {
  const sx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const sy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const ax = crop.x + (sx < 0 ? crop.width : sx > 0 ? 0 : crop.width / 2);
  const ay = crop.y + (sy < 0 ? crop.height : sy > 0 ? 0 : crop.height / 2);
  const maxW = sx < 0 ? ax : sx > 0 ? 1 - ax : 2 * Math.min(ax, 1 - ax);
  const maxH = sy < 0 ? ay : sy > 0 ? 1 - ay : 2 * Math.min(ay, 1 - ay);
  let width = Math.max(.005, crop.width + sx * dx), height = Math.max(.005, crop.height + sy * dy);
  if (ratio > 0 && Number.isFinite(ratio)) {
    if (!sx || (sy && Math.abs(dy) * ratio > Math.abs(dx))) width = height * ratio;
    height = width / ratio;
    const scale = Math.min(1, maxW / width, maxH / height); width *= scale; height *= scale;
  } else { width = Math.min(width, maxW); height = Math.min(height, maxH); }
  return { x: sx < 0 ? ax - width : sx > 0 ? ax : ax - width / 2, y: sy < 0 ? ay - height : sy > 0 ? ay : ay - height / 2, width, height };
}
export function drawCrop(start: { x: number; y: number }, end: { x: number; y: number }, ratio = 0): Crop {
  const handle: Handle = `${end.y < start.y ? 'n' : 's'}${end.x < start.x ? 'w' : 'e'}` as Handle;
  return resizeCrop({ x: start.x, y: start.y, width: 0, height: 0 }, handle, end.x - start.x, end.y - start.y, ratio);
}
