import * as vscode from 'vscode';
import {reviewAllFiles} from '../inlineReview/BulkReview';
import {ReviewFile} from '../inlineReview/ReviewFile';

jest.mock('vscode', () => jest.requireActual('../../__mocks__/vscode'));

const first = vscode.Uri.file('/workspace/first.ts').toString();
const closed = vscode.Uri.file('/workspace/closed.ts').toString();
let files: Map<string, ReviewFile>;
const session = {
  get pending(): Array<[string, ReviewFile]> {
    return [...files].filter(([, file]) => file.pending);
  },
  reviewable: jest.fn((uri: vscode.Uri) => Promise.resolve(files.get(uri.toString())!)),
  notify: jest.fn(),
};
const reject = jest.fn((uri: vscode.Uri, _target: unknown, baseline: string | null) => {
  files.get(uri.toString())!.update(baseline);
  return Promise.resolve();
});
const confirm = vscode.window.showWarningMessage as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  files = new Map([
    [first, new ReviewFile('old first', 'new first')],
    [closed, new ReviewFile('old closed', 'new closed')],
  ]);
  session.reviewable.mockImplementation(uri => Promise.resolve(files.get(uri.toString())!));
  confirm.mockResolvedValue('Reject all changes');
});

it('accepts all files without writing contents and preserves per-file undo/redo', async () => {
  await reviewAllFiles(session, 'accept', reject);
  expect(session.pending).toHaveLength(0);
  expect(reject).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  for (const [key, original] of [
    [first, 'old first'],
    [closed, 'old closed'],
  ]) {
    const file = files.get(key)!;
    const current = file.current;
    file.undoAccept();
    expect(file.baseline).toBe(original);
    expect(file.current).toBe(current);
    file.redoAccept();
    expect(file.pending).toBe(false);
  }
});

it('rejects open and closed files after one confirmation', async () => {
  await reviewAllFiles(session, 'reject', reject);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(reject).toHaveBeenCalledTimes(2);
  expect(files.get(first)!.current).toBe('old first');
  expect(files.get(closed)!.current).toBe('old closed');
  expect(session.pending).toHaveLength(0);
});

it('does nothing when bulk rejection is cancelled', async () => {
  confirm.mockResolvedValue(undefined);
  await reviewAllFiles(session, 'reject', reject);
  expect(reject).not.toHaveBeenCalled();
  expect(session.reviewable).not.toHaveBeenCalled();
  expect(session.pending).toHaveLength(2);
});

it('preserves accepted hunks and manual baseline content during rejection', async () => {
  const file = new ReviewFile(
    'manual\nstable\nold\nstable\nlast\n',
    'manual\nstable\nNEW\nstable\nLAST\n',
  );
  files.set(first, file);
  const hunk = file.hunks[0];
  file.accept(hunk.revision, hunk.index);
  await reviewAllFiles(session, 'reject', reject);
  expect(file.current).toBe('manual\nstable\nNEW\nstable\nlast\n');
});

it('includes new and deleted files in the single bulk confirmation', async () => {
  files.set(first, new ReviewFile(null, 'new file'));
  files.set(closed, new ReviewFile('deleted file', null));
  await reviewAllFiles(session, 'reject', reject);
  expect(reject.mock.calls.map(([uri, , baseline]) => [uri.toString(), baseline])).toEqual([
    [first, null],
    [closed, 'deleted file'],
  ]);
  expect(confirm.mock.calls[0][1].detail).toMatch(/Newly created files will be deleted/);
});

it.each(['accept', 'reject'] as const)(
  'skips stale files during %s and completes the rest',
  async action => {
    session.reviewable.mockImplementation(uri => {
      const file = files.get(uri.toString())!;
      if (uri.toString() === first) {
        file.update('arrived during bulk action');
      }
      return Promise.resolve(file);
    });
    await reviewAllFiles(session, action, reject);
    expect(files.get(first)!.current).toBe('arrived during bulk action');
    expect(files.get(first)!.baseline).toBe('old first');
    expect(files.get(closed)!.pending).toBe(false);
    expect(vscode.window.showWarningMessage).toHaveBeenLastCalledWith(
      expect.stringContaining('1 files could not be completed'),
    );
  },
);

it('excludes new pending files discovered while confirmation is open', async () => {
  const later = vscode.Uri.file('/workspace/later.ts').toString();
  confirm.mockImplementationOnce(() => {
    files.set(later, new ReviewFile('old later', 'new later'));
    return Promise.resolve('Reject all changes');
  });
  await reviewAllFiles(session, 'reject', reject);
  expect(reject).toHaveBeenCalledTimes(2);
  expect(files.get(later)!.current).toBe('new later');
  expect(files.get(later)!.pending).toBe(true);
});

it('reports failed files without abandoning other files', async () => {
  session.reviewable.mockImplementation(uri => {
    if (uri.toString() === first) {
      return Promise.reject(new Error('Cannot read file'));
    }
    return Promise.resolve(files.get(uri.toString())!);
  });
  await reviewAllFiles(session, 'reject', reject);
  expect(reject).toHaveBeenCalledTimes(1);
  expect(files.get(first)!.current).toBe('new first');
  expect(files.get(closed)!.current).toBe('old closed');
  expect(vscode.window.showWarningMessage).toHaveBeenLastCalledWith(
    expect.stringContaining('Cannot read file'),
  );
});

it('handles an empty review without showing a destructive confirmation', async () => {
  files.clear();
  await reviewAllFiles(session, 'reject', reject);
  expect(confirm).not.toHaveBeenCalled();
  expect(reject).not.toHaveBeenCalled();
  expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('No unreviewed changes.');
});
