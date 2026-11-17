export const COLORS = ['None', 'Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Magenta', 'Gray', 'Black', 'White'];
export const PICKS = ['None', 'Rejected', 'Pending', 'Accepted'];
export interface Photo {
  id: number; name: string; albumId: number; rootId: number; relativePath: string;
  fileSize: number; rating: number; color: number; pick: number; date: string | null;
  width: number; height: number; format: string; camera: string; lens: string;
  hasGps: boolean; title: string; caption: string; tags: string[]; pending: boolean; path: string | null;
}
export interface Root { id: number; label: string; path: string; online: boolean; suggestions: string[]; }
export interface ScanReport { found: number; read: number; unchanged: number; failed: number; errors: string[]; }
export interface CatalogInfo {
  tagCounts: Record<string, number>; folderCounts: Record<string, number>; scanReport?: ScanReport;
  key: string; version: string; count: number; tags: string[]; roots: Root[];
  albums: { id: number; rootId: number; path: string }[]; pendingCount: number;
}
export interface Filters {
  search?: string; tag?: string; descendants?: boolean; rootId?: string; albumId?: string;
  rating?: string; ratingAtLeast?: boolean; color?: string; pick?: string;
  dateFrom?: string; dateTo?: string; camera?: string; lens?: string; format?: string;
  orientation?: string; hasGps?: string; untagged?: boolean; sort?: string; ascending?: boolean;
  folderPath?: string; folderAbsolute?: string; folderRecursive?: boolean; groupFolders?: boolean;
  limit?: number; offset?: number;
}
export interface Recipe {
  exposure: number; contrast: number; highlights: number; shadows: number;
  temperature: number; tint: number; saturation: number; vibrance: number;
  black: number; white: number; gamma: number; angle: number;
  crop: { x: number; y: number; width: number; height: number };
  cropRatio: string; auto: number;
}
export const DEFAULT_RECIPE: Recipe = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  temperature: 0, tint: 0, saturation: 0, vibrance: 0,
  black: 0, white: 255, gamma: 1, angle: 0,
  crop: { x: 0, y: 0, width: 1, height: 1 }, cropRatio: 'free', auto: 0,
};
export interface Settings {
  sourceMode: 'digikam' | 'folder'; photoFolder: string;
  databasePath: string; pythonPath: string; exiftoolPath: string;
  rootMappings: Record<string, string>; writesEnabled: boolean;
  writeMode: 'sidecar' | 'embedded'; sidecarNaming: 'full' | 'stem';
  includeSubfolders: boolean;
  thumbnailSize: number; savedFilters: { name: string; filters: Filters }[];
  luckyUndo?: Record<string, Recipe | null>;
  recipes: Record<string, Recipe>; exportFolder: string; customTags: Record<string, string[]>;
}
export const DEFAULT_SETTINGS: Settings = {
  sourceMode: 'digikam', photoFolder: '',
  databasePath: '', pythonPath: '', exiftoolPath: '', rootMappings: {}, writesEnabled: false,
  includeSubfolders: true, writeMode: 'embedded', sidecarNaming: 'full', thumbnailSize: 180,
  savedFilters: [], recipes: {}, exportFolder: 'Photo exports', customTags: {},
};
export type MetadataPatch = Partial<Pick<Photo, 'rating' | 'color' | 'pick' | 'title' | 'caption'>> & { addTags?: string[]; removeTags?: string[] };
export interface WriteResult { successes: { id: number; metadata: MetadataPatch & { tags: string[] }; operation: string }[]; errors: { id: number; error: string }[]; }
export const freshRecipe = (): Recipe => structuredClone(DEFAULT_RECIPE);

export function toggleSelection<T>(selection: Set<T>, ids: T[], id: T, anchor: T | null, range: boolean, additive: boolean): Set<T> {
  if (range && anchor !== null && ids.includes(anchor)) {
    const a = ids.indexOf(anchor), b = ids.indexOf(id);
    return new Set([...(additive ? selection : []), ...ids.slice(Math.min(a, b), Math.max(a, b) + 1)]);
  }
  if (additive) { const next = new Set(selection); if (next.has(id)) next.delete(id); else next.add(id); return next; }
  return new Set([id]);
}

export function parsePhotoTags(value: string): string[] {
  const tags = value.split(',').map(tag => tag.trim()).filter(Boolean);
  if (tags.some(tag => tag.includes('|') || /[\r\n]/.test(tag) || tag.split('/').some(part => !part.trim()))) throw new Error('Use nonempty tag names separated by commas, and / between hierarchy levels.');
  return [...new Set(tags.map(tag => tag.split('/').map(part => part.trim()).join('/')))];
}

export interface TagChange { from: string; to: string | null; descendants: boolean; fromTags?: string[]; }
