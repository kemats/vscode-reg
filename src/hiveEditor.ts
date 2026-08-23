import * as vscode from 'vscode';
import { HiveSessionPool } from './hiveClient';

class HiveDocument implements vscode.CustomDocument {
  constructor(readonly uri: vscode.Uri, private readonly pool: HiveSessionPool) {}
  dispose(): void { this.pool.invalidate(this.uri.fsPath); }
}

export class HiveEditorProvider implements vscode.CustomReadonlyEditorProvider<HiveDocument> {
  constructor(private readonly pool: HiveSessionPool, private readonly context: vscode.ExtensionContext, private readonly output: vscode.LogOutputChannel) {}

  openCustomDocument(uri: vscode.Uri): HiveDocument {
    return new HiveDocument(uri, this.pool);
  }

  async resolveCustomEditor(document: HiveDocument, panel: vscode.WebviewPanel): Promise<void> {
    this.output.info(`Opening hive editor for ${document.uri.fsPath}`);
    panel.webview.options = { enableScripts: true };
    panel.webview.html = this.html(panel.webview, document.uri);

    panel.webview.onDidReceiveMessage(async message => {
      try {
        if (message.type === 'clientError') {
          this.output.error(`Webview error for ${document.uri.fsPath}: ${message.message}`);
          return;
        }
        if (message.type === 'inputName') {
          const value = await vscode.window.showInputBox({
            title: 'Favorite name',
            value: typeof message.value === 'string' ? message.value.slice(0, 200) : '',
            prompt: message.existing ? 'Enter a new name' : 'Enter a name',
            validateInput: input => input.trim() ? undefined : 'Name is required',
          });
          panel.webview.postMessage({ type: 'inputName', requestId: message.requestId, data: value?.trim() ?? null });
          return;
        }
        const client = await this.pool.get(document.uri.fsPath);
        if (message.type === 'list') {
          panel.webview.postMessage({
            type: 'listing',
            requestId: message.requestId,
            data: await client.list(message.path ?? '', message.offset ?? 0),
          });
        } else if (message.type === 'search') {
          panel.webview.postMessage({ type: 'searchResults', requestId: message.requestId, data: await client.search(message.query, 500, message.scope ?? '') });
        } else if (message.type === 'query') {
          panel.webview.postMessage({ type: 'searchResults', requestId: message.requestId, data: await client.query(message.where, 500, message.scope ?? '') });
        } else if (message.type === 'valueData') {
          panel.webview.postMessage({ type: 'valueData', requestId: message.requestId, data: await client.valueData(message.path ?? '', message.name ?? '') });
        } else if (message.type === 'getFavorites') {
          panel.webview.postMessage({ type: 'favorites', requestId: message.requestId, data: await this.sharedFavorites() });
        } else if (message.type === 'setFavorites') {
          const favorites = Array.isArray(message.favorites) ? message.favorites.filter((item: unknown): item is { name: string; path: string } => {
            if (!item || typeof item !== 'object') { return false; }
            const candidate = item as { name?: unknown; path?: unknown };
            return typeof candidate.name === 'string' && candidate.name.length <= 200 && typeof candidate.path === 'string' && candidate.path.length <= 32767;
          }).slice(0, 100) : [];
          await this.context.globalState.update('hiveFavorites', favorites);
          panel.webview.postMessage({ type: 'favorites', requestId: message.requestId, data: favorites });
        } else if (message.type === 'exportReg') {
          const defaultName = `${document.uri.path.split('/').pop() ?? 'hive'}-${String(message.path || 'root').replace(/[\\/:*?"<>|]/g, '_')}.reg`;
          const destination = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(document.uri, '..', defaultName),
            filters: { 'Registry files': ['reg'] },
            saveLabel: 'Export registry key',
          });
          if (!destination) {
            panel.webview.postMessage({ type: 'cancelled', requestId: message.requestId, data: null });
          } else {
            const data = await client.exportReg(message.path ?? '', destination.fsPath, registryRoot(document.uri));
            panel.webview.postMessage({ type: 'exported', requestId: message.requestId, data });
          }
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        this.output.error(`Request ${String(message.type)} failed for ${document.uri.fsPath}: ${text}`);
        panel.webview.postMessage({ type: 'error', requestId: message.requestId, message: text });
      }
    });
  }

  private async sharedFavorites(): Promise<{ name: string; path: string }[]> {
    const shared = this.context.globalState.get<unknown>('hiveFavorites');
    const sources = shared === undefined
      ? this.context.globalState.keys().filter(key => key.startsWith('hiveFavorites:')).map(key => this.context.globalState.get<unknown>(key))
      : [shared];
    const favorites: { name: string; path: string }[] = [];
    for (const source of sources) {
      if (!Array.isArray(source)) { continue; }
      for (const item of source) {
        const candidate = typeof item === 'string' ? { name: item || '(root)', path: item } : item as { name?: unknown; path?: unknown };
        if (typeof candidate.name === 'string' && typeof candidate.path === 'string' && !favorites.some(favorite => favorite.path === candidate.path)) {
          favorites.push({ name: candidate.name, path: candidate.path });
        }
      }
    }
    const result = favorites.slice(0, 100);
    if (shared === undefined) { await this.context.globalState.update('hiveFavorites', result); }
    return result;
  }

  private html(webview: vscode.Webview, uri: vscode.Uri): string {
    const nonce = randomNonce();
    const title = escapeHtml(uri.path.split('/').pop() ?? 'Registry Hive');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>${title}</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; height: 100vh; overflow: hidden; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px var(--vscode-font-family); }
