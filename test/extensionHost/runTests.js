const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..', '..');
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'vscode-reg-extension-test-'));
  const hivePath = path.join(temporaryDirectory, 'sample.hiv');
  const executable = path.join(root, 'native', 'bin', 'win32-x64', 'vscode-reg-native.exe');
  try {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', path.join(root, 'test', 'fixtures', 'createTestHive.ps1'),
      '-OutputPath', hivePath,
      '-OffregDirectory', path.dirname(executable),
    ], { stdio: 'inherit' });

    await runTests({
      version: '1.105.0',
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'out', 'suite.js'),
      extensionTestsEnv: { VSCODE_REG_TEST_HIVE: hivePath },
      launchArgs: [
        temporaryDirectory,
        '--disable-extensions',
        '--user-data-dir', path.join(temporaryDirectory, 'user-data'),
        '--extensions-dir', path.join(temporaryDirectory, 'extensions'),
      ],
    });
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});