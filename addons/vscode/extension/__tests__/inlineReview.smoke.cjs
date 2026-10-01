/* Run with VS Code --extensionTestsPath in an isolated, empty test workspace. */
/* eslint-disable no-console */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');

const command = name => `sapling.inlineReview.${name}`;
const invoke = (name, ...args) => vscode.commands.executeCommand(command(name), ...args);

async function eventually(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    // Polling the asynchronous editor host must be sequential.
    // eslint-disable-next-line no-await-in-loop
    const result = await check();
    if (result) {
      return result;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for inline review state');
}

function lenses(uri, count) {
  return eventually(async () => {
    const all = await vscode.commands.executeCommand('vscode.executeCodeLensProvider', uri);
    const accepts = (all ?? []).filter(lens => lens.command?.command === command('accept'));
    return accepts.length === count ? accepts : false;
  });
}

exports.run = async function () {
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  // Refuse to run in a real repository: this test creates files and changes their contents.
  assert.match(folder, /aionic-inline-review-smoke\./);
  // Native Undo requires editor focus, which some automated macOS hosts cannot provide.
  // Test the host with an unrelated untitled buffer before testing our own edit.
  const scratch = await vscode.workspace.openTextDocument({content: 'probe'});
  const scratchEditor = await vscode.window.showTextDocument(scratch);
  await vscode.commands.executeCommand('workbench.action.focusWindow');
  await scratchEditor.edit(edit => edit.insert(new vscode.Position(0, 5), '!'));
  await vscode.commands.executeCommand('undo');
  await new Promise(resolve => setTimeout(resolve, 300));
  const nativeUndoAvailable = scratch.getText() === 'probe';
  console.log('Native Undo control buffer:', scratch.getText());
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  const first = vscode.Uri.file(path.join(folder, 'first.ts'));
  const second = vscode.Uri.file(path.join(folder, 'second.ts'));
  const before = 'const one = 1;\n// unchanged\nconst two = 2;\n';
  await fs.writeFile(first.fsPath, before);
  await fs.writeFile(second.fsPath, 'const three = 3;\n');
  const extension = vscode.extensions.getExtension('aioniclabs.sapling-scm');
  assert.ok(extension, 'Aionic extension must be loaded, not Meta or Cursor');
  await extension.activate();
  await invoke('start');
  let editor = await vscode.window.showTextDocument(first);
  await invoke('acceptFile');
  await vscode.window.showTextDocument(second);
  await invoke('acceptFile');

  editor = await vscode.window.showTextDocument(first);
  await editor.edit(edit => edit.replace(editor.document.lineAt(0).range, 'const one = 100;'));
  await lenses(first, 0);
  await editor.document.save();
  await lenses(first, 0);
  console.log('PASS manual typing and save do not create review prompts');

  await fs.writeFile(first.fsPath, 'const one = 10;\n// unchanged\nconst two = 20;\n');
  await fs.writeFile(second.fsPath, 'const three = 30;\n');
  let changes = await lenses(first, 2);
  await lenses(second, 1);
  console.log('PASS external edits create per-hunk review controls');

  const firstTarget = changes[0].command.arguments[0];
  await invoke('openPreview', changes[1].command.arguments[0]);
  const preview = vscode.window.activeTextEditor;
  assert.equal(preview.document.uri.scheme, 'aionic-inline-review');
  assert.match(preview.document.getText(), /const one = 100;\nconst one = 10;/);
  assert.match(preview.document.getText(), /const two = 2;\nconst two = 20;/);
  assert.equal(preview.selection.active.line, 3, 'preview opens at the selected hunk');
  console.log('PASS full removed/added lines and selected-hunk preview navigation');

  await invoke('accept', firstTarget);
  changes = await lenses(first, 1);
  assert.match(await fs.readFile(first.fsPath, 'utf8'), /const one = 10;/);
  await invoke('reject', changes[0].command.arguments[0]);
  editor = vscode.window.activeTextEditor;
  assert.equal(editor.document.getText(), 'const one = 10;\n// unchanged\nconst two = 2;\n');
  await lenses(first, 0);
  console.log('PASS partial accept and reject preserve accepted content');

  if (nativeUndoAvailable) {
    await vscode.commands.executeCommand('undo');
    await lenses(first, 1);
    console.log('PASS rejection is undoable');
  } else {
    console.log(
      'SKIP native Undo: command also failed in the unrelated control buffer; verify manually',
    );
    await editor.document.save();
    await fs.writeFile(first.fsPath, 'const one = 10;\n// unchanged\nconst two = 20;\n');
  }
  await lenses(first, 1);
  editor.selection = new vscode.Selection(2, 0, 2, 0);
  await invoke('nextChange');
  assert.equal(vscode.window.activeTextEditor.document.uri.toString(), second.toString());
  await invoke('previousFile');
  assert.equal(vscode.window.activeTextEditor.document.uri.toString(), first.toString());
  console.log('PASS next change and previous file navigation');

  editor = vscode.window.activeTextEditor;
  changes = await lenses(first, 1);
  await invoke('openPreview', changes[0].command.arguments[0]);
  const livePreview = vscode.window.activeTextEditor.document;
  editor = await vscode.window.showTextDocument(first);
  await editor.edit(edit => edit.replace(editor.document.lineAt(0).range, 'const one = 300;'));
  await lenses(first, 1);
  await vscode.window.showTextDocument(livePreview);
  await eventually(() => livePreview.getText().includes('const one = 300;'));
  editor = await vscode.window.showTextDocument(first);
  console.log('PASS manual edits preserve unrelated pending changes and update the preview');
  changes = await lenses(first, 1);
  await invoke('reject', changes[0].command.arguments[0]);
  await lenses(first, 0);
  assert.equal(editor.document.getText(), 'const one = 300;\n// unchanged\nconst two = 2;\n');
  console.log('PASS rejecting external changes preserves manual edits');
  await vscode.window.showTextDocument(second);
  await invoke('acceptFile');
  await lenses(second, 0);
  console.log('PASS file acceptance');
  console.log('AIONIC_INLINE_REVIEW_SMOKE_PASSED');
};