.toolbar { min-height: 42px; display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editorGroupHeader-tabsBackground); }
.hive-name { min-width: 120px; max-width: 28vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.nav-button { width: 28px; padding: 0; font-size: 16px; }
.path-box { display: flex; flex: 1; min-width: 120px; }
.path-box input { width: 100%; }
.search { display: flex; padding: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.search input { flex: 1; min-width: 0; height: 28px; padding: 3px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); outline: none; }
.path-box input { height: 28px; padding: 3px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); outline: none; }
.search input:focus { border-color: var(--vscode-focusBorder); }
button { height: 28px; padding: 0 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
.search button:disabled { opacity: .7; cursor: wait; }
.search button.searching::before, .search-progress::before { content: ''; width: 12px; height: 12px; flex: none; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
.search button.searching { display: flex; align-items: center; gap: 7px; }
.search-progress { display: flex; align-items: center; justify-content: center; gap: 9px; min-height: 72px; padding: 16px; color: var(--vscode-descriptionForeground); text-align: center; }
@keyframes spin { to { transform: rotate(360deg); } }
.main { display: flex; height: calc(100vh - 66px); }
.tree-pane { flex: 0 0 var(--tree-width, 34%); min-width: 140px; overflow: auto; padding: 5px 0; }
.content-pane { flex: 1 1 auto; min-width: 180px; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.value-list { flex: 3 1 0; min-height: 100px; overflow: auto; }
.search-pane { display: none; flex: 0 0 var(--search-width, 420px); min-width: 220px; overflow: hidden; flex-direction: column; }
.main.search-open .search-pane { display: flex; }
.resizer { flex: 0 0 5px; position: relative; cursor: col-resize; background: var(--vscode-panel-border); }
.resizer:hover, .resizer.dragging { background: var(--vscode-focusBorder); }
.search-resizer { display: none; }
.main.search-open .search-resizer { display: block; }
.search-header { min-height: 42px; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.search-header strong { margin-right: auto; }
.list-toolbar { position: sticky; top: 0; z-index: 3; min-height: 34px; display: flex; align-items: center; gap: 14px; padding: 3px 10px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
.list-toolbar .spacer { flex: 1; }
.list-toolbar label { white-space: nowrap; }
.path { position: sticky; top: 34px; z-index: 2; min-height: 30px; padding: 7px 10px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
ul { list-style: none; margin: 0; padding: 0; }
.tree ul { padding-left: 16px; }
.node-row { display: flex; align-items: center; height: 24px; padding-right: 6px; white-space: nowrap; cursor: default; }
.node-row:hover { background: var(--vscode-list-hoverBackground); }
.node-row.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
.node-row:focus, tbody tr:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.node-row.loading { opacity: .65; }
.tree li[aria-expanded="false"] > ul { display: none; }
.twisty { width: 20px; text-align: center; flex: none; color: var(--vscode-descriptionForeground); cursor: pointer; }
.twisty.leaf { cursor: default; opacity: .45; }
.key-icon { width: 17px; color: var(--vscode-symbolIcon-keyForeground, #d7ba7d); }
.node-label { overflow: hidden; text-overflow: ellipsis; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th { position: sticky; top: 0; z-index: 1; text-align: left; font-weight: 600; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
th, td { height: 27px; padding: 4px 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-right: 1px solid var(--vscode-panel-border); }
th:nth-child(1) { width: 24%; } th:nth-child(2) { width: 16%; } th:nth-child(3) { width: auto; } th:nth-child(4) { width: 170px; } th:nth-child(5) { width: 84px; }
#valuesTable:not(.show-subkeys) th:nth-child(4), #valuesTable:not(.show-subkeys) td:nth-child(4) { display: none; }
tbody tr:hover { background: var(--vscode-list-hoverBackground); }
tbody tr.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
.status { height: 24px; display: flex; align-items: center; gap: 16px; padding: 0 10px; color: var(--vscode-statusBar-foreground); background: var(--vscode-statusBar-background); }
.search-results { flex: 1; min-height: 0; overflow: auto; background: var(--vscode-editor-background); }
.search-results > .path { top: 0; }
.result { padding: 8px 11px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; }
.result:hover { background: var(--vscode-list-hoverBackground); }
.result-key { font-family: var(--vscode-editor-font-family); overflow-wrap: anywhere; }
.result-detail { margin-top: 3px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { padding: 24px; color: var(--vscode-descriptionForeground); text-align: center; }
.detail-resizer { flex: 0 0 5px; cursor: row-resize; background: var(--vscode-panel-border); }
.detail-resizer:hover, .detail-resizer.dragging { background: var(--vscode-focusBorder); }
.detail { flex: 2 1 0; min-height: 120px; display: grid; grid-template-rows: auto auto minmax(0, 1fr); overflow: hidden; background: var(--vscode-editor-background); }
.detail-header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
.detail-header strong { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.detail-tabs { display: flex; gap: 4px; padding: 6px 10px; }
.detail pre { margin: 0; padding: 10px; overflow: auto; white-space: pre-wrap; font-family: var(--vscode-editor-font-family); }
.metadata { color: var(--vscode-descriptionForeground); }
.context-menu { display: none; position: fixed; z-index: 20; min-width: 180px; padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); background: var(--vscode-menu-background, var(--vscode-editor-background)); box-shadow: 0 4px 16px rgba(0,0,0,.35); }
.context-menu.open { display: block; }
.context-menu button { width: 100%; text-align: left; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: transparent; }
.context-menu button:hover, .context-menu button:focus { color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground)); background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground)); }
.split-control { position: relative; display: flex; flex: none; }
.split-control > button + button { border-left: 1px solid var(--vscode-button-separator, rgba(255,255,255,.25)); }
.icon-button { width: 30px; padding: 0; font-size: 17px; }
.drop-button { width: 25px; padding: 0; }
.search-option { min-width: 0; height: 28px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); }
.search-mode { width: 82px; }
.search-scope { width: 116px; }
.dropdown-menu { display: none; position: fixed; z-index: 21; width: min(390px, 90vw); max-height: 55vh; overflow: auto; padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); background: var(--vscode-menu-background, var(--vscode-editor-background)); box-shadow: 0 4px 16px rgba(0,0,0,.35); }
.dropdown-menu.open { display: block; }
.menu-item { display: grid; grid-template-columns: minmax(0, 1fr) 28px 28px; align-items: center; }
.menu-item > button { min-width: 0; padding: 0 7px; text-align: left; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: transparent; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.menu-item > .menu-icon { padding: 0; text-align: center; }
.menu-item > button:hover, .menu-item > button:focus, .menu-action:hover, .menu-action:focus { color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground)); background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground)); }
.menu-action { width: 100%; text-align: left; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: transparent; border-top: 1px solid var(--vscode-panel-border); }
@media (max-width: 700px) { th:nth-child(4), td:nth-child(4), th:nth-child(5), td:nth-child(5) { display:none; } }
</style>
</head>
<body>
<div class="toolbar">
  <div class="hive-name" title="${escapeHtml(uri.fsPath)}">${title}</div>
  <button id="back" class="nav-button" title="Back" aria-label="Back">‹</button><button id="forward" class="nav-button" title="Forward" aria-label="Forward">›</button><button id="up" class="nav-button" title="Up one level" aria-label="Up one level">↑</button>
  <div class="path-box"><input id="pathInput" aria-label="Registry key path" placeholder="Enter key path"></div>
  <div class="split-control"><button id="favorite" class="icon-button" title="Add current key to favorites" aria-label="Add current key to favorites">☆</button><button id="favoriteMenuToggle" class="drop-button" title="Show favorites" aria-label="Show favorites">▾</button></div>
</div>
<div id="main" class="main">
  <nav id="treePane" class="tree-pane" aria-label="Registry keys"><ul id="tree" class="tree" role="tree"></ul></nav>
  <div id="treeResizer" class="resizer" role="separator" aria-label="Resize registry key pane" aria-orientation="vertical"></div>
  <section id="contentPane" class="content-pane"><div class="list-toolbar"><label><input type="radio" name="viewMode" value="values" checked> Values</label><label><input type="radio" name="viewMode" value="subkeys"> Values + subkeys</label><span class="spacer"></span><span id="keyMetadata" class="metadata"></span></div><div id="path" class="path">\</div><div id="valueList" class="value-list"><table id="valuesTable" role="grid" aria-label="Registry values and subkeys"><thead><tr><th>Name</th><th>Type</th><th>Data</th><th>Last write (key)</th><th>Bytes</th></tr></thead><tbody id="values"></tbody></table></div><div id="detailResizer" class="detail-resizer" role="separator" aria-label="Resize registry value details" aria-orientation="horizontal"></div><section id="detail" class="detail" aria-label="Registry value details"><div class="detail-header"><strong id="detailTitle">Value details</strong><span id="detailMeta" class="metadata"></span></div><div id="detailTabs" class="detail-tabs"></div><pre id="detailContent" class="metadata">Select a registry value to view its details.</pre></section></section>
  <div id="searchResizer" class="resizer search-resizer" role="separator" aria-label="Resize search pane" aria-orientation="vertical"></div>
  <aside id="searchPane" class="search-pane" aria-label="Search"><div class="search-header"><strong>Search</strong><select id="searchMode" class="search-option search-mode" aria-label="Search mode"><option value="text">Text</option><option value="where">SQL-like</option></select><select id="searchScope" class="search-option search-scope" aria-label="Search scope"><option value="all">All keys</option><option value="selected">Selected key</option></select><button id="searchClose" class="icon-button" title="Close search" aria-label="Close search">×</button></div><div class="search"><input id="query" type="search" placeholder="Search text" aria-label="Search registry hive"><button id="searchButton">Search</button></div><div id="searchResults" class="search-results" aria-label="Search results" aria-live="polite"><div class="empty">Enter a search term</div></div></aside>
</div>
<div id="favoriteMenu" class="dropdown-menu" role="menu"><div id="favoriteItems"></div><button id="addFavorite" class="menu-action">Add current key…</button></div>
<div id="treeContextMenu" class="context-menu" role="menu"><button id="contextExport" role="menuitem">Export selected key as .reg…</button></div>
<div class="status"><span id="status" aria-live="polite">Opening hive…</span><span id="metrics"></span></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const tree = document.getElementById('tree');
const treePane = document.getElementById('treePane');
const values = document.getElementById('values');
const pathLabel = document.getElementById('path');
const status = document.getElementById('status');
const metrics = document.getElementById('metrics');
const resultsPanel = document.getElementById('searchResults');
const main = document.getElementById('main');
const pathInput = document.getElementById('pathInput');
const favoriteButton = document.getElementById('favorite');
const favoriteMenu = document.getElementById('favoriteMenu');
const treeContextMenu = document.getElementById('treeContextMenu');
const detailPanel = document.getElementById('detail');
const detailTitle = document.getElementById('detailTitle');
const detailMeta = document.getElementById('detailMeta');
const detailTabs = document.getElementById('detailTabs');
const detailContent = document.getElementById('detailContent');
let requestId = 0;
let selectedRow;
let selectedValueRow;
let selectedPath = '';
let selectionVersion = 0;
let detailVersion = 0;
let navigationVersion = 0;
let searchInProgress = false;
let history = [];
let historyIndex = -1;
let favorites = [];
const pending = new Map();
const listRequests = new Map();

function request(type, data = {}) {
  const id = ++requestId;
  vscode.postMessage({ type, requestId: id, ...data });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function join(parent, child) { return parent ? parent + '\\\\' + child : child; }

function requestList(path, offset = 0) {
  const key = path + '\\0' + offset;
  if (!listRequests.has(key)) listRequests.set(key, request('list', { path, offset }).finally(() => listRequests.delete(key)));
  return listRequests.get(key);
}
function parentPath(path) { const index = path.lastIndexOf('\\\\'); return index < 0 ? '' : path.slice(0, index); }
async function loadRoot() {
  const root = el('li');
  root.setAttribute('role', 'treeitem'); root.setAttribute('aria-expanded', 'true');
  const row = el('div', 'node-row');
  row.dataset.path = ''; row.tabIndex = 0;
  row.append(el('span', 'twisty', '▾'), el('span', 'key-icon', '▰'), el('span', 'node-label', '${title}'));
  const children = el('ul'); children.setAttribute('role', 'group'); root.append(row, children); tree.append(root);
  bindTreeRow(row); await select(row, '', true); await toggle(root, true);
  favorites = await request('getFavorites');
  favorites = favorites.map(item => typeof item === 'string' ? { name: item || '(root)', path: item } : item);
  renderFavorites();
}

async function select(row, keyPath, addHistory = true) {
  const version = ++selectionVersion;
  selectedRow?.classList.remove('selected'); selectedRow = row; row.classList.add('selected');
  tree.querySelectorAll('.node-row[tabindex="0"]').forEach(item => item.tabIndex = -1); row.tabIndex = 0;
  selectedPath = keyPath; pathInput.value = keyPath; updateFavoriteButton();
  if (addHistory && history[historyIndex] !== keyPath) { history = history.slice(0, historyIndex + 1); history.push(keyPath); historyIndex = history.length - 1; }
  updateNavButtons();
  status.textContent = 'Loading…';
  try {
    const listing = await requestList(keyPath);
    if (version !== selectionVersion) return;
    row.parentElement.dataset.subkeyCount = String(listing.subkeyCount);
    setExpansionVisual(row.parentElement);
    renderValues(listing);
    status.textContent = listing.subkeyCount + ' subkeys, ' + listing.values.length + ' values';
  } catch (error) { status.textContent = error.message; }
}

function setExpansionVisual(li) {
  const row = li.querySelector(':scope > .node-row'); const twisty = row.querySelector('.twisty');
  const count = Number(li.dataset.subkeyCount || 0); const expanded = li.getAttribute('aria-expanded') === 'true';
  twisty.textContent = count ? (expanded ? '▾' : '›') : '·'; twisty.classList.toggle('leaf', !count);
  li.setAttribute('aria-expanded', count ? String(expanded) : 'false');
}

async function toggle(li, expand) {
  const count = Number(li.dataset.subkeyCount || 0); if (!count || li.dataset.loading === 'true') return;
  const shouldExpand = expand === undefined ? li.getAttribute('aria-expanded') !== 'true' : expand;
  if (!shouldExpand) { li.setAttribute('aria-expanded', 'false'); setExpansionVisual(li); return; }
  li.setAttribute('aria-expanded', 'true'); setExpansionVisual(li);
  const children = li.querySelector(':scope > ul');
  if (children?.dataset.loaded === 'true') return;
  li.dataset.loading = 'true'; li.querySelector(':scope > .node-row').classList.add('loading');
  try { renderChildren(li, await requestList(li.querySelector(':scope > .node-row').dataset.path)); }
  catch (error) { li.setAttribute('aria-expanded', 'false'); status.textContent = error.message; }
  finally { li.dataset.loading = 'false'; li.querySelector(':scope > .node-row').classList.remove('loading'); setExpansionVisual(li); }
}

function renderChildren(li, listing) {
  let children = li.querySelector(':scope > ul');
  if (!children) { children = el('ul'); li.append(children); }
  if (listing.subkeyOffset === 0 && children.dataset.loaded === 'true') return;
  children.querySelector(':scope > .load-more')?.remove();
  children.dataset.loaded = 'true';
  for (const key of listing.subkeys) {
    if ([...children.children].some(item => item.querySelector(':scope > .node-row')?.dataset.path === join(listing.path, key.name))) continue;
    const child = el('li');
    child.setAttribute('role', 'treeitem'); child.setAttribute('aria-expanded', 'false'); child.dataset.subkeyCount = String(key.subkeyCount);
    const row = el('div', 'node-row'); row.dataset.path = join(listing.path, key.name); row.tabIndex = -1;
    const twisty = el('span', 'twisty', key.subkeyCount ? '›' : '·'); if (!key.subkeyCount) twisty.classList.add('leaf');
    row.append(twisty, el('span', 'key-icon', '▰'), el('span', 'node-label', key.name));
    row.title = key.name + (key.lastWrite ? '\\nLast write: ' + key.lastWrite : ''); child.append(row); children.append(child);
    bindTreeRow(row);
  }
  if (listing.hasMoreSubkeys) {
    const more = el('li', 'load-more');
    const moreRow = el('div', 'node-row');
    moreRow.append(el('span', 'twisty', '…'), el('span', 'node-label', 'Load more…'));
    more.append(moreRow); children.append(more);
    moreRow.addEventListener('click', async () => {
      moreRow.querySelector('.node-label').textContent = 'Loading…';
      try {
        const next = await requestList(listing.path, listing.subkeyOffset + listing.subkeys.length);
        renderChildren(li, next);
      } catch (error) { status.textContent = error.message; }
    });
  }
}

function bindTreeRow(row) {
  row.addEventListener('click', event => { if (event.target.closest('.twisty')) toggle(row.parentElement); else select(row, row.dataset.path); });
  row.addEventListener('contextmenu', event => { event.preventDefault(); select(row, row.dataset.path); showTreeContextMenu(event.clientX, event.clientY); });
  row.addEventListener('dblclick', () => toggle(row.parentElement));
  row.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); select(row, row.dataset.path); const bounds = row.getBoundingClientRect(); showTreeContextMenu(bounds.left + 24, bounds.bottom); return; }
    const visible = [...tree.querySelectorAll('.node-row')].filter(item => item.offsetParent !== null);
    const index = visible.indexOf(row); let target;
    if (event.key === 'ArrowDown') target = visible[index + 1];
    else if (event.key === 'ArrowUp') target = visible[index - 1];
    else if (event.key === 'ArrowRight') { if (row.parentElement.getAttribute('aria-expanded') !== 'true') toggle(row.parentElement, true); else target = row.parentElement.querySelector(':scope > ul > li > .node-row'); }
    else if (event.key === 'ArrowLeft') { if (row.parentElement.getAttribute('aria-expanded') === 'true') toggle(row.parentElement, false); else target = row.parentElement.parentElement?.closest('li')?.querySelector(':scope > .node-row'); }
    else if (event.key === 'Enter' || event.key === ' ') select(row, row.dataset.path);
    else if (event.key === 'Home') target = visible[0]; else if (event.key === 'End') target = visible.at(-1); else return;
    event.preventDefault(); if (target) { target.focus(); select(target, target.dataset.path); }
  });
}

