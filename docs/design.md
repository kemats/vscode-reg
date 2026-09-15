# Design

This document describes the extension's search index, native helper, registry semantics, and build internals.

## Search index

The first search traverses the hive once and writes a compact SQLite record cache beside the hive file:

```text
<hive path>.cache.sqlite
```

For example, the cache for `C:\temp\software.hiv` is `C:\temp\software.hiv.cache.sqlite`. Subsequent searches reuse that cache across helper and VS Code restarts. The cache is invalidated when the hive's size or modification time changes.

If the hive's folder is not writable, the extension shows the fallback location and asks for confirmation before creating the cache under VS Code's extension global storage. On a standard Windows installation of VS Code, that fallback is:

```text
%APPDATA%\Code\User\globalStorage\KeiichiMatsui.vscode-reg\search-indexes\<hash>.sqlite
```

`<hash>` is the SHA-256 hash of the lowercased absolute hive path. The VS Code user-data prefix can differ for editions such as VS Code Insiders. To remove cached data, close the hive editor so its helper exits, then delete the adjacent `.cache.sqlite` file or the relevant fallback `.sqlite` file. The next search recreates it.

Value previews are bounded to avoid processing unbounded data: text is limited to 4,096 UTF-16 characters and binary data to 128 bytes. A search returns at most 500 matches.

The cache uses Windows' inbox `winsqlite3.dll`; no additional SQLite runtime is packaged. On a measured 76.7 MiB SOFTWARE hive containing 716,286 searchable records, the first cache build and search took 17.3 seconds, repeated searches took about 0.2 seconds, and the cache occupied 102.7 MiB. Closing the custom editor terminates the helper, while the disk cache remains reusable.

## SQL-like queries

Supported fields are `kind`, `key`/`path`/`key_path`, `name`/`value_name`, `type`/`value_type`, `type_code`, `size`/`value_size`, `data`, and `last_write`/`lastWrite`. Last-write timestamps use ISO 8601 UTC text, so they can be compared lexically. `data` contains display text; for example, DWORD 1 is indexed as `1 (0x00000001)`.

Supported predicates include comparisons, `AND`, `OR`, `NOT`, `IN`, `LIKE`, `GLOB`, `IS NULL`, parentheses, and `ESCAPE`. Input is parsed against an allowlist; SQL statements, subqueries, functions, comments, and semicolons are rejected.

| Field | Aliases | Stored value | Example |
| --- | --- | --- | --- |
| `kind` | None | Record kind: `key` or `value` | `kind = 'value'` |
| `key_path` | `key`, `path` | Hive-relative key path; the hive root is an empty string | `path LIKE 'Microsoft\Windows\CurrentVersion%'` |
| `value_name` | `name` | Value name; the default value is an empty string. `NULL` for key records | `name = 'Enabled'` |
| `value_type` | `type` | Registry type name. `NULL` for key records | `type IN ('REG_DWORD', 'REG_QWORD')` |
| `type_code` | None | Numeric Windows registry type code. `NULL` for key records | `type_code = 4` |
| `value_size` | `size` | Original value-data size in bytes. `NULL` for key records | `size > 1024` |
| `data` | None | Bounded display text for the value. `NULL` for key records | `data LIKE '%Visual C++%'` |
| `last_write` | `lastWrite` | Owning key's ISO 8601 UTC last-write time | `last_write >= '2026-01-01T00:00:00Z'` |

## Native helper

The helper runs at below-normal priority and in a Job Object whose process-memory limit is 20% of available physical memory at launch, clamped to 256 MiB-2 GiB. If `offreg.dll` cannot open a very large hive within that budget, the helper fails instead of allowing system-wide memory pressure. Only one hive helper is retained at a time.

Direct subkeys are loaded in pages of 250. Large keys such as `Classes` therefore do not create thousands of Webview DOM nodes at once; additional pages are loaded only through **Load more...** or while navigating to a search result.

Hive parsing is implemented with Microsoft's Offline Registry Library (`offreg.dll`). The packaged DLL comes from the WDK Redistributable directory, not from the local `System32` directory.

## Registry semantics

Offline Registry exposes a key's last-write timestamp, which is shown as selected-key metadata and in the **Last write (key)** column for direct subkeys. Registry values have no individual last-write timestamp, so the column is hidden in the values-only view. Offline Registry also does not expose key creation time.

Export maps standard hive names to their conventional roots (`SOFTWARE` to `HKEY_LOCAL_MACHINE\SOFTWARE`, `NTUSER.DAT` to `HKEY_CURRENT_USER`, and so on); unknown `.hiv`/`.hive` names default to `HKEY_LOCAL_MACHINE`.

Registry location links are semantic deep links implemented by the custom editor. Unlike text-file links, they identify a hive-relative key and optional value rather than a line and column. Other custom editors can provide comparable navigation, but each editor's extension must define and handle its own location URI.

## Native build

The native project is available directly as `native/vscode-reg-native/vscode-reg-native.vcxproj`. It statically links the Visual C++ runtime and locates the newest installed WDK `offreg.h`, x64 `offreg.lib`, and redistributable x64 `offreg.dll`.

CI uses the GitHub Actions `windows-2025-vs2026` image and installs the WDK before building.