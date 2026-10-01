import type {Logger} from 'isl-server/src/logger';

import * as vscode from 'vscode';
import {StaleReviewError} from '../inlineReview/ReviewFile';
import {ReviewSession} from '../inlineReview/ReviewSession';

jest.mock('vscode', () => {
  const base = jest.requireActual('../../__mocks__/vscode');
  return {
    ...base,
    FileType: {File: 1, Directory: 2, SymbolicLink: 64},
    FileSystemError: class extends Error {
      code = 'FileNotFound';
    },
    EventEmitter: class {
      event = jest.fn(() => new base.Disposable());
      fire = jest.fn();
      dispose = jest.fn();
    },
  };
});

const uri = vscode.Uri.file('/workspace/example.ts');
const disk = new Map<string, string>();
let stored: unknown;
let session: ReviewSession;
let textChanged: (event: vscode.TextDocumentChangeEvent) => void;
let diskChanged: (uri: vscode.Uri) => void;
const update = jest.fn((_key: string, value: unknown) => {
  stored = value;
  return Promise.resolve();
});
const context = {workspaceState: {get: () => stored, update}} as unknown as vscode.ExtensionContext;
const logger = {warn: jest.fn()} as unknown as Logger;

function document(content: string): vscode.TextDocument {
  return {uri, isDirty: true, getText: () => content} as vscode.TextDocument;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve(); // eslint-disable-line no-await-in-loop
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  stored = undefined;
  disk.clear();
  disk.set(uri.toString(), 'original\n');
  Object.assign(vscode.workspace, {
    isTrusted: true,
    textDocuments: [],
    getConfiguration: () => ({get: (_key: string, fallback: boolean) => fallback}),
    getWorkspaceFolder: (candidate: vscode.Uri) =>
      candidate.path.startsWith('/workspace/') ? {uri: vscode.Uri.file('/workspace')} : undefined,
    findFiles: jest.fn(() => Promise.resolve([...disk.keys()].map(key => vscode.Uri.parse(key)))),
    createFileSystemWatcher: () => ({
      dispose: jest.fn(),
      onDidCreate: jest.fn(() => new vscode.Disposable(jest.fn())),
      onDidDelete: jest.fn(() => new vscode.Disposable(jest.fn())),
      onDidChange: (listener: typeof diskChanged) => {
        diskChanged = listener;
        return new vscode.Disposable(jest.fn());
      },
    }),
    onDidChangeTextDocument: (listener: typeof textChanged) => {
      textChanged = listener;
      return new vscode.Disposable(jest.fn());
    },
    fs: {
      stat: jest.fn((candidate: vscode.Uri) => {
        const content = disk.get(candidate.toString());
        if (content == null) {
          return Promise.reject(new vscode.FileSystemError());
        }
        return Promise.resolve({type: vscode.FileType.File, size: Buffer.byteLength(content)});
      }),
      readFile: jest.fn((candidate: vscode.Uri) =>
        Promise.resolve(Buffer.from(disk.get(candidate.toString()) ?? '')),
      ),
    },
  });
  session = new ReviewSession(context, logger);
});

afterEach(async () => {
  session.dispose();
  await settle();
  jest.useRealTimers();
});

it('snapshots existing edits as the baseline, then tracks an external write', async () => {
  await session.initialize();
  expect(session.pending).toEqual([]);
  disk.set(uri.toString(), 'external edit\n');
  diskChanged(uri);
  await settle();
  expect(session.pending).toHaveLength(1);
  expect(session.files.get(uri.toString())?.baseline).toBe('original\n');
  expect(session.files.get(uri.toString())?.current).toBe('external edit\n');
});

it('tracks unsaved editor changes and prefers them over disk', async () => {
  await session.initialize();
  const dirty = document('unsaved\n');
  Object.assign(vscode.workspace, {textDocuments: [dirty]});
  textChanged({document: dirty} as vscode.TextDocumentChangeEvent);
  disk.set(uri.toString(), 'disk edit\n');
  const file = await session.reviewable(uri);
  expect(file.current).toBe('unsaved\n');
  expect(file.baseline).toBe('original\n');
});

it('does not let an earlier disk read overwrite a newer editor event', async () => {
  await session.initialize();
  let finishRead!: (bytes: Uint8Array) => void;
  jest.mocked(vscode.workspace.fs.readFile).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishRead = resolve;
      }),
  );
  const pending = session.refresh(uri);
  await settle();
  const dirty = document('latest typing\n');
  Object.assign(vscode.workspace, {textDocuments: [dirty]});
  textChanged({document: dirty} as vscode.TextDocumentChangeEvent);
  finishRead(Buffer.from('stale disk\n'));
  await pending;
  expect(session.files.get(uri.toString())?.current).toBe('latest typing\n');
});

