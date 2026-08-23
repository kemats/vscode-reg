import * as vscode from 'vscode';
import { HiveEditorProvider } from './hiveEditor';
import { HiveSessionPool } from './hiveClient';
import { registerLmTools } from './lmTools';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Registry Hive Viewer', { log: true });
  const pool = new HiveSessionPool(context, 1, output);
  const editor = new HiveEditorProvider(pool, context, output);
  output.info('Registry Hive Viewer activated.');

  context.subscriptions.push(
    output,
    pool,
    vscode.window.registerCustomEditorProvider('vscode-reg.hiveViewer', editor, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('vscode-reg.openHive', async () => {
      const selection = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Open Registry Hive',
      });
      if (selection?.[0]) {
        await vscode.commands.executeCommand('vscode.openWith', selection[0], 'vscode-reg.hiveViewer');
      }
    }),
  );

  registerLmTools(context, pool);
}

export function deactivate(): void {}