function renderValues(listing) {
  pathLabel.textContent = '\\\\' + listing.path;
  pathLabel.title = listing.lastWrite ? 'Last write: ' + listing.lastWrite : '';
  document.getElementById('keyMetadata').textContent = listing.lastWrite ? 'Last write: ' + listing.lastWrite : '';
  clearValueDetail();
  values.replaceChildren(); selectedValueRow = undefined;
  const showSubkeys = document.querySelector('input[name="viewMode"]:checked').value === 'subkeys';
  document.getElementById('valuesTable').classList.toggle('show-subkeys', showSubkeys);
  if (showSubkeys) {
    for (const key of listing.subkeys) addGridRow(key.name, 'KEY', '', key.lastWrite || '', '', () => navigateTo(join(listing.path, key.name)));
  }
  for (const value of listing.values) {
    addGridRow(value.name, value.type, value.data, '', String(value.size), () => showValueDetail(listing.path, value), value.rawName);
  }
  if (!values.children.length) { const row = el('tr'); const cell = el('td', 'empty', '(No values)'); cell.colSpan = 5; row.append(cell); values.append(row); }
}

function addGridRow(name, type, data, lastWrite, size, activate, valueName) {
  const row = el('tr'); row.tabIndex = -1; row.setAttribute('role', 'row');
  if (valueName !== undefined) row.dataset.valueName = valueName;
  for (const text of [name, type, data, lastWrite, size]) { const cell = el('td', '', text); cell.title = text; row.append(cell); }
  row.addEventListener('click', () => selectGridRow(row, valueName !== undefined ? activate : undefined));
  if (valueName === undefined) row.addEventListener('dblclick', activate);
  row.addEventListener('keydown', event => { const rows = [...values.querySelectorAll('tr[tabindex]')]; const index = rows.indexOf(row); const target = event.key === 'ArrowDown' ? rows[index + 1] : event.key === 'ArrowUp' ? rows[index - 1] : event.key === 'Home' ? rows[0] : event.key === 'End' ? rows.at(-1) : null; if (target) { event.preventDefault(); target.click(); target.focus(); } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } });
  values.append(row); if (!selectedValueRow) { row.tabIndex = 0; selectedValueRow = row; }
}
function selectGridRow(row, showDetail) { selectedValueRow?.classList.remove('selected'); if (selectedValueRow) selectedValueRow.tabIndex = -1; selectedValueRow = row; row.classList.add('selected'); row.tabIndex = 0; showDetail?.(); }
function selectValueRow(valueName) { const row = [...values.querySelectorAll('tr[data-value-name]')].find(item => item.dataset.valueName === valueName); if (!row) return; row.click(); row.scrollIntoView({ block: 'nearest', inline: 'nearest' }); row.focus({ preventScroll: true }); }

