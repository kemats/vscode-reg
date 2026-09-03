# Registry Hive Viewer

VS Code extension for read-only viewing of offline Windows registry hive files.

## Features

- Syntax highlighting for Registry Editor `.reg` files.
- Read-only, Regedit-style viewing of offline registry hive files.
- Expandable and collapsible paged tree with leaf/loading states and keyboard navigation.
- Explorer-style back, forward, up, Enter-to-navigate paths, history, and extension-wide favorite keys with rename/delete actions.
- Switchable value-only or value-and-direct-subkey list with keyboard row selection.
- Search across key paths, value names, and previewed value data in a resizable third pane opened with **Ctrl+F**.
- Restricted SQL-like queries selected beside Search.
- Recursive `.reg` export of the selected key from its tree context menu.
- Full binary-value inspection as hex, ASCII, UTF-16LE, the Windows active code page, GUID, integer, and valid FILETIME interpretations.
- Language model tools for listing keys, literal search, and restricted queries.
- No hive mounting, administrator privileges, or registry mutation.

Use **Registry: Open Hive File** to open hives with conventional names such as `SYSTEM`, `SOFTWARE`, `NTUSER.DAT`, `.hiv`, and `.hive` files.

## What is a hive file?

A registry hive is a binary file that stores part of the Windows registry. If you do not already have a hive file, one common example is a snapshot exported with [`reg save`](https://learn.microsoft.com/windows-server/administration/windows-commands/reg-save). Run the following from an elevated Command Prompt or PowerShell window:

```powershell
reg save HKLM\SOFTWARE C:\temp\software.hiv
```

The resulting `software.hiv` can be opened directly by this extension without loading it into the live registry.

Visual Studio also stores per-instance settings in a private registry hive:

```text
%LOCALAPPDATA%\Microsoft\VisualStudio\<config>\privateregistry.bin
```

Here, `<config>` identifies a particular Visual Studio instance. See [Tools for detecting and managing Visual Studio instances](https://learn.microsoft.com/visualstudio/install/tools-for-managing-visual-studio-instances?view=visualstudio#edit-the-registry-for-a-visual-studio-instance) for details. Close that Visual Studio instance first if the file is locked.

## Search behavior

The first search traverses the hive once and writes a compact SQLite record cache beside the hive file:

```text
<hive path>.cache.sqlite
```

For example, the cache for `C:\temp\software.hiv` is `C:\temp\software.hiv.cache.sqlite`. Subsequent searches reuse that cache across helper and VS Code restarts. The cache is invalidated when the hive's size or modification time changes. Search remains case-insensitive substring matching and returns at most 500 matches.

If the hive's folder is not writable, the extension shows the fallback location and asks for confirmation before creating the cache under VS Code's extension global storage. On a standard Windows installation of VS Code, that fallback is:

```text
%APPDATA%\Code\User\globalStorage\KeiichiMatsui.vscode-reg\search-indexes\<hash>.sqlite
```

`<hash>` is the SHA-256 hash of the lowercased absolute hive path. The VS Code user-data prefix can differ for editions such as VS Code Insiders. To remove cached data, close the hive editor so its helper exits, then delete the adjacent `.cache.sqlite` file or the relevant fallback `.sqlite` file. The next search recreates it.

Value previews are bounded to avoid processing unbounded data: text is limited to 4,096 UTF-16 characters and binary data to 128 bytes. A search returns at most 500 matches.

The helper runs at below-normal priority and in a Job Object whose process-memory limit is 20% of available physical memory at launch, clamped to 256 MiB–2 GiB. If `offreg.dll` cannot open a very large hive within that budget, the helper fails instead of allowing system-wide memory pressure. Only one hive helper is retained at a time.

The cache uses Windows' inbox `winsqlite3.dll`; no additional SQLite runtime is packaged. On a measured 76.7 MiB SOFTWARE hive containing 716,286 searchable records, the first cache build and search took 17.3 seconds, repeated searches took about 0.2 seconds, and the cache occupied 102.7 MiB. Closing the custom editor terminates the helper, while the disk cache remains reusable.

Direct subkeys are loaded in pages of 250. Large keys such as `Classes` therefore do not create thousands of Webview DOM nodes at once; additional pages are loaded only through **Load more…** or while navigating to a search result.

Select **SQL-like** from the Search mode control to query the compact cache with expressions such as:

```sql
kind = 'key' AND last_write >= '2026-01-01T00:00:00Z'
data LIKE '%Visual C++%'
path LIKE 'Microsoft\Windows\CurrentVersion\WINEVT%' AND name = 'Enabled' AND data LIKE '1 (%'
```

Hover over the SQL-like search text box to see these examples. Supported fields are `kind`, `key`/`path`/`key_path`, `name`/`value_name`, `type`/`value_type`, `type_code`, `size`/`value_size`, `data`, and `last_write`/`lastWrite`. Last-write timestamps use ISO 8601 UTC text, so they can be compared lexically. `data` contains display text; for example, DWORD 1 is indexed as `1 (0x00000001)`. Supported predicates include comparisons, `AND`, `OR`, `NOT`, `IN`, `LIKE`, `GLOB`, `IS NULL`, parentheses, and `ESCAPE`. Input is parsed against an allowlist; SQL statements, subqueries, functions, comments, and semicolons are rejected.

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

Offline Registry exposes a key's last-write timestamp, which is shown as selected-key metadata and in the **Last write (key)** column for direct subkeys. Registry values have no individual last-write timestamp, so the column is hidden in the values-only view. Offline Registry also does not expose key creation time. Export maps standard hive names to their conventional roots (`SOFTWARE` to `HKEY_LOCAL_MACHINE\SOFTWARE`, `NTUSER.DAT` to `HKEY_CURRENT_USER`, and so on); unknown `.hiv`/`.hive` names default to `HKEY_LOCAL_MACHINE`.

## Language model tools

| Tool | Purpose | Required input | Optional input |
| --- | --- | --- | --- |
| `registry_read_hive` | List direct subkeys and values at a hive-relative key path | `path`: absolute hive file path | `key`: hive-relative key path; defaults to the root |
| `registry_search_hive` | Perform a bounded, case-insensitive literal search | `path`: absolute hive file path; `query`: text to find | `limit`: 1–500, default 100 |
| `registry_query_hive` | Run an allowlisted SQL-like WHERE expression against the cache | `path`: absolute hive file path; `where`: expression without the `WHERE` keyword | `limit`: 1–500, default 100 |

All tools require an absolute hive file path and are read-only.

## Build

Prerequisites:

- Windows x64
- Node.js 22
- Visual Studio 2026 with the C++ x64 build tools (v145)
- Windows Driver Kit containing the Offline Registry Library

```powershell
npm install
npm run check
npm run build
npm test
npm run test:native
npm run test:integration
npm run test:extension
npm run package
```

Unit tests run in Node with Vitest and as a native C++ test executable. Integration tests generate a temporary offline hive with the Offline Registry API and exercise the built native helper end to end. Extension Host tests launch VS Code and verify activation, command registration, and custom editor opening. Run `npm run build` before the integration and Extension Host tests.

The native project is available directly as `native/vscode-reg-native/vscode-reg-native.vcxproj`. It statically links the Visual C++ runtime and locates the newest installed WDK `offreg.h`, x64 `offreg.lib`, and redistributable x64 `offreg.dll`. CI uses the GitHub Actions `windows-2025-vs2026` image and installs the WDK before building.

## Release

1. Run `npm version <version> --no-git-tag-version` and add the release notes to `CHANGELOG.md`.
2. Commit the changes, then create and push a matching version tag such as `v0.0.2`.
3. The CI workflow runs all checks, packages the extension, and creates a GitHub Release with the VSIX attached and generated release notes.
4. Upload the VSIX from the GitHub Release to the Visual Studio Marketplace manually.

The tag must exactly match `v` followed by the version in `package.json`; otherwise, the release job fails without creating a release.

## Platform and safety

The extension currently ships an x64 helper. On Windows Arm64, it runs under Windows x64 emulation. Hive access only requires ordinary file read permission. Files locked or protected by Windows may still need to be copied to a readable location by an appropriately authorized user.

Hive parsing is implemented with Microsoft's Offline Registry Library (`offreg.dll`). The packaged DLL comes from the WDK Redistributable directory, not from the local `System32` directory.

## Licenses

The extension source is MIT licensed. `nlohmann/json` 3.12.0 is MIT licensed and pinned by NuGet package version. See `THIRD_PARTY_NOTICES.txt` for attribution and the WDK notice. Redistribution of `offreg.dll` remains subject to the Microsoft WDK license terms.

## Support

This is a personal, independently maintained project. Bug reports and feature requests are reviewed on a best-effort basis; no response, fix, or release timeline is guaranteed.

For security issues, see the project's `SECURITY.md` policy.