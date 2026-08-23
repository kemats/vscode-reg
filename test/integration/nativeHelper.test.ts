import { ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

interface HelperResponse {
  id?: number;
  ready?: boolean;
  result?: unknown;
  error?: string;
}

class HelperHarness {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly rawPending: Array<{ resolve: (response: HelperResponse) => void; reject: (error: Error) => void }> = [];
  private readonly ready: Promise<HelperResponse>;
  private nextId = 1;
  private stderr = '';

  constructor(executable: string, hivePath: string, cachePath: string, signature: string) {
    let resolveReady!: (response: HelperResponse) => void;
    let rejectReady!: (error: Error) => void;
    this.ready = new Promise<HelperResponse>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.process = spawn(executable, [hivePath, cachePath, signature], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', chunk => { this.stderr += String(chunk); });
    this.process.once('error', rejectReady);
    this.process.once('exit', code => {
      const error = new Error(this.stderr.trim() || `Native helper exited with code ${code}.`);
      rejectReady(error);
      for (const request of this.pending.values()) { request.reject(error); }
      this.pending.clear();
      for (const request of this.rawPending.splice(0)) { request.reject(error); }
    });
    createInterface({ input: this.process.stdout }).on('line', line => {
      const response = JSON.parse(line) as HelperResponse;
      if (response.ready) {
        resolveReady(response);
        return;
      }
      const request = response.id === undefined ? undefined : this.pending.get(response.id);
      if (request) {
        this.pending.delete(response.id!);
        if (response.error) { request.reject(new Error(response.error)); }
        else { request.resolve(response.result); }
        return;
      }
      this.rawPending.shift()?.resolve(response);
    });
  }

  waitUntilReady(): Promise<HelperResponse> {
    return this.ready;
  }

  async send<T>(command: Record<string, unknown>): Promise<T> {
    await this.ready;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.process.stdin.write(`${JSON.stringify({ id, ...command })}\n`, error => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async sendRaw(line: string): Promise<HelperResponse> {
    await this.ready;
    return new Promise<HelperResponse>((resolve, reject) => {
      this.rawPending.push({ resolve, reject });
      this.process.stdin.write(`${line}\n`, error => {
        if (!error) { return; }
        const index = this.rawPending.findIndex(request => request.resolve === resolve);
        if (index >= 0) { this.rawPending.splice(index, 1); }
        reject(error);
      });
    });
  }

  async dispose(): Promise<void> {
    if (this.process.exitCode !== null) { return; }
    try { await this.send({ command: 'close' }); }
    finally { this.process.kill(); }
  }
}

const root = process.cwd();
const executable = path.join(root, 'native', 'bin', 'win32-x64', 'vscode-reg-native.exe');
const offregDirectory = path.dirname(executable);
const fixtureScript = path.join(root, 'test', 'fixtures', 'createTestHive.ps1');
const shouldRun = process.platform === 'win32';

describe.skipIf(!shouldRun)('native helper integration', () => {
  let temporaryDirectory: string;
  let hivePath: string;
  let cachePath: string;
  let helper: HelperHarness | undefined;

  beforeAll(() => {
    if (!existsSync(executable)) {
      throw new Error(`Native helper was not found at ${executable}. Run npm run build:native first.`);
    }
    temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'vscode-reg-test-'));
    hivePath = path.join(temporaryDirectory, 'sample.hiv');
    cachePath = path.join(temporaryDirectory, 'sample.cache.sqlite');
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', fixtureScript,
      '-OutputPath', hivePath,
      '-OffregDirectory', offregDirectory,
    ], { stdio: 'inherit' });
  });

  afterEach(async () => {
    await helper?.dispose();
    helper = undefined;
  });

  afterAll(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  function start(): HelperHarness {
    helper = new HelperHarness(executable, hivePath, cachePath, 'integration-test-v1');
    return helper;
  }

  function removeCache(): void {
    for (const suffix of ['', '-shm', '-wal']) { rmSync(`${cachePath}${suffix}`, { force: true }); }
  }

  it('emits a JSON ready handshake', async () => {
    const ready = await start().waitUntilReady();

    expect(ready.ready).toBe(true);
    expect(ready).toHaveProperty('memoryLimitBytes');
  });

  it('lists keys and values from an offline hive', async () => {
    const listing = await start().send<{
      path: string;
      subkeys: Array<{ name: string }>;
      values: Array<{ name: string; type: string; data: string }>;
    }>({ command: 'list', path: '' });

    expect(listing.path).toBe('');
    expect(listing.subkeys.map(key => key.name)).toContain('Child');
    expect(listing.values).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Text', type: 'REG_SZ', data: 'NeedleValue' }),
      expect.objectContaining({ name: 'Count', type: 'REG_DWORD', data: '42 (0x0000002a)' }),
    ]));
  });

  it('builds and reuses the search cache', async () => {
    removeCache();
    const first = await start().send<{ indexBuilt: boolean; results: Array<{ value?: { name: string } }> }>({
      command: 'search', query: 'NeedleValue', limit: 100,
    });
    expect(first.indexBuilt).toBe(true);
    expect(first.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: expect.objectContaining({ name: 'Text' }) }),
    ]));

    await helper?.dispose();
    helper = new HelperHarness(executable, hivePath, cachePath, 'integration-test-v1');
    const second = await helper.send<{ indexBuilt: boolean }>({ command: 'search', query: 'NeedleValue', limit: 100 });
    expect(second.indexBuilt).toBe(false);
  });

  it('rebuilds the cache when the hive signature changes', async () => {
    removeCache();
    const first = await start().send<{ indexBuilt: boolean }>({ command: 'search', query: 'NeedleValue', limit: 100 });
    expect(first.indexBuilt).toBe(true);

    await helper?.dispose();
    helper = new HelperHarness(executable, hivePath, cachePath, 'integration-test-v2');
    const second = await helper.send<{ indexBuilt: boolean }>({ command: 'search', query: 'NeedleValue', limit: 100 });
    expect(second.indexBuilt).toBe(true);
  });

  it('allows restricted queries and rejects SQL statements', async () => {
    const harness = start();
    const response = await harness.send<{ results: Array<{ value?: { name: string } }> }>({
      command: 'query', where: "name = 'Count' AND data LIKE '42 (%'", limit: 100,
    });
    expect(response.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: expect.objectContaining({ name: 'Count' }) }),
    ]));

    await expect(harness.send({ command: 'query', where: "kind = 'value'; DROP TABLE records", limit: 100 }))
      .rejects.toThrow('Unsupported character');
  });

  it('correlates concurrent JSON requests by id', async () => {
    const harness = start();
    const [listing, search] = await Promise.all([
      harness.send<{ path: string }>({ command: 'list', path: 'Child' }),
      harness.send<{ query: string; results: unknown[] }>({ command: 'search', query: 'NeedleValue', limit: 10 }),
    ]);

    expect(listing.path).toBe('Child');
    expect(search.query).toBe('NeedleValue');
    expect(search.results.length).toBeGreaterThan(0);
  });

  it('returns JSON errors for malformed and incomplete requests', async () => {
    const harness = start();
    const malformed = await harness.sendRaw('{');

    expect(malformed.id).toBeUndefined();
    expect(malformed.error).toMatch(/parse error/i);
    await expect(harness.send({ command: 'search' })).rejects.toThrow(/query/i);
    await expect(harness.send({ command: 'not-a-command' })).rejects.toThrow('Unknown command');
  });

  it('acknowledges the close command', async () => {
    const response = await start().send<{ closed: boolean }>({ command: 'close' });
    helper = undefined;

    expect(response.closed).toBe(true);
  });

  it('returns complete binary value data', async () => {
    const value = await start().send<{ type: string; size: number; bytes: number[] }>({
      command: 'valueData', path: '', name: 'Blob',
    });

    expect(value.type).toBe('REG_BINARY');
    expect(value.size).toBe(5);
    expect(value.bytes).toEqual([0, 1, 127, 128, 255]);
  });
});