async function search() {
  if (searchInProgress) return;
  const query = document.getElementById('query').value.trim(); if (!query) return;
  const searchButton = document.getElementById('searchButton');
  searchInProgress = true;
  searchButton.disabled = true; searchButton.classList.add('searching'); searchButton.textContent = 'Searching…';
  resultsPanel.setAttribute('aria-busy', 'true');
  resultsPanel.replaceChildren(el('div', 'search-progress', 'Searching the hive. The first search may take a while while the index is created.'));
  status.textContent = 'Building or querying search index…'; metrics.textContent = '';
  try {
    const whereMode = document.getElementById('searchMode').value === 'where';
    const scope = document.getElementById('searchScope').value === 'selected' ? selectedPath : '';
    const response = await request(whereMode ? 'query' : 'search', whereMode ? { where: query, scope } : { query, scope });
    resultsPanel.replaceChildren();
    resultsPanel.scrollTop = 0;
    const scopeLabel = scope ? ' under \\\\' + scope : '';
    const heading = el('div', 'path', response.results.length + ' results for “' + query + '”' + scopeLabel); resultsPanel.append(heading);
    for (const result of response.results) {
      const item = el('div', 'result'); item.append(el('div', 'result-key', '\\\\' + result.key));
      if (result.value) item.append(el('div', 'result-detail', result.value.name + ' · ' + result.value.type + ' · ' + result.value.data));
      item.addEventListener('click', () => navigateTo(result.key, true, result.value?.rawName)); resultsPanel.append(item);
    }
    if (!response.results.length) resultsPanel.append(el('div', 'empty', 'No matches'));
    status.textContent = response.indexBuilt ? 'Search index built' : 'Search index reused';
    metrics.textContent = response.indexedRecords.toLocaleString() + ' indexed records · ' + response.elapsedMs + ' ms';
  } catch (error) {
    status.textContent = error.message;
    resultsPanel.replaceChildren(el('div', 'empty', error.message));
  } finally {
    searchInProgress = false;
    searchButton.disabled = false; searchButton.classList.remove('searching'); searchButton.textContent = 'Search';
    resultsPanel.removeAttribute('aria-busy');
  }
}

