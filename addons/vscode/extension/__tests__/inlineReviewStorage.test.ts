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
