import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import {ReviewFile} from '../inlineReview/ReviewFile';
import {SnapshotStore} from '../inlineReview/SnapshotStore';
import {SourceFiles} from '../inlineReview/SourceFiles';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aionic-review-storage-'));
  Object.assign(vscode.workspace, {
    workspaceFolders: [{uri: vscode.Uri.file(root)}],
    getWorkspaceFolder: () => ({uri: vscode.Uri.file(root)}),
  });
});
afterEach(async () => {
  await rm(root, {recursive: true, force: true});
});

it('keeps baselines on disk and retains manual and partial review edits after offloading', async () => {
  const store = new SnapshotStore(path.join(root, 'snapshots'));
  const file = new ReviewFile('a\nkeep\nb\n');
  const hash = await file.saveBaseline(store);
  expect(hash).toMatch(/^[a-f0-9]{64}$/);
  const restored = new ReviewFile(store.load(hash!));
  expect(restored.pending).toBe(false);
  restored.update('A\nkeep\nB\n');
  expect(restored.hunks).toHaveLength(2);
  const first = restored.hunks[0];
  restored.accept(first.revision, first.index);
  await restored.saveBaseline(store);
  const last = restored.hunks[0];
  restored.update(restored.rejectedContent(last.revision, last.index));
  expect(restored.current).toBe('A\nkeep\nb\n');
  expect(restored.pending).toBe(false);
  await restored.saveBaseline(store);
  expect(
    restored.editorBaseline('A\nkeep\nmanual\n', [
      {rangeOffset: 7, rangeLength: 1, text: 'manual'},
    ]),
  ).toBe('A\nkeep\nmanual\n');
});

it('enumerates a nested repository including tracked build sources and excludes ignored output', async () => {
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'build'), {recursive: true});
  await mkdir(path.join(root, '.tools'), {recursive: true});
  execFileSync('git', ['init', repo]);
  await writeFile(path.join(repo, '.gitignore'), 'build/\n*.generated\nnode_modules/\n');
  await writeFile(path.join(repo, 'build', 'source.py'), 'print("source")');
  execFileSync('git', ['-C', repo, 'add', '-f', 'build/source.py']);
  await writeFile(path.join(repo, 'build', 'output.js'), 'generated output');
  await writeFile(path.join(repo, 'new.ts'), 'new source');
  await writeFile(path.join(repo, 'skip.generated'), 'generated output');
  await writeFile(path.join(root, '.tools', 'tool.py'), 'unrelated tool');
  const sources = new SourceFiles();
  const found = (await sources.discover()).map(uri => path.relative(root, uri.fsPath)).sort();
  expect(found).toEqual(['repo/.gitignore', 'repo/build/source.py', 'repo/new.ts']);
  expect(await sources.includes(vscode.Uri.file(path.join(repo, 'later.ts')))).toBe(true);
  expect(await sources.includes(vscode.Uri.file(path.join(repo, 'later.generated')))).toBe(false);
  expect(await sources.includes(vscode.Uri.file(path.join(repo, 'build', 'source.py')))).toBe(true);
});

it('recovers the committed text for a nested file without changing the index or worktree', async () => {
  execFileSync('git', ['init', root]);
  await mkdir(path.join(root, 'nested space'));
  const uri = vscode.Uri.file(path.join(root, 'nested space', 'source.ts'));
  const before = 'const first = 1;\n// same\nconst last = 3;\n';
  await writeFile(uri.fsPath, before);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', [
    '-C',
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'baseline',
  ]);
  const after = 'const first = 10;\n// same\nconst last = 30;\n';
  await writeFile(uri.fsPath, after);
  // Even staged changes must be compared with the commit, not accepted accidentally.
  execFileSync('git', ['-C', root, 'add', '.']);
  const status = execFileSync('git', ['-C', root, 'status', '--porcelain']);
  const sources = new SourceFiles();
  const baseline = await sources.committedBaseline(uri);
  expect(baseline).toBe(before);
  const file = new ReviewFile(null, after);
  file.recoverBaseline(baseline);
  expect(file.hunks).toHaveLength(2);
  const first = file.hunks[0];
  file.accept(first.revision, first.index);
  const last = file.hunks[0];
  expect(file.rejectedContent(last.revision, last.index)).toBe(
    'const first = 10;\n// same\nconst last = 3;\n',
  );
  expect(execFileSync('git', ['-C', root, 'status', '--porcelain'])).toEqual(status);
  expect(
    await sources.committedBaseline(vscode.Uri.file(path.join(root, 'new.ts'))),
  ).toBeUndefined();
});
