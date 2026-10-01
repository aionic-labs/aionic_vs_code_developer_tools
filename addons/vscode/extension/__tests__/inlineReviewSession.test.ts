import type {Logger} from 'isl-server/src/logger';

import * as vscode from 'vscode';
import {StaleReviewError} from '../inlineReview/ReviewFile';
import {ReviewSession} from '../inlineReview/ReviewSession';

jest.mock('../inlineReview/SourceFiles', () => ({
  SourceFiles: class {
    discover() {
      return vscode.workspace.findFiles('**/*');
    }
    includes(uri: vscode.Uri) {
      return Promise.resolve(
        !uri.path.includes('/node_modules/') && !uri.path.includes('/.tools/'),
      );
    }
  },
}));

jest.mock('../inlineReview/SnapshotStore', () => {
  const blobs = new Map<string, string>();
  class Snapshot {
    constructor(readonly hash: string) {}
    read() {
      return blobs.get(this.hash)!;
    }
    matches(text: string) {
      return text === this.read();
    }
  }
  return {
    Snapshot,
    SnapshotStore: class {
      save(text: string) {
        const hash = require('node:crypto').createHash('sha256').update(text).digest('hex');
        blobs.set(hash, text);
        return Promise.resolve(new Snapshot(hash));
      }
      load(hash: string) {
        return new Snapshot(hash);
      }
    },
  };
});

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
let storedKey = 'aionic.inlineReview.session.v1';
let session: ReviewSession;
let textChanged: (event: vscode.TextDocumentChangeEvent) => void;
let diskChanged: (uri: vscode.Uri) => void;
let documentOpened: (document: vscode.TextDocument) => void;
let enabled: boolean;
const update = jest.fn((_key: string, value: unknown) => {
  stored = value;
  storedKey = _key;
  return Promise.resolve();
});
const context = {
  storageUri: vscode.Uri.file('/test-snapshots'),
  workspaceState: {get: (key: string) => (key === storedKey ? stored : undefined), update},
} as unknown as vscode.ExtensionContext;
const logger = {warn: jest.fn(), info: jest.fn()} as unknown as Logger;

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
  enabled = true;
  storedKey = 'aionic.inlineReview.session.v1';
  disk.clear();
  disk.set(uri.toString(), 'original\n');
  Object.assign(vscode.workspace, {
    isTrusted: true,
    textDocuments: [],
    getConfiguration: () => ({
      get: (_key: string, fallback: boolean) =>
        _key === 'inlineReview.enabled' ? enabled : fallback,
    }),
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
    onDidOpenTextDocument: (listener: typeof documentOpened) => {
      documentOpened = listener;
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
  await session.flush();
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

it('does not discover or track files when disabled at startup', async () => {
  enabled = false;
  await session.initialize();
  expect(session.isEnabled).toBe(false);
  expect(session.tracking).toBe(false);
  expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
  diskChanged(uri);
  documentOpened(document('editor edit\n'));
  await settle();
  expect(session.files.size).toBe(0);
  await expect(session.start()).rejects.toThrow('Enable sapling.inlineReview.enabled');
});

it('disables immediately and resumes pending review from preserved baselines', async () => {
  await session.initialize();
  disk.set(uri.toString(), 'pending\n');
  await session.refresh(uri);
  enabled = false;
  await session.updateConfiguration();
  expect(session.pending).toHaveLength(0);
  expect(session.tracking).toBe(false);
  disk.set(uri.toString(), 'while disabled\n');
  diskChanged(uri);
  textChanged({
    document: document('manual\n'),
    reason: undefined,
    contentChanges: [
      {
        range: {start: {line: 0, character: 0}, end: {line: 1, character: 0}} as vscode.Range,
        rangeOffset: 0,
        rangeLength: 8,
        text: 'manual\n',
      },
    ],
  } as vscode.TextDocumentChangeEvent);
  await settle();
  expect(session.files.get(uri.toString())?.current).toBe('pending\n');
  expect(session.files.get(uri.toString())?.baseline).toBe('original\n');
  enabled = true;
  await session.updateConfiguration();
  expect(session.tracking).toBe(true);
  expect(session.pending).toHaveLength(1);
  expect(session.files.get(uri.toString())?.current).toBe('while disabled\n');
  expect(session.files.get(uri.toString())?.baseline).toBe('original\n');
});

it('keeps the disabled setting effective across reloads without refreshing snapshots', async () => {
  await session.initialize();
  enabled = false;
  await session.updateConfiguration();
  session.dispose();
  await session.flush();
  disk.set(uri.toString(), 'offline\n');
  session = new ReviewSession(context, logger);
  await session.initialize();
  expect(session.isEnabled).toBe(false);
  expect(session.tracking).toBe(false);
  expect(session.pending).toHaveLength(0);
  expect(session.files.get(uri.toString())?.baseline).toBe('original\n');
  enabled = true;
  await session.updateConfiguration();
  expect(session.pending).toHaveLength(1);
  expect(session.files.get(uri.toString())?.current).toBe('offline\n');
});

it('resumes automatically after enabling the setting before a reload', async () => {
  await session.initialize();
  enabled = false;
  await session.updateConfiguration();
  session.dispose();
  await session.flush();
  disk.set(uri.toString(), 'offline\n');
  enabled = true;
  session = new ReviewSession(context, logger);
  await session.initialize();
  expect(session.tracking).toBe(true);
  expect(session.pending).toHaveLength(1);
});

it('enables tracking after a first disabled session is reloaded with the setting enabled', async () => {
  enabled = false;
  await session.initialize();
  session.dispose();
  await session.flush();
  enabled = true;
  session = new ReviewSession(context, logger);
  await session.initialize();
  expect(session.tracking).toBe(true);
  expect(session.files.size).toBe(1);
});

it('tracks open files even when the bounded workspace search omits them', async () => {
  const open = {...document('original\n'), isDirty: false};
  Object.assign(vscode.workspace, {textDocuments: [open]});
  jest.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
  await session.initialize();
  expect(session.files.has(uri.toString())).toBe(true);
  expect(session.pending).toHaveLength(0);
  disk.set(uri.toString(), 'external\n');
  await session.refresh(uri);
  expect(session.pending).toHaveLength(1);
});

it('snapshots a newly opened file instead of treating all of it as a new external file', async () => {
  jest.mocked(vscode.workspace.findFiles).mockResolvedValue([]);
  await session.initialize();
  const open = {...document('original\n'), isDirty: false};
  Object.assign(vscode.workspace, {textDocuments: [open]});
  documentOpened(open);
  await settle();
  expect(session.files.get(uri.toString())?.baseline).toBe('original\n');
  expect(session.pending).toHaveLength(0);
});

it('adds an open file beyond the previous memory limit without evicting any file', async () => {
  const quiet = vscode.Uri.file('/workspace/quiet.txt');
  const pending = vscode.Uri.file('/workspace/pending.txt');
  const alsoOpen = vscode.Uri.file('/workspace/open.txt');
  disk.clear();
  for (let i = 0; i < 13; i++) {
    disk.set(vscode.Uri.file(`/workspace/fill-${i}.txt`).toString(), 'x'.repeat(512 * 1024));
  }
  for (const candidate of [quiet, pending, alsoOpen]) {
    disk.set(candidate.toString(), 'x'.repeat(512 * 1024));
  }
  await session.initialize();
  disk.set(pending.toString(), 'pending external change');
  await session.refresh(pending);
  disk.set(uri.toString(), 'new editor contents');
  const open = {...document('new editor contents'), isDirty: false};
  Object.assign(vscode.workspace, {textDocuments: [open, {uri: alsoOpen, isDirty: false}]});
  documentOpened(open);
  // Includes an extra asynchronous disk read to verify the eviction candidate.
  await settle();
  await settle();
  expect(session.files.get(uri.toString())?.baseline).toBe('new editor contents');
  expect(session.files.has(pending.toString())).toBe(true);
  expect(session.files.has(alsoOpen.toString())).toBe(true);
  expect(session.files.size).toBe(17);
  expect(session.pending).toHaveLength(1);
});

it('acknowledges unsaved editor changes and prefers them over disk', async () => {
  await session.initialize();
  const dirty = document('unsaved\n');
  Object.assign(vscode.workspace, {textDocuments: [dirty]});
  textChanged({
    document: dirty,
    contentChanges: [{rangeOffset: 0, rangeLength: 9, text: dirty.getText()}],
  } as unknown as vscode.TextDocumentChangeEvent);
  disk.set(uri.toString(), 'disk edit\n');
  const file = await session.reviewable(uri);
  expect(file.current).toBe('unsaved\n');
  expect(file.baseline).toBe('unsaved\n');
  expect(session.pending).toHaveLength(0);
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
  textChanged({
    document: dirty,
    contentChanges: [{rangeOffset: 0, rangeLength: 9, text: dirty.getText()}],
  } as unknown as vscode.TextDocumentChangeEvent);
  finishRead(Buffer.from('stale disk\n'));
  await pending;
  expect(session.files.get(uri.toString())?.current).toBe('latest typing\n');
});

it('keeps clean document reloads reviewable, even before the watcher fires', async () => {
  await session.initialize();
  const clean = {...document('external\n'), isDirty: false};
  textChanged({
    document: clean,
    contentChanges: [{rangeOffset: 0, rangeLength: 9, text: 'external\n'}],
  } as unknown as vscode.TextDocumentChangeEvent);
  expect(session.pending).toHaveLength(1);
  expect(session.files.get(uri.toString())?.baseline).toBe('original\n');
});

it('handles VS Code reporting typing before its separate dirty-state event', async () => {
  await session.initialize();
  const doc = {...document('typed\n'), isDirty: false};
  textChanged({
    document: doc,
    contentChanges: [{rangeOffset: 0, rangeLength: 9, text: 'typed\n'}],
  } as unknown as vscode.TextDocumentChangeEvent);
  doc.isDirty = true;
  textChanged({document: doc, contentChanges: []} as unknown as vscode.TextDocumentChangeEvent);
  expect(session.pending).toHaveLength(0);
  expect(session.files.get(uri.toString())?.baseline).toBe('typed\n');
});

it('does not recreate review prompts when manual edits are saved', async () => {
  await session.initialize();
  const dirty = document('manual\n');
  Object.assign(vscode.workspace, {textDocuments: [dirty]});
  textChanged({
    document: dirty,
    contentChanges: [{rangeOffset: 0, rangeLength: 9, text: 'manual\n'}],
  } as unknown as vscode.TextDocumentChangeEvent);
  disk.set(uri.toString(), 'manual\n');
  Object.assign(vscode.workspace, {textDocuments: []});
  diskChanged(uri);
  await settle();
  expect(session.pending).toHaveLength(0);
  disk.set(uri.toString(), 'next external\n');
  diskChanged(uri);
  await settle();
  expect(session.pending).toHaveLength(1);
  expect(session.files.get(uri.toString())?.baseline).toBe('manual\n');
});

it('preserves the baseline during Reject and Undo/Redo of the rejection', async () => {
  await session.initialize();
  disk.set(uri.toString(), 'external\n');
  await session.refresh(uri);
  const change = (text: string, length: number, reason?: number) => {
    const doc = document(text);
    Object.assign(vscode.workspace, {textDocuments: [doc]});
    textChanged({
      document: doc,
      reason,
      contentChanges: [{rangeOffset: 0, rangeLength: length, text}],
    } as unknown as vscode.TextDocumentChangeEvent);
  };
  await session.applyReviewEdit(uri, () => {
    change('original\n', 9);
    return Promise.resolve(true);
  });
  expect(session.pending).toHaveLength(0);
  change('external\n', 9, 1);
  expect(session.pending).toHaveLength(1);
  expect(session.files.get(uri.toString())?.baseline).toBe('original\n');
  change('original\n', 9, 2);
  expect(session.pending).toHaveLength(0);
});

it('acknowledges manual Undo without producing a review prompt', async () => {
  await session.initialize();
  textChanged({
    document: document('typed\n'),
    contentChanges: [{rangeOffset: 0, rangeLength: 9, text: 'typed\n'}],
  } as unknown as vscode.TextDocumentChangeEvent);
  textChanged({
    document: document('original\n'),
    reason: 1,
    contentChanges: [{rangeOffset: 0, rangeLength: 6, text: 'original\n'}],
  } as unknown as vscode.TextDocumentChangeEvent);
  expect(session.pending).toHaveLength(0);
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

it('starts discovery when the disabled setting is enabled at runtime', async () => {
  enabled = false;
  await session.initialize();
  expect(session.tracking).toBe(false);
  expect(vscode.workspace.findFiles).not.toHaveBeenCalled();
  enabled = true;
  await session.updateConfiguration();
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

it('tracks source files larger than the old 512 KiB limit', async () => {
  await session.initialize();
  disk.set(uri.toString(), 'x'.repeat(512 * 1024 + 1));
  expect((await session.reviewable(uri)).pending).toBe(true);
  expect(session.files.get(uri.toString())?.baseline).toBe('original\n');
});

it('tracks changes beyond the former total snapshot limit', async () => {
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
  expect((await session.reviewable(second)).pending).toBe(true);
  expect(session.files.size).toBe(17);
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

it('allows partial acceptance beyond the previous intermediate-baseline limit', async () => {
  const original = 'a'.repeat(300 * 1024) + '\nstable\n';
  disk.set(uri.toString(), original);
  await session.initialize();
  disk.set(uri.toString(), 'stable\n' + 'b'.repeat(300 * 1024) + '\n');
  const file = await session.reviewable(uri);
  const insertion = file.hunks.find(hunk => hunk.added.length > 0 && hunk.removed.length === 0);
  expect(insertion).toBeDefined();
  session.accept(uri, insertion!.revision, insertion!.index);
  expect(file.baseline!.length).toBeGreaterThan(512 * 1024);
  const deletion = file.hunks[0];
  session.accept(uri, deletion.revision, deletion.index);
  expect(file.pending).toBe(false);
});

it('tracks every file beyond 2,000 and preserves coverage across reloads', async () => {
  disk.clear();
  for (let i = 0; i < 2501; i++) {
    disk.set(vscode.Uri.file(`/workspace/source-${i}.ts`).toString(), `export const n = ${i};\n`);
  }
  await session.initialize();
  expect(session.files.size).toBe(2501);
  const last = vscode.Uri.file('/workspace/source-2500.ts');
  disk.set(last.toString(), 'external edit\n');
  await session.refresh(last);
  expect(session.pending).toHaveLength(1);
  await session.flush();
  expect(JSON.stringify(stored)).not.toContain('export const');
  session.dispose();
  await session.flush();
  session = new ReviewSession(context, logger);
  await session.initialize();
  expect(session.files.size).toBe(2501);
  expect(session.pending).toHaveLength(1);
  expect(session.files.get(last.toString())?.baseline).toBe('export const n = 2500;\n');
});

it('migrates legacy baselines without accepting pending edits', async () => {
  stored = {tracking: true, files: [{uri: uri.toString(), baseline: 'legacy\n'}]};
  await session.initialize();
  expect(session.files.get(uri.toString())?.baseline).toBe('legacy\n');
  expect(session.pending).toHaveLength(1);
  await session.flush();
  expect(storedKey).toBe('aionic.inlineReview.session.v2');
  expect(JSON.stringify(stored)).not.toContain('legacy');
});
