import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createCacheName, createHiveSignature } from './hiveMetadata';
import { HiveValueData, KeyListing, SearchResponse } from './types';

interface NativeResponse<T> {
  id?: number;
  result?: T;
  error?: string;
  ready?: boolean;
}

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

export class HiveClient implements vscode.Disposable {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest<unknown>>();
  private nextId = 1;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private disposed = false;

  constructor(executable: string, readonly hivePath: string, cachePath: string, signature: string, private readonly output: vscode.LogOutputChannel) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.process = spawn(executable, [hivePath, cachePath, signature], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.output.info(`Starting native helper for ${hivePath}`);

    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', line => this.handleLine(line));
    let stderr = '';
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', chunk => {
      const text = String(chunk);
      stderr += text;
      for (const line of text.trimEnd().split(/\r?\n/)) { if (line) { this.output.warn(`[native] ${line}`); } }
    });
    this.process.once('error', error => this.fail(error));
    this.process.once('exit', code => {
      if (!this.disposed) {
        this.fail(new Error(stderr.trim() || `Registry hive helper exited with code ${code}.`));
      }
    });
  }

  list(keyPath: string, offset = 0, limit = 250): Promise<KeyListing> {
    return this.request<KeyListing>({ command: 'list', path: keyPath, offset, limit });
  }

  search(query: string, limit: number, scope = ''): Promise<SearchResponse> {
    return this.request<SearchResponse>({ command: 'search', query, limit, scope });
  }

  query(where: string, limit: number, scope = ''): Promise<SearchResponse> {
    return this.request<SearchResponse>({ command: 'query', where, limit, scope });
  }

  valueData(keyPath: string, name: string): Promise<HiveValueData> {
    return this.request<HiveValueData>({ command: 'valueData', path: keyPath, name });
  }

  exportReg(keyPath: string, destination: string, rootName: string): Promise<{ path: string; destination: string }> {
    return this.request({ command: 'exportReg', path: keyPath, destination, rootName });
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.process.kill();
    this.rejectAll(new Error('Registry hive session closed.'));
  }

  private async request<T>(payload: Record<string, unknown>): Promise<T> {
    await this.ready;
    if (this.disposed) { throw new Error('Registry hive session is closed.'); }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.process.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, error => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private handleLine(line: string): void {
    try {
      const message = JSON.parse(line) as NativeResponse<unknown>;
      if (message.ready) {
        this.output.info(`Native helper ready for ${this.hivePath}`);
        this.resolveReady();
        return;
      }
      if (message.id === undefined) { return; }
      const pending = this.pending.get(message.id);
      if (!pending) { return; }
      this.pending.delete(message.id);
      if (message.error) { pending.reject(new Error(message.error)); }
      else { pending.resolve(message.result); }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    this.output.error(`Native helper failed for ${this.hivePath}: ${error.message}`);
    this.rejectReady(error);
    this.rejectAll(error);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) { pending.reject(error); }
    this.pending.clear();
  }
}

interface PoolEntry {
  client: HiveClient;
  signature: string;
  touched: number;
}

export class HiveSessionPool implements vscode.Disposable {
  private readonly sessions = new Map<string, PoolEntry>();

  constructor(private readonly context: vscode.ExtensionContext, private readonly capacity = 3, private readonly output: vscode.LogOutputChannel) {}

  async get(hivePath: string): Promise<HiveClient> {
    if (process.platform !== 'win32') { throw new Error('Registry hive viewing is supported on Windows only.'); }
    const absolute = path.resolve(hivePath);
    const file = await stat(absolute);
    const signature = createHiveSignature(file.size, file.mtimeMs);
    const existing = this.sessions.get(absolute);
    if (existing?.signature === signature) {
      existing.touched = Date.now();
      return existing.client;
    }
    if (existing) {
      existing.client.dispose();
      this.sessions.delete(absolute);
    }

    const executable = this.context.asAbsolutePath(path.join('native', 'bin', 'win32-x64', 'vscode-reg-native.exe'));
  const cachePath = await this.resolveCachePath(absolute);
  const client = new HiveClient(executable, absolute, cachePath, signature, this.output);
    this.sessions.set(absolute, { client, signature, touched: Date.now() });
    this.evict();
    return client;
  }

  invalidate(hivePath: string): void {
    const absolute = path.resolve(hivePath);
    this.sessions.get(absolute)?.client.dispose();
    this.sessions.delete(absolute);
  }

  dispose(): void {
    for (const entry of this.sessions.values()) { entry.client.dispose(); }
    this.sessions.clear();
  }

  private async resolveCachePath(hivePath: string): Promise<string> {
    const adjacentCache = `${hivePath}.cache.sqlite`;
    if (await this.canWriteCache(adjacentCache)) {
      return adjacentCache;
    }

    const cacheDirectory = path.join(this.context.globalStorageUri.fsPath, 'search-indexes');
    const cacheName = createCacheName(hivePath);
    const fallbackCache = path.join(cacheDirectory, `${cacheName}.sqlite`);
    const choice = await vscode.window.showWarningMessage(
      'The registry hive folder or its existing cache file is not writable. Create the search cache in VS Code storage instead?',
      { modal: true, detail: `Cache location: ${fallbackCache}` },
      'Create Cache',
    );
    if (choice !== 'Create Cache') { throw new vscode.CancellationError(); }
    await mkdir(cacheDirectory, { recursive: true });
    return fallbackCache;
  }

  private async canWriteCache(cachePath: string): Promise<boolean> {
    try {
      await access(cachePath, constants.R_OK | constants.W_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { return false; }
    }
    try {
      await access(path.dirname(cachePath), constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private evict(): void {
    if (this.sessions.size <= this.capacity) { return; }
    const oldest = [...this.sessions.entries()].sort((left, right) => left[1].touched - right[1].touched)[0];
    oldest[1].client.dispose();
    this.sessions.delete(oldest[0]);
  }
}