it('persists accepted baselines and preserves unaccepted changes across reloads', async () => {
  await session.initialize();
  disk.set(uri.toString(), 'accepted\n');
  const file = await session.reviewable(uri);
  file.acceptAll();
  session.notify();
  jest.advanceTimersByTime(400);
  await settle();
  session.dispose();
  await settle();
  disk.set(uri.toString(), 'unaccepted\n');
  session = new ReviewSession(context, logger);
  await session.initialize();
  expect(session.files.get(uri.toString())?.baseline).toBe('accepted\n');
  expect(session.files.get(uri.toString())?.current).toBe('unaccepted\n');
  expect(session.pending).toHaveLength(1);
});

it('does not read files or overwrite saved state in an untrusted workspace', async () => {
  Object.assign(vscode.workspace, {isTrusted: false});
  stored = {tracking: true, files: [{uri: uri.toString(), baseline: 'saved'}]};
  await session.initialize();
  session.dispose();
  await settle();
  expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
  expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

it('honors disabled automatic tracking', async () => {
  Object.assign(vscode.workspace, {getConfiguration: () => ({get: () => false})});
  await session.initialize();
  expect(session.tracking).toBe(false);
  expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
  await session.start();
  expect(session.tracking).toBe(true);
});

it('tracks file creation, including empty files, and deletion', async () => {
  await session.initialize();
  const created = vscode.Uri.file('/workspace/new.ts');
  disk.set(created.toString(), '');
  expect((await session.reviewable(created)).baseline).toBeNull();
  disk.delete(uri.toString());
  expect((await session.reviewable(uri)).current).toBeNull();
  expect(session.pending).toHaveLength(2);
});

it('ignores excluded directories and files outside this workspace', async () => {
  await session.initialize();
  for (const path of ['/workspace/node_modules/x.js', '/elsewhere/x.ts']) {
    const other = vscode.Uri.file(path);
    disk.set(other.toString(), 'x');
    expect(await session.refresh(other)).toBeUndefined(); // eslint-disable-line no-await-in-loop
  }
  expect(session.files.size).toBe(1);
});

it('never rejects using an outdated snapshot while the file is unreadable', async () => {
  await session.initialize();
  disk.set(uri.toString(), 'changed\n');
  const file = await session.reviewable(uri);
  const target = file.hunks[0];
  disk.set(uri.toString(), '\0binary');
  await expect(session.reviewable(uri)).rejects.toThrow('cannot currently be reviewed');
  expect(session.pending).toHaveLength(0);
  disk.set(uri.toString(), 'changed\n');
  await session.refresh(uri);
  expect(() => file.resolve(target.revision, target.index)).toThrow(StaleReviewError);
  expect(session.pending).toHaveLength(1);
});

it('refuses files that grow beyond the text-file limit', async () => {
  await session.initialize();
  disk.set(uri.toString(), 'x'.repeat(512 * 1024 + 1));
  await expect(session.reviewable(uri)).rejects.toThrow('cannot currently be reviewed');
  expect(session.files.get(uri.toString())?.baseline).toBe('original\n');
});

it('bounds total snapshot memory when an existing file grows', async () => {
  disk.clear();
  for (let i = 0; i < 17; i++) {
    disk.set(vscode.Uri.file(`/workspace/${i}.ts`).toString(), 'x'.repeat(480 * 1024));
  }
  await session.initialize();
  expect(session.files.size).toBe(17);
  const first = vscode.Uri.file('/workspace/0.ts');
  const second = vscode.Uri.file('/workspace/1.ts');
  disk.set(first.toString(), 'x'.repeat(512 * 1024));
  await session.reviewable(first);
  disk.set(second.toString(), 'x'.repeat(512 * 1024));
  await expect(session.reviewable(second)).rejects.toThrow('cannot currently be reviewed');
});

it('resumes without acknowledging pending changes', async () => {
  await session.initialize();
  disk.set(uri.toString(), 'pending\n');
  await session.refresh(uri);
  session.pause();
  await session.start();
  expect(session.files.get(uri.toString())?.baseline).toBe('original\n');
  expect(session.pending).toHaveLength(1);
});

it('refuses partial acceptance that would create an oversized intermediate baseline', async () => {
  const original = 'a'.repeat(300 * 1024) + '\nstable\n';
  disk.set(uri.toString(), original);
  await session.initialize();
  disk.set(uri.toString(), 'stable\n' + 'b'.repeat(300 * 1024) + '\n');
  const file = await session.reviewable(uri);
  const insertion = file.hunks.find(hunk => hunk.added.length > 0 && hunk.removed.length === 0);
  expect(insertion).toBeDefined();
  expect(() => session.accept(uri, insertion!.revision, insertion!.index)).toThrow(
    'snapshot limit',
  );
  expect(file.baseline).toBe(original);
  const deletion = file.hunks[0];
  session.accept(uri, deletion.revision, deletion.index);
  const remaining = file.hunks[0];
  session.accept(uri, remaining.revision, remaining.index);
  expect(file.pending).toBe(false);
});
