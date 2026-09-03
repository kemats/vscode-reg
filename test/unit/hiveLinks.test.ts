import { describe, expect, it } from 'vitest';
import { createHiveLocationUri, parseHiveLocationUri } from '../../src/hiveLinks';

describe('hive location links', () => {
  it('round trips a key and named value', () => {
    const uri = createHiveLocationUri('vscode', 'KeiichiMatsui.vscode-reg', {
      path: 'C:\\temp\\SOFTWARE.hiv',
      key: 'Microsoft\\Windows NT\\CurrentVersion',
      value: 'ProductName',
    });
    const parsed = new URL(uri);

    expect(parseHiveLocationUri(parsed.pathname, parsed.search)).toEqual({
      path: 'C:\\temp\\SOFTWARE.hiv',
      key: 'Microsoft\\Windows NT\\CurrentVersion',
      value: 'ProductName',
    });
  });

  it('distinguishes a default value from a key link', () => {
    const valueUri = new URL(createHiveLocationUri('vscode', 'KeiichiMatsui.vscode-reg', {
      path: 'C:\\temp\\NTUSER.DAT', key: '', value: '',
    }));
    const keyUri = new URL(createHiveLocationUri('vscode', 'KeiichiMatsui.vscode-reg', {
      path: 'C:\\temp\\NTUSER.DAT', key: '',
    }));

    expect(parseHiveLocationUri(valueUri.pathname, valueUri.search)?.value).toBe('');
    expect(parseHiveLocationUri(keyUri.pathname, keyUri.search)?.value).toBeUndefined();
  });

  it('rejects unrelated or incomplete links', () => {
    expect(parseHiveLocationUri('/other', '?path=C%3A%5Ctemp%5CSOFTWARE.hiv')).toBeUndefined();
    expect(parseHiveLocationUri('/open', '?key=Software')).toBeUndefined();
  });
});