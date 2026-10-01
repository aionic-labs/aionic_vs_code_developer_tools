import * as vscode from 'vscode';
import {PendingFilesPicker} from '../inlineReview/PendingFilesPicker';
import {ReviewFile} from '../inlineReview/ReviewFile';

jest.mock('vscode', () => jest.requireActual('../../__mocks__/vscode'));

type Item = vscode.QuickPickItem & {key: string};
let files: Map<string, ReviewFile>;
let changed: Set<() => void>;
let accept: () => void;
let hide: () => void;
let view: vscode.QuickPick<Item>;
let picker: PendingFilesPicker;
const open = jest.fn();
const first = 'file:///workspace/first.ts';
const second = 'file:///workspace/closed.ts';

function notify() {
  changed.forEach(listener => listener());
}

beforeEach(() => {
  jest.clearAllMocks();
  files = new Map([
    [first, new ReviewFile('old', 'new')],
    [second, new ReviewFile('before', 'after')],
  ]);
  changed = new Set();
  view = {
    items: [],
    activeItems: [],
    selectedItems: [],
    show: jest.fn(),
    dispose: jest.fn(),
    onDidAccept: (listener: () => void) => {
      accept = listener;
      return new vscode.Disposable(jest.fn());
    },
    onDidHide: (listener: () => void) => {
      hide = listener;
      return new vscode.Disposable(jest.fn());
    },
  } as unknown as vscode.QuickPick<Item>;
  (vscode.window.createQuickPick as jest.Mock).mockReturnValue(view);
  (vscode.workspace.asRelativePath as jest.Mock).mockImplementation((uri: vscode.Uri) => uri.path);
  picker = new PendingFilesPicker(
    {
      get pending(): Array<[string, ReviewFile]> {
        return [...files].filter(([, file]) => file.pending);
      },
      onDidChange: listener => {
        changed.add(listener);
        return new vscode.Disposable(() => changed.delete(listener));
      },
    },
    open,
  );
});

afterEach(() => picker.dispose());

it('returns immediately and only lists files with pending changes, including closed files', () => {
  files.get(first)!.acceptAll();
  expect(files.get(first)!.canUndoAccept).toBe(true);
  expect(picker.show()).toBeUndefined();
  expect(view.items.map(item => item.key)).toEqual([second]);
  expect(view.title).toBe('Unreviewed files (1)');
});

it('removes accepted files live and adds them back only when acceptance is undone', () => {
  picker.show();
  files.get(first)!.acceptAll();
  notify();
  expect(view.items.map(item => item.key)).toEqual([second]);
  files.get(second)!.acceptAll();
  notify();
  expect(view.items).toEqual([]);
  expect(view.title).toBe('Unreviewed files (0)');
  expect(view.placeholder).toBe('No unreviewed changes.');
  files.get(first)!.undoAccept();
  notify();
  expect(view.items.map(item => item.key)).toEqual([first]);
});

it('removes rejected changes and includes genuinely new edits to an accepted file', () => {
  picker.show();
  files.get(first)!.acceptAll();
  files.get(second)!.update('before');
  notify();
  expect(view.items).toHaveLength(0);
  files.get(first)!.update('another edit');
  notify();
  expect(view.items.map(item => item.key)).toEqual([first]);
});

it('does not reopen a stale selection after its changes are accepted', () => {
  picker.show();
  Object.assign(view, {selectedItems: [view.items[0]]});
  files.get(first)!.acceptAll();
  accept();
  expect(open).not.toHaveBeenCalled();
  expect(view.items.map(item => item.key)).toEqual([second]);
});

it('opens only the selected pending file and cleans up its listeners', () => {
  picker.show();
  Object.assign(view, {selectedItems: [view.items[1]]});
  accept();
  expect(open).toHaveBeenCalledWith(second);
  expect(changed.size).toBe(0);
  expect(view.dispose).toHaveBeenCalledTimes(1);
});

it('reuses an open list and releases listeners on dismiss', () => {
  picker.show();
  picker.show();
  expect(vscode.window.createQuickPick).toHaveBeenCalledTimes(1);
  expect(changed.size).toBe(1);
  hide();
  expect(changed.size).toBe(0);
  expect(view.dispose).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
});

it('does not show accepted files when reopening the list', () => {
  files.forEach(file => file.acceptAll());
  picker.show();
  expect(vscode.window.createQuickPick).not.toHaveBeenCalled();
  expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('No unreviewed changes.');
});
