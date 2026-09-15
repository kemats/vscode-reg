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
- Clickable registry-location links in Copilot responses that open the referenced hive key or value in the viewer.
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

Literal search is case-insensitive and matches key paths, value names, and previewed value data. The first search creates a reusable SQLite cache beside the hive when possible; the extension asks before using VS Code's global storage as a fallback. Search results are limited to 500 matches.

Select **SQL-like** from the Search mode control to query the cache with expressions such as:

```sql
kind = 'key' AND last_write >= '2026-01-01T00:00:00Z'
data LIKE '%Visual C++%'
path LIKE 'Microsoft\Windows\CurrentVersion\WINEVT%' AND name = 'Enabled' AND data LIKE '1 (%'
```

See [Design](docs/design.md) for cache locations and cleanup, query syntax, limits, performance notes, and native-helper behavior.

## Language model tools

| Tool | Purpose | Required input | Optional input |
| --- | --- | --- | --- |
| `registry_read_hive` | List direct subkeys and values at a hive-relative key path | `path`: absolute hive file path | `key`: hive-relative key path; defaults to the root |
| `registry_search_hive` | Perform a bounded, case-insensitive literal search | `path`: absolute hive file path; `query`: text to find | `limit`: 1–500, default 100 |
| `registry_query_hive` | Run an allowlisted SQL-like WHERE expression against the cache | `path`: absolute hive file path; `where`: expression without the `WHERE` keyword | `limit`: 1–500, default 100 |

All tools require an absolute hive file path and are read-only. Tool results include `openUri` fields for returned keys and values. Copilot can use these fields as Markdown link targets when citing registry evidence. Clicking such a `vscode://KeiichiMatsui.vscode-reg/open?...` link opens the hive viewer directly and selects the referenced key or value. The path, key, and value are encoded in the URI; links should therefore be shared only where exposing those names and paths is appropriate.

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

Native build and CI details are documented in [Design](docs/design.md). Repository owners can find the publishing procedure in [Release](docs/release.md).

## Platform and safety

The extension currently ships an x64 helper. On Windows Arm64, it runs under Windows x64 emulation. Hive access only requires ordinary file read permission. Files locked or protected by Windows may still need to be copied to a readable location by an appropriately authorized user.

Hive parsing is implemented with Microsoft's Offline Registry Library (`offreg.dll`). The packaged DLL comes from the WDK Redistributable directory, not from the local `System32` directory.

## Licenses

The extension source is MIT licensed. `nlohmann/json` 3.12.0 is MIT licensed and pinned by NuGet package version. See `THIRD_PARTY_NOTICES.txt` for attribution and the WDK notice. Redistribution of `offreg.dll` remains subject to the Microsoft WDK license terms.

## Support

This is a personal, independently maintained project. Bug reports and feature requests are reviewed on a best-effort basis; no response, fix, or release timeline is guaranteed.

For security issues, see the project's `SECURITY.md` policy.