async function navigateTo(keyPath, addHistory = true, valueName) {
  const version = ++navigationVersion;
  const parts = keyPath ? keyPath.split('\\\\') : [];
  let currentPath = '';
  let currentLi = tree.firstElementChild;
  for (const part of parts) {
    let listing = await requestList(currentPath); if (version !== navigationVersion) return; renderChildren(currentLi, listing); currentLi.setAttribute('aria-expanded', 'true'); setExpansionVisual(currentLi);
    currentPath = join(currentPath, part);
    let rows = [...currentLi.querySelectorAll(':scope > ul > li > .node-row')];
    let row = rows.find(item => item.dataset.path === currentPath);
    while (!row && listing.hasMoreSubkeys) {
      listing = await requestList(listing.path, listing.subkeyOffset + listing.subkeys.length);
      if (version !== navigationVersion) return;
      renderChildren(currentLi, listing);
      rows = [...currentLi.querySelectorAll(':scope > ul > li > .node-row')];
      row = rows.find(item => item.dataset.path === currentPath);
    }
    if (!row) break;
    currentLi = row.parentElement;
  }
  const row = currentLi.querySelector(':scope > .node-row'); if (row && version === navigationVersion) { await select(row, keyPath, addHistory); if (version !== navigationVersion) return; row.scrollIntoView({ block: 'center', inline: 'nearest' }); row.focus({ preventScroll: true }); if (valueName !== undefined) selectValueRow(valueName); }
}

