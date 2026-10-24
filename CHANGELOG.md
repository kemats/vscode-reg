# Changelog

All notable changes to this extension will be documented in this file.

## 0.0.4 - 2026-10-24

- Updated TypeScript to 7, Vitest to 5, and Node.js type definitions to 26.
- Pinned VS Code type definitions to 1.105.0 and excluded them from Dependabot updates to preserve the minimum supported VS Code API.
- Updated transitive dependencies, including Vite and `brace-expansion`, to address security alerts.
- Updated development-tool dependencies to patched `markdown-it`, `fast-uri`, and `undici` versions; retained the already-patched Vite version.
- The publishing toolchain's MSAL advisory (GHSA-xcx6-jx8p-x3h5) remains pending an upstream-compatible fix in Azure Identity.

## 0.0.3 - 2026-09-16

- Added type-ahead search to the registry key tree.
- Improved tree layout and responsive behavior.
- Updated dependencies to address security alerts.

## 0.0.2 - 2026-09-03

- Added clickable Copilot result links that open an offline hive at the referenced registry key or value.

## 0.0.1 - 2026-08-23

- Initial release.
