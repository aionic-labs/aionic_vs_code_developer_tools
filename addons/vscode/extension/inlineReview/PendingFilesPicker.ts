import type {ReviewSession} from './ReviewSession';

import * as vscode from 'vscode';

type PendingItem = vscode.QuickPickItem & {key: string};

/** A live view of pending decisions, independent of the serialized review-action queue. */
export class PendingFilesPicker implements vscode.Disposable {
  private picker?: vscode.QuickPick<PendingItem>;
  private listeners: vscode.Disposable[] = [];

  constructor(
    private readonly session: Pick<ReviewSession, 'pending' | 'onDidChange'>,
    private readonly open: (key: string) => void,
  ) {}

  show(): void {
    if (this.picker != null) {
      this.update();
      this.picker.show();
      return;
    }
    if (this.session.pending.length === 0) {
      void vscode.window.showInformationMessage('No unreviewed changes.');
      return;
    }
    const picker = vscode.window.createQuickPick<PendingItem>();
    this.picker = picker;
    this.listeners = [
      this.session.onDidChange(() => this.update()),
      picker.onDidHide(() => this.dispose()),
      picker.onDidAccept(() => {
        const selected = picker.selectedItems[0];
        // A selection can outlive its item when a review action completes.
        if (selected != null && this.session.pending.some(([key]) => key === selected.key)) {
          this.dispose();
          this.open(selected.key);
        } else {
          this.update();
        }
      }),
    ];
    this.update();
    picker.show();
  }

  private update(): void {
    const picker = this.picker;
    if (picker == null) {
      return;
    }
    const activeKey = picker.activeItems[0]?.key;
    picker.items = this.session.pending.map(([key, file]) => ({
      label: vscode.workspace.asRelativePath(vscode.Uri.parse(key), true),
      description: `${file.hunks.length} change(s)${file.current == null ? ' · deleted' : file.baseline == null ? ' · new' : ''}`,
      key,
    }));
    picker.title = `Unreviewed files (${picker.items.length})`;
    picker.placeholder =
      picker.items.length === 0
        ? 'No unreviewed changes.'
        : 'Select a file to review its remaining changes';
    const active = picker.items.find(item => item.key === activeKey);
    if (active != null) {
      picker.activeItems = [active];
    }
  }

  dispose(): void {
    const picker = this.picker;
    this.picker = undefined;
    vscode.Disposable.from(...this.listeners).dispose();
    this.listeners = [];
    picker?.dispose();
  }
}