function updateNavButtons() { document.getElementById('back').disabled = historyIndex <= 0; document.getElementById('forward').disabled = historyIndex >= history.length - 1; document.getElementById('up').disabled = !selectedPath; }
async function moveHistory(delta) { const next = historyIndex + delta; if (next < 0 || next >= history.length) return; historyIndex = next; await navigateTo(history[next], false); updateNavButtons(); }
function menuIcon(label, title, action) { const button = el('button', 'menu-icon', label); button.title = title; button.setAttribute('aria-label', title); button.addEventListener('click', event => { event.stopPropagation(); action(); }); return button; }
function renderFavorites() {
  const items = document.getElementById('favoriteItems'); items.replaceChildren();
  for (const favorite of favorites) {
    const row = el('div', 'menu-item'); const open = el('button', '', favorite.name); open.title = '\\\\' + (favorite.path || '(root)');
    open.addEventListener('click', () => { hideDropdowns(); navigateTo(favorite.path); });
    row.append(open, menuIcon('✎', 'Rename favorite', async () => { const name = await inputName('favorite', favorite.name, true); if (!name) return; favorite.name = name; await persistFavorites(); }), menuIcon('×', 'Delete favorite', async () => { favorites = favorites.filter(item => item !== favorite); await persistFavorites(); })); items.append(row);
  }
  if (!favorites.length) items.append(el('div', 'empty', 'No favorites'));
  updateFavoriteButton();
}
function updateFavoriteButton() { const active = favorites.some(item => item.path === selectedPath); favoriteButton.textContent = active ? '★' : '☆'; favoriteButton.setAttribute('aria-pressed', String(active)); favoriteButton.title = active ? 'Edit current favorite' : 'Add current key to favorites'; }
async function persistFavorites() { favorites = await request('setFavorites', { favorites }); renderFavorites(); }
async function inputName(kind, value, existing) { return request('inputName', { kind, value, existing }); }
async function addCurrentFavorite() { const existing = favorites.find(item => item.path === selectedPath); const suggested = existing?.name || selectedPath.split('\\\\').at(-1) || '(root)'; const name = await inputName('favorite', suggested, Boolean(existing)); if (!name) return; if (existing) existing.name = name; else favorites.push({ name, path: selectedPath }); await persistFavorites(); }
function positionMenu(menu, anchor) { hideDropdowns(); menu.classList.add('open'); const bounds = anchor.getBoundingClientRect(); const width = menu.offsetWidth; menu.style.left = Math.max(0, Math.min(bounds.right - width, innerWidth - width)) + 'px'; menu.style.top = Math.min(bounds.bottom + 2, innerHeight - menu.offsetHeight) + 'px'; }
function hideDropdowns() { favoriteMenu.classList.remove('open'); }
function hideTreeContextMenu() { treeContextMenu.classList.remove('open'); }
function showTreeContextMenu(x, y) { treeContextMenu.classList.add('open'); const width = treeContextMenu.offsetWidth; const height = treeContextMenu.offsetHeight; treeContextMenu.style.left = Math.max(0, Math.min(x, innerWidth - width)) + 'px'; treeContextMenu.style.top = Math.max(0, Math.min(y, innerHeight - height)) + 'px'; document.getElementById('contextExport').focus(); }
async function exportSelectedKey() { hideTreeContextMenu(); status.textContent = 'Exporting key…'; try { const result = await request('exportReg', { path: selectedPath }); status.textContent = result ? 'Exported to ' + result.destination : 'Export cancelled'; } catch (error) { status.textContent = error.message; } }

