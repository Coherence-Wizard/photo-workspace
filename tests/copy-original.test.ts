import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyOriginalFiles } from '../src/copy-original';

test('unchanged originals and existing sidecars are copied exactly without overwriting collisions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'coherence-copy-'));
  try {
    const source = join(dir, 'raw.nef'), sidecar = source + '.xmp', out = join(dir, 'out');
    await mkdir(out); await writeFile(source, Buffer.from([0, 1, 2, 255])); await writeFile(sidecar, 'portable tags');
    await writeFile(join(out, 'raw-export.nef.xmp'), 'existing sidecar');
    const result = await copyOriginalFiles(source, [source, sidecar], out);
    assert.equal(result, join(out, 'raw-export-2.nef'));
    assert.deepEqual(await readFile(result), await readFile(source));
    assert.equal(await readFile(result + '.xmp', 'utf8'), 'portable tags');
    assert.equal(await readFile(join(out, 'raw-export.nef.xmp'), 'utf8'), 'existing sidecar');
    assert.equal((await readdir(out)).includes('raw-export.nef'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
