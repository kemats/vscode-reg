import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCacheName, createHiveSignature, normalizeResultLimit } from '../../src/hiveMetadata';

describe('createHiveSignature', () => {
  it('includes the cache format, file size, and modification time', () => {
    expect(createHiveSignature(4096, 1234.5)).toBe('compact-v1:4096:1234.5');
  });
});

describe('createCacheName', () => {
  it('uses a lowercase absolute path for a stable SHA-256 name', () => {
    const hivePath = 'C:\\Users\\Example\\NTUSER.DAT';
    const expected = createHash('sha256').update(hivePath.toLowerCase()).digest('hex');

    expect(createCacheName(hivePath)).toBe(expected);
    expect(createCacheName(hivePath.toLowerCase())).toBe(expected);
  });
});

describe('normalizeResultLimit', () => {
  it.each([
    [undefined, 100],
    [-1, 1],
    [1, 1],
    [250, 250],
    [500, 500],
    [501, 500],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeResultLimit(input)).toBe(expected);
  });
});