async function showValueDetail(keyPath, value) {
  const version = ++detailVersion;
  detailTitle.textContent = value.name;
  detailMeta.textContent = value.type + ' · Loading…';
  detailTabs.replaceChildren();
  detailContent.textContent = 'Loading value data…';
  detailContent.classList.add('metadata');
  status.textContent = 'Loading value data…';
  try {
    const detail = await request('valueData', { path: keyPath, name: value.rawName });
    if (version !== detailVersion) return;
    const bytes = new Uint8Array(detail.bytes); const tabs = [];
    tabs.push(['Hex', [...bytes].map((item, index) => (index % 16 === 0 ? (index ? '\\n' : '') + index.toString(16).padStart(8, '0') + '  ' : '') + item.toString(16).padStart(2, '0') + ' ').join('')]);
    tabs.push(['ASCII', [...bytes].map(item => item >= 32 && item < 127 ? String.fromCharCode(item) : '.').join('')]);
    tabs.push(['Unicode', new TextDecoder('utf-16le').decode(bytes).replaceAll('\\0', '·')]);
    tabs.push(['ACP ' + detail.activeCodePage, detail.activeCodePageText.replaceAll('\\0', '·')]);
    if (bytes.length === 16) { const hex = [...bytes].map(item => item.toString(16).padStart(2, '0')); tabs.push(['GUID', hex.slice(0,4).reverse().join('') + '-' + hex.slice(4,6).reverse().join('') + '-' + hex.slice(6,8).reverse().join('') + '-' + hex.slice(8,10).join('') + '-' + hex.slice(10).join('')]); }
    if ([1, 2, 4, 8].includes(bytes.length)) { const view = new DataView(bytes.buffer); const integer = bytes.length === 1 ? BigInt(view.getUint8(0)) : bytes.length === 2 ? BigInt(view.getUint16(0, true)) : bytes.length === 4 ? BigInt(view.getUint32(0, true)) : view.getBigUint64(0, true); tabs.push(['Integer', integer.toString() + ' (0x' + integer.toString(16) + ')']); }
    if (bytes.length >= 8) { const view = new DataView(bytes.buffer); const ticks = view.getBigUint64(0, true); const millis = Number(ticks / 10000n - 11644473600000n); if (millis >= -11644473600000 && millis <= 253402300799999) tabs.push(['FILETIME', new Date(millis).toISOString() + '\\n' + ticks.toString()]); }
    detailTitle.textContent = value.name; detailMeta.textContent = detail.type + ' · ' + detail.size.toLocaleString() + ' bytes'; detailTabs.replaceChildren(); detailContent.classList.remove('metadata');
    const show = tab => { detailContent.textContent = tab[1]; [...detailTabs.children].forEach(button => button.disabled = button.textContent === tab[0]); };
    for (const tab of tabs) { const button = el('button', '', tab[0]); button.addEventListener('click', () => show(tab)); detailTabs.append(button); }
    show(tabs[0]); status.textContent = 'Value details loaded';
  } catch (error) { if (version === detailVersion) { detailMeta.textContent = ''; detailContent.textContent = error.message; status.textContent = error.message; } }
}

function clearValueDetail() {
  detailVersion++;
  detailTitle.textContent = 'Value details'; detailMeta.textContent = ''; detailTabs.replaceChildren();
  detailContent.textContent = 'Select a registry value to view its details.'; detailContent.classList.add('metadata');
}

