import { createHash } from 'node:crypto';

export function createHiveSignature(size: number, modifiedTimeMs: number): string {
  return `compact-v1:${size}:${modifiedTimeMs}`;
}

export function createCacheName(hivePath: string): string {
  return createHash('sha256').update(hivePath.toLowerCase()).digest('hex');
}

export function normalizeResultLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 100, 1), 500);
}