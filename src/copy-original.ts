import { copyFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, extname, join } from 'node:path';

/** Preserve existing sidecars too; never create or infer new sidecar metadata. */
export async function copyOriginalFiles(source: string, related: string[], root: string): Promise<string> {
  const extension = extname(source), stem = basename(source, extension).replace(/[\\/:*?"<>|]/g, '-');
  for (let suffix = 1; ; suffix++) {
    const target = join(root, `${stem}-export${suffix === 1 ? '' : '-' + suffix}${extension}`);
    const pairs = related.map(path => [path, path === source ? target : path === source + '.xmp' ? target + '.xmp' : target.slice(0, -extension.length) + '.xmp']);
    const created: string[] = [];
    try {
      for (const [from, to] of pairs) { await copyFile(from, to, constants.COPYFILE_EXCL); created.push(to); }
      return target;
    } catch (error) {
      for (const path of created) await unlink(path);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