function updateSearchMode() {
  const where = document.getElementById('searchMode').value === 'where';
  const queryInput = document.getElementById('query');
  queryInput.placeholder = where ? "WHERE expression, e.g. data LIKE '%Visual C++%'" : 'Search text';
  queryInput.title = where ? [
    "Keys updated since a date: kind = 'key' AND last_write >= '2026-01-01T00:00:00Z'",
    "Values containing Visual C++: data LIKE '%Visual C++%'",
    "Enabled event log providers: path LIKE 'Microsoft\\\\Windows\\\\CurrentVersion\\\\WINEVT%' AND name = 'Enabled' AND data LIKE '1 (%'"
  ].join('\\n') : '';
}
function openSearch() { main.classList.add('search-open'); document.getElementById('query').focus(); }
function closeSearch() { main.classList.remove('search-open'); }
function bindResizer(resizer, side) {
  resizer.addEventListener('pointerdown', event => {
    event.preventDefault(); resizer.classList.add('dragging'); resizer.setPointerCapture(event.pointerId);
    const startX = event.clientX; const startWidth = side === 'tree' ? treePane.getBoundingClientRect().width : document.getElementById('searchPane').getBoundingClientRect().width;
    const move = moveEvent => {
      const width = side === 'tree' ? startWidth + moveEvent.clientX - startX : startWidth - moveEvent.clientX + startX;
      const minimum = side === 'tree' ? 140 : 220;
      const otherWidth = side === 'tree' && main.classList.contains('search-open') ? document.getElementById('searchPane').getBoundingClientRect().width + 5 : side === 'search' ? treePane.getBoundingClientRect().width + 5 : 0;
      const maximum = Math.max(minimum, main.clientWidth - otherWidth - 185);
      main.style.setProperty(side === 'tree' ? '--tree-width' : '--search-width', Math.max(minimum, Math.min(width, maximum)) + 'px');
    };
    const stop = () => { resizer.classList.remove('dragging'); resizer.removeEventListener('pointermove', move); resizer.removeEventListener('pointerup', stop); };
    resizer.addEventListener('pointermove', move); resizer.addEventListener('pointerup', stop);
  });
}
bindResizer(document.getElementById('treeResizer'), 'tree'); bindResizer(document.getElementById('searchResizer'), 'search');
document.getElementById('detailResizer').addEventListener('pointerdown', event => {
  event.preventDefault(); const resizer = event.currentTarget; const valueList = document.getElementById('valueList'); const contentPane = document.getElementById('contentPane');
  resizer.classList.add('dragging'); resizer.setPointerCapture(event.pointerId);
  const startY = event.clientY; const startHeight = valueList.getBoundingClientRect().height;
  const move = moveEvent => { const maximum = Math.max(100, contentPane.clientHeight - 220); valueList.style.flex = '0 0 ' + Math.max(100, Math.min(startHeight + moveEvent.clientY - startY, maximum)) + 'px'; };
  const stop = () => { resizer.classList.remove('dragging'); resizer.removeEventListener('pointermove', move); resizer.removeEventListener('pointerup', stop); };
  resizer.addEventListener('pointermove', move); resizer.addEventListener('pointerup', stop);
});
document.getElementById('searchButton').addEventListener('click', search);
document.getElementById('query').addEventListener('keydown', event => { if (event.key === 'Enter') search(); });
document.getElementById('searchClose').addEventListener('click', closeSearch);
document.getElementById('searchMode').addEventListener('change', updateSearchMode);
pathInput.addEventListener('keydown', event => { if (event.key === 'Enter') navigateTo(pathInput.value.replace(/^\\\\+|\\\\+$/g, '')); });
document.getElementById('back').addEventListener('click', () => moveHistory(-1)); document.getElementById('forward').addEventListener('click', () => moveHistory(1)); document.getElementById('up').addEventListener('click', () => navigateTo(parentPath(selectedPath)));
favoriteButton.addEventListener('click', addCurrentFavorite); document.getElementById('addFavorite').addEventListener('click', addCurrentFavorite); document.getElementById('favoriteMenuToggle').addEventListener('click', event => { event.stopPropagation(); if (favoriteMenu.classList.contains('open')) hideDropdowns(); else positionMenu(favoriteMenu, event.currentTarget); });
document.getElementById('contextExport').addEventListener('click', exportSelectedKey);
document.querySelectorAll('input[name="viewMode"]').forEach(input => input.addEventListener('change', () => selectedRow && select(selectedRow, selectedPath, false)));
document.addEventListener('click', event => { if (!event.target.closest('#treeContextMenu')) hideTreeContextMenu(); if (!event.target.closest('.dropdown-menu')) hideDropdowns(); });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); openSearch(); } else if (event.key === 'Escape' && favoriteMenu.classList.contains('open')) { hideDropdowns(); event.preventDefault(); } else if (event.key === 'Escape' && treeContextMenu.classList.contains('open')) { hideTreeContextMenu(); event.preventDefault(); } });
window.addEventListener('message', event => {
  const message = event.data; const operation = pending.get(message.requestId); if (!operation) return; pending.delete(message.requestId);
  if (message.type === 'error') operation.reject(new Error(message.message)); else operation.resolve(message.data);
});
window.addEventListener('error', event => vscode.postMessage({ type: 'clientError', message: event.message + (event.filename ? ' at ' + event.filename + ':' + event.lineno + ':' + event.colno : '') }));
window.addEventListener('unhandledrejection', event => vscode.postMessage({ type: 'clientError', message: 'Unhandled promise rejection: ' + (event.reason?.stack || event.reason || 'Unknown error') }));
loadRoot();
</script>
</body>
</html>`;
  }
}

function randomNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function registryRoot(uri: vscode.Uri): string {
  const name = uri.path.split('/').pop()?.toUpperCase();
  if (name === 'NTUSER.DAT') { return 'HKEY_CURRENT_USER'; }
  if (name === 'USRCLASS.DAT') { return 'HKEY_CURRENT_USER\\Software\\Classes'; }
  if (name === 'DEFAULT') { return 'HKEY_USERS\\.DEFAULT'; }
  if (name && ['SOFTWARE', 'SYSTEM', 'SAM', 'SECURITY', 'COMPONENTS', 'DRIVERS'].includes(name)) {
    return `HKEY_LOCAL_MACHINE\\${name}`;
  }
  return 'HKEY_LOCAL_MACHINE';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
