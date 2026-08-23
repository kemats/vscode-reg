import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const extensionId = 'KeiichiMatsui.vscode-reg';
const commandId = 'vscode-reg.openHive';
const viewType = 'vscode-reg.hiveViewer';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, `Extension ${extensionId} was not found.`);

  await extension.activate();
  assert.equal(extension.isActive, true, 'Extension did not activate.');
  console.log('Extension activation verified.');

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes(commandId), `Command ${commandId} was not registered.`);
  console.log('Command registration verified.');

  const hivePath = process.env.VSCODE_REG_TEST_HIVE;
  assert.ok(hivePath, 'VSCODE_REG_TEST_HIVE was not provided.');
  const hiveUri = vscode.Uri.file(hivePath);
  await vscode.commands.executeCommand('vscode.openWith', hiveUri, viewType);

  await waitFor(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => {
    const input = tab.input;
    return input instanceof vscode.TabInputCustom && input.viewType === viewType && input.uri.fsPath === hiveUri.fsPath;
  })), 10_000, 'Custom hive editor did not open.');
  console.log('Custom editor opening verified.');

  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
}

async function waitFor(predicate: () => boolean, timeoutMilliseconds: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) { throw new Error(message); }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}