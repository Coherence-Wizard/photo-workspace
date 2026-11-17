import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import bridgeSource from './bridge.py';
import type { Settings } from './types';

export class Bridge {
  private children = new Set<ChildProcessWithoutNullStreams>();
  private python = '';
  private helper: Promise<string> | null = null;
  constructor(private settings: () => Settings, readonly dataDir: string) {}

  async run<T>(action: string, payload: Record<string, unknown> = {}, progress?: (value: { processed: number; total: number; errors: number }) => void): Promise<T> {
    const configured = this.settings().pythonPath;
    const helper = await (this.helper ??= this.prepareHelper());
    const candidates = configured ? [configured] : this.python ? [this.python] : process.platform === 'win32'
      ? ['python', 'python3'] : ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3'];
    let last: Error = new Error('Python 3 was not found. Install Python 3.10 or newer and set its path in Coherence Photo settings.');
    for (const command of candidates) {
      if (command.startsWith('/') && !existsSync(command)) continue;
      try {
        const result = await this.execute<T>(command, helper, { action, settings: this.settings(), dataDir: this.dataDir, ...payload }, progress);
        this.python = command;
        return result;
      } catch (error) {
        last = error as Error;
        if ((last as NodeJS.ErrnoException).code !== 'ENOENT') throw last;
      }
    }
    throw new Error(`Python 3 could not be started. Choose Python 3.10 or newer in settings. ${last.message}`);
  }

  private async prepareHelper(): Promise<string> {
    const directory = join(this.dataDir, 'runtime');
    await mkdir(directory, { recursive: true });
    const hash = createHash('sha256').update(bridgeSource).digest('hex').slice(0, 16);
    const target = join(directory, `bridge-${hash}.py`);
    const temporary = join(directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, bridgeSource, { mode: 0o600 });
    await rename(temporary, target);
    return target;
  }
  private execute<T>(command: string, helper: string, request: Record<string, unknown>, progress?: (value: { processed: number; total: number; errors: number }) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [helper], { stdio: 'pipe', windowsHide: true });
      this.children.add(child);
      let out = '', err = '', settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.children.delete(child);
        if (error) reject(error); else resolve(value as T);
      };
      const timer = setTimeout(() => { child.kill(); finish(new Error('The local photo operation timed out. Refresh to recover any completed writes.')); }, request.action === 'scan' ? 7_200_000 : request.action === 'write' ? 600_000 : 120_000);
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        if (out.length > 100 * 1024 * 1024) { child.kill(); finish(new Error('Local response exceeded its size limit.')); }
      });
      let progressBuffer = '';
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8'); err = (err + text).slice(-8000); progressBuffer += text;
        const lines = progressBuffer.split('\n'); progressBuffer = lines.pop() ?? '';
        for (const line of lines) if (line.startsWith('PW_PROGRESS ')) { try { progress?.(JSON.parse(line.slice(12))); } catch { /* Non-progress diagnostics remain available in err. */ } }
      });
      child.on('error', finish);
      child.on('close', code => {
        if (code !== 0) return finish(new Error(err || 'The local helper stopped unexpectedly.'));
        try {
          const response = JSON.parse(out);
          if (!response.ok) finish(new Error(response.error));
          else finish(undefined, response.result as T);
        } catch { finish(new Error(err || 'The local helper returned an invalid response.')); }
      });
      child.stdin.on('error', error => finish(error));
      child.stdin.end(JSON.stringify(request));
    });
  }

  stop(): void { for (const child of this.children) child.kill(); this.children.clear(); }
}
