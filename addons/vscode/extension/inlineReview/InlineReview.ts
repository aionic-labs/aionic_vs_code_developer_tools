import type {Logger} from 'isl-server/src/logger';
import type {HunkTarget} from './BulkReview';
import type {ReviewHunk} from './ReviewFile';

import * as vscode from 'vscode';
import {reviewAllFiles} from './BulkReview';
import {inlineReviewLines, StaleReviewError} from './ReviewFile';
import {ReviewSession} from './ReviewSession';

const PREVIEW_SCHEME = 'aionic-inline-review';
const COMMAND = 'sapling.inlineReview.';

/** Local editor review controls; never invokes SCM, commit, or submit commands. */
export class InlineReview
  implements vscode.Disposable, vscode.CodeLensProvider, vscode.TextDocumentContentProvider
{
  private readonly session: ReviewSession;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  private readonly previewChanged = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  readonly onDidChange = this.previewChanged.event;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 5);
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    border: '0 0 0 3px solid',
    borderColor: new vscode.ThemeColor('editorGutter.addedBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorGutter.addedBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly removed = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
    border: '0 0 0 3px solid',
    borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
  });
  private readonly deletion = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    border: '0 0 1px 0 solid',
    borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
  });
  private actions = Promise.resolve();

  constructor(
    context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {
    this.session = new ReviewSession(context, logger);
    this.status.name = 'Aionic Inline Review';
    this.status.command = COMMAND + 'showFiles';
    this.disposables.push(
      this.session,
      this.status,
      this.added,
      this.removed,
      this.deletion,
      this.lensesChanged,
      this.previewChanged,
      vscode.languages.registerCodeLensProvider([{scheme: 'file'}, {scheme: PREVIEW_SCHEME}], this),
      vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, this),
      this.session.onDidChange(() => this.render()),
      vscode.window.onDidChangeActiveTextEditor(() => this.render()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.render()),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.uri.scheme === PREVIEW_SCHEME) {
          for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document === event.document) {
              this.decorate(editor);
            }
          }
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.run(() => this.session.initialize())),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('sapling.inlineReview.enabled')) {
          this.run(() => this.session.updateConfiguration());
        }
      }),
    );
    this.command('start', () => this.session.start());
    this.command('pause', () => this.session.pause());
    this.command('accept', target => this.accept(target));
    this.command('reject', target => this.reject(target));
    this.command('acceptFile', () => this.acceptFile());
    this.command('undoAccept', () => this.changeAcceptance('undoAccept'));
    this.command('redoAccept', () => this.changeAcceptance('redoAccept'));
    this.command('rejectFile', () => this.rejectFile());
    for (const action of ['accept', 'reject'] as const) {
      this.command(`${action}AllFiles`, () =>
        reviewAllFiles(this.session, action, (uri, target, content) =>
          this.replaceFile(uri, target, content, false),
        ),
      );
    }
    this.command('nextChange', () => this.navigateChange(1));
    this.command('previousChange', () => this.navigateChange(-1));
    this.command('nextFile', () => this.navigateFile(1));
    this.command('previousFile', () => this.navigateFile(-1));
    this.command('showFiles', () => this.showFiles());
    this.command('openPreview', target => this.openPreview(target?.uri, target));
    this.run(() => this.session.initialize());
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
    void vscode.commands.executeCommand('setContext', 'sapling.inlineReview.hasChanges', false);
    void vscode.commands.executeCommand('setContext', 'sapling.inlineReview.hasFileChanges', false);
    void vscode.commands.executeCommand('setContext', 'sapling.inlineReview.tracking', false);
    void vscode.commands.executeCommand('setContext', 'sapling.inlineReview.canUndoAccept', false);
    void vscode.commands.executeCommand('setContext', 'sapling.inlineReview.canRedoAccept', false);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const file = this.session.files.get(uri.query);
    return file == null
      ? 'This inline review session is no longer available.'
      : inlineReviewLines(file)
          .map(line => line.text.replace(/\r?\n$/, ''))
          .join('\n');
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const key = this.originalUri(document.uri).toString();
    const file = this.session.files.get(key);
    if (!this.session.isEnabled || file == null || !file.pending) {
      return [];
    }
    const preview = document.uri.scheme === PREVIEW_SCHEME;
    const lines = preview ? inlineReviewLines(file) : [];
    return file.hunks.flatMap(hunk => {
      const line = preview
        ? lines.findIndex(item => item.hunk?.index === hunk.index)
        : hunk.newStart;
      const range = this.lineRange(document, Math.max(0, line));
      const target = this.target(key, hunk);
      return [
        new vscode.CodeLens(range, {
          title: '✓ Accept',
          command: COMMAND + 'accept',
          arguments: [target],
        }),
        new vscode.CodeLens(range, {
          title: '× Reject',
          command: COMMAND + 'reject',
          arguments: [target],
        }),
        ...(!preview
          ? [
              new vscode.CodeLens(range, {
                title: `Review −${hunk.oldEnd - hunk.oldStart} / +${hunk.newEnd - hunk.newStart}`,
                command: COMMAND + 'openPreview',
                arguments: [target],
              }),
            ]
          : []),
      ];
    });
  }

  private command(name: string, action: (target?: HunkTarget) => unknown): void {
    this.disposables.push(
      vscode.commands.registerCommand(COMMAND + name, target => {
        const selected = target ?? this.selectedTarget();
        return this.run(() => action(selected));
      }),
    );
  }

  private run(action: () => unknown): Promise<void> {
    this.actions = this.actions
      .then(async () => {
        await action();
      })
      .catch(error => {
        this.logger.warn('Inline review action failed', error);
        void vscode.window.showWarningMessage(
          error instanceof Error ? error.message : String(error),
        );
      });
    return this.actions;
  }

  private selectedTarget(): HunkTarget | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor == null) {
      return undefined;
    }
    const key = this.originalUri(editor.document.uri).toString();
    const file = this.session.files.get(key);
    if (file == null) {
      return undefined;
    }
    const line = editor.selection.active.line;
    const hunk =
      editor.document.uri.scheme === PREVIEW_SCHEME
        ? inlineReviewLines(file)[line]?.hunk
        : file.hunks.find(
            item => line >= item.newStart && line <= Math.max(item.newStart, item.newEnd - 1),
          );
    return hunk == null ? undefined : this.target(key, hunk);
  }

  private async accept(target?: HunkTarget): Promise<void> {
    if (target == null) {
      throw new Error('Place the cursor on a change or use its Accept button.');
    }
    const uri = vscode.Uri.parse(target.uri);
    await this.session.reviewable(uri);
    this.session.accept(uri, target.revision, target.index);
  }

  private async reject(target?: HunkTarget): Promise<void> {
    if (target == null) {
      throw new Error('Place the cursor on a change or use its Reject button.');
    }
    const uri = vscode.Uri.parse(target.uri);
    const file = await this.session.reviewable(uri);
    const hunk = file.resolve(target.revision, target.index);
    if (file.baseline == null || file.current == null) {
      await this.replaceFile(uri, target, file.rejectedContent(target.revision, target.index));
      return;
    }
    const editor = await vscode.window.showTextDocument(uri, {preview: false});
    const fresh = await this.session.reviewable(uri);
    fresh.resolve(target.revision, target.index);
    if (editor.document.getText() !== fresh.current) {
      throw new StaleReviewError();
    }
    const range = new vscode.Range(
      editor.document.positionAt(hunk.newOffset),
      editor.document.positionAt(hunk.newEndOffset),
    );
    // VS Code checks the document version; undo/redo remains available.
    if (
      !(await this.session.applyReviewEdit(uri, () =>
        editor.edit(edit => edit.replace(range, hunk.removed)),
      ))
    ) {
      throw new StaleReviewError();
    }
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    await this.session.refresh(uri);
    this.session.notify();
  }

  private async acceptFile(): Promise<void> {
    const file = await this.session.reviewable(this.activeUri());
    file.acceptAll();
    this.session.notify();
  }

  private async rejectFile(): Promise<void> {
    const uri = this.activeUri();
    const file = await this.session.reviewable(uri);
    const first = file.hunks[0];
    if (first != null) {
      await this.replaceFile(uri, this.target(uri.toString(), first), file.baseline);
    }
  }

  private async changeAcceptance(action: 'undoAccept' | 'redoAccept'): Promise<void> {
    const file = await this.session.reviewable(this.activeUri());
    file[action]();
    this.session.notify();
  }

  private async replaceFile(
    uri: vscode.Uri,
    target: HunkTarget,
    content: string | null,
    confirm = true,
  ): Promise<void> {
    const confirmation = confirm
      ? await vscode.window.showWarningMessage(
          content == null
            ? `Delete newly created ${vscode.workspace.asRelativePath(uri)}?`
            : `Restore all unaccepted changes in ${vscode.workspace.asRelativePath(uri)}?`,
          {modal: true},
          'Reject changes',
        )
      : 'Reject changes';
    if (confirmation !== 'Reject changes') {
      return;
    }
    const file = await this.session.reviewable(uri);
    file.resolve(target.revision, target.index);
    if (content == null || file.current == null) {
      const edit = new vscode.WorkspaceEdit();
      if (content == null) {
        edit.deleteFile(uri, {recursive: false, ignoreIfNotExists: false});
      } else {
        edit.createFile(uri, {overwrite: false, ignoreIfExists: false});
        edit.insert(uri, new vscode.Position(0, 0), content);
      }
      if (!(await this.session.applyReviewEdit(uri, () => vscode.workspace.applyEdit(edit)))) {
        throw new StaleReviewError();
      }
    } else {
      const editor = await vscode.window.showTextDocument(uri, {preview: false});
      const fresh = await this.session.reviewable(uri);
      fresh.resolve(target.revision, target.index);
      if (editor.document.getText() !== fresh.current) {
        throw new StaleReviewError();
      }
      const range = new vscode.Range(
        editor.document.positionAt(0),
        editor.document.positionAt(editor.document.getText().length),
      );
      if (
        !(await this.session.applyReviewEdit(uri, () =>
          editor.edit(edit => edit.replace(range, content)),
        ))
      ) {
        throw new StaleReviewError();
      }
    }
    await this.session.refresh(uri);
    this.session.notify();
  }

  private async navigateChange(direction: number): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const locations = this.session.pending.flatMap(([key, file]) =>
      file.hunks.map(hunk => ({key, hunk})),
    );
    if (locations.length === 0) {
      return;
    }
    const key = editor == null ? '' : this.originalUri(editor.document.uri).toString();
    const selected = this.selectedTarget();
    let index = locations.findIndex(
      item => item.key === key && item.hunk.index === selected?.index,
    );
    if (index >= 0) {
      index = (index + direction + locations.length) % locations.length;
    } else {
      const line = editor?.selection.active.line ?? -1;
      index =
        direction > 0
          ? locations.findIndex(item => item.key === key && item.hunk.newStart > line)
          : locations.findLastIndex(item => item.key === key && item.hunk.newStart < line);
      if (index < 0) {
        index =
          direction > 0
            ? locations.findIndex(item => item.key.localeCompare(key) > 0)
            : locations.findLastIndex(item => item.key.localeCompare(key) < 0);
      }
      if (index < 0) {
        index = direction > 0 ? 0 : locations.length - 1;
      }
    }
    const location = locations[index];
    await this.showChange(
      location.key,
      location.hunk,
      editor?.document.uri.scheme === PREVIEW_SCHEME,
    );
  }

  private async navigateFile(direction: number): Promise<void> {
    const entries = this.session.pending;
    if (entries.length === 0) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const current = editor == null ? '' : this.originalUri(editor.document.uri).toString();
    const index = entries.findIndex(([key]) => key === current);
    const next =
      index < 0
        ? direction > 0
          ? 0
          : entries.length - 1
        : (index + direction + entries.length) % entries.length;
    const [key, file] = entries[next];
    await this.showChange(key, file.hunks[0], editor?.document.uri.scheme === PREVIEW_SCHEME);
  }

  private async showChange(key: string, hunk: ReviewHunk, preview = false): Promise<void> {
    const file = this.session.files.get(key);
    if (file == null) {
      return;
    }
    const showPreview = preview || file.current == null;
    const uri = vscode.Uri.parse(key);
    const editor = await vscode.window.showTextDocument(showPreview ? this.previewUri(uri) : uri, {
      preview: false,
    });
    const line = showPreview
      ? inlineReviewLines(file).findIndex(item => item.hunk?.index === hunk.index)
      : hunk.newStart;
    const range = this.lineRange(editor.document, Math.max(0, line));
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.decorate(editor);
  }

  private async openPreview(key?: string, target?: HunkTarget): Promise<void> {
    const uri = key == null ? this.activeUri() : vscode.Uri.parse(key);
    const file = await this.session.reviewable(uri);
    const hunk = target == null ? file.hunks[0] : file.resolve(target.revision, target.index);
    if (hunk != null) {
      await this.showChange(uri.toString(), hunk, true);
    }
  }

  private async showFiles(): Promise<void> {
    const items = this.session.pending.map(([key, file]) => ({
      label: vscode.workspace.asRelativePath(vscode.Uri.parse(key), true),
      description: `${file.hunks.length} change(s)${file.current == null ? ' · deleted' : file.baseline == null ? ' · new' : ''}`,
      key,
    }));
    if (items.length === 0) {
      void vscode.window.showInformationMessage(
        this.session.tracking
          ? 'No unreviewed changes since tracking started.'
          : 'Inline review is paused. Use Start Tracking to snapshot and watch your workspace.',
      );
      return;
    }
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Review local changes — accepting does not commit them',
    });
    if (selected != null) {
      await this.openPreview(selected.key);
    }
  }

  private render(): void {
    const pending = this.session.pending;
    this.status.text = !this.session.ready
      ? '$(sync~spin) Inline review'
      : `$(diff) Review: ${pending.length} files${this.session.tracking ? '' : ' (paused)'}`;
    this.status.tooltip =
      `Tracking ${this.session.files.size} source files. Accept acknowledges changes; it does not commit or stage them.` +
      (this.session.skipped > 0
        ? ` ${this.session.skipped} binary or unreadable file(s) skipped.`
        : '');
    if (this.session.isEnabled) {
      this.status.show();
    } else {
      this.status.hide();
    }
    void vscode.commands.executeCommand(
      'setContext',
      'sapling.inlineReview.tracking',
      this.session.tracking,
    );
    const active = vscode.window.activeTextEditor;
    const activeFile =
      active == null
        ? undefined
        : this.session.files.get(this.originalUri(active.document.uri).toString());
    void vscode.commands.executeCommand(
      'setContext',
      'sapling.inlineReview.canUndoAccept',
      this.session.isEnabled && (activeFile?.canUndoAccept ?? false),
    );
    void vscode.commands.executeCommand(
      'setContext',
      'sapling.inlineReview.canRedoAccept',
      this.session.isEnabled && (activeFile?.canRedoAccept ?? false),
    );
    void vscode.commands.executeCommand(
      'setContext',
      'sapling.inlineReview.hasChanges',
      pending.length > 0,
    );
    void vscode.commands.executeCommand(
      'setContext',
      'sapling.inlineReview.hasFileChanges',
      this.session.isEnabled && (activeFile?.pending ?? false),
    );
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.scheme === PREVIEW_SCHEME) {
        this.previewChanged.fire(editor.document.uri);
      }
      this.decorate(editor);
    }
    this.lensesChanged.fire();
  }

  private decorate(editor: vscode.TextEditor): void {
    const file = this.session.isEnabled
      ? this.session.files.get(this.originalUri(editor.document.uri).toString())
      : undefined;
    const additions: vscode.Range[] = [];
    const removals: vscode.Range[] = [];
    const markers: vscode.DecorationOptions[] = [];
    if (file != null && editor.document.uri.scheme === PREVIEW_SCHEME) {
      inlineReviewLines(file).forEach((line, index) => {
        if (line.kind === 'added') {
          additions.push(this.lineRange(editor.document, index));
        }
        if (line.kind === 'removed') {
          removals.push(this.lineRange(editor.document, index));
        }
      });
    } else if (file != null && editor.document.uri.scheme === 'file') {
      for (const hunk of file.hunks) {
        for (let line = hunk.newStart; line < hunk.newEnd; line++) {
          additions.push(this.lineRange(editor.document, line));
        }
        if (hunk.removed !== '') {
          const hover = new vscode.MarkdownString();
          hover.appendText('Removed text (open Inline Review to see full lines):\n');
          hover.appendCodeblock(hunk.removed, editor.document.languageId);
          markers.push({
            range: this.lineRange(editor.document, hunk.newStart),
            hoverMessage: hover,
            renderOptions: {
              after: {
                contentText: `  − ${hunk.removed.replace(/\s+/g, ' ').slice(0, 100)}`,
                color: new vscode.ThemeColor('editorGutter.deletedBackground'),
                fontStyle: 'italic',
              },
            },
          });
        }
      }
    }
    editor.setDecorations(this.added, additions);
    editor.setDecorations(this.removed, removals);
    editor.setDecorations(this.deletion, markers);
  }

  private target(uri: string, hunk: ReviewHunk): HunkTarget {
    return {uri, revision: hunk.revision, index: hunk.index};
  }

  private activeUri(): vscode.Uri {
    const editor = vscode.window.activeTextEditor;
    if (editor == null) {
      throw new Error('Open a file to review its changes.');
    }
    return this.originalUri(editor.document.uri);
  }

  private originalUri(uri: vscode.Uri): vscode.Uri {
    return uri.scheme === PREVIEW_SCHEME ? vscode.Uri.parse(uri.query) : uri;
  }

  private previewUri(uri: vscode.Uri): vscode.Uri {
    return uri.with({scheme: PREVIEW_SCHEME, query: uri.toString()});
  }

  private lineRange(document: vscode.TextDocument, line: number): vscode.Range {
    return document.lineAt(Math.min(Math.max(0, line), document.lineCount - 1)).range;
  }
}
