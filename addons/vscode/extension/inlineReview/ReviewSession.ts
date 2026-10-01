import type {Logger} from 'isl-server/src/logger';

import {createHash} from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import {ReviewFile} from './ReviewFile';
import {SnapshotStore} from './SnapshotStore';
import {SourceFiles} from './SourceFiles';

const STORAGE_KEY = 'aionic.inlineReview.session.v2';
const LEGACY_STORAGE_KEY = 'aionic.inlineReview.session.v1';
const EXCLUDED_DIRECTORIES = new Set(['.git', '.sl', '.hg']);

type StoredSession = {tracking: boolean; files: Array<{uri: string; baseline: string | null}>};
// v2 baselines are content hashes; v1 baselines were source text in workspaceState.

/** Workspace-local snapshots. Git is used only for source-file discovery. */
export class ReviewSession implements vscode.Disposable {
  readonly files = new Map<string, ReviewFile>();
  readonly onDidChange: vscode.Event<void>;
  tracking = false;
  ready = false;
  skipped = 0;
  private readonly changes = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly reads = new Map<string, number>();
  private readonly ignored = new Set<string>();
  private readonly unavailable = new Set<string>();
  private readonly queued = new Map<string, vscode.Uri>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saveQueue = Promise.resolve();
  private readonly snapshots: SnapshotStore;
  private readonly sources = new SourceFiles();
  private disposed = false;
  private starting = false;
  private readonly reviewEdits = new Set<string>();
  private readonly reviewUndo = new Set<string>();
  private readonly editorBaselines = new WeakMap<
    vscode.TextDocument,
    {content: string; baseline: string}
  >();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {
    this.snapshots = new SnapshotStore(
      path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'inline-review-snapshots'),
    );
    this.onDidChange = this.changes.event;
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      watcher.onDidCreate(uri => this.changedOnDisk(uri)),
      watcher.onDidChange(uri => this.changedOnDisk(uri)),
      watcher.onDidDelete(uri => this.changedOnDisk(uri)),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.contentChanges.length === 0) {
          // VS Code can send the content event before setting isDirty, followed
          // by a separate empty event announcing the dirty-state transition.
          const pending = this.editorBaselines.get(event.document);
          this.editorBaselines.delete(event.document);
          if (
            pending != null &&
            event.document.isDirty &&
            event.document.getText() === pending.content &&
            this.files.get(event.document.uri.toString())?.current === pending.content
          ) {
            this.observe(event.document.uri, pending.content, pending.baseline);
          }
          return;
        }
        this.editorBaselines.delete(event.document);
        const key = event.document.uri.toString();
        if (!this.ready) {
          this.queued.set(key, event.document.uri);
          return;
        }
        if (this.files.has(key)) {
          this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
          const content = event.document.getText();
          const file = this.files.get(key)!;
          const isReviewUndo =
            event.reason != null &&
            this.reviewUndo.has(this.transition(key, file.current, content));
          // Disk reloads are clean. VS Code does not identify which extension made
          // a dirty-buffer edit, so those are treated like editor typing as well.
          const baseline =
            !this.reviewEdits.has(key) && !isReviewUndo
              ? file.editorBaseline(content, event.contentChanges)
              : undefined;
          if (!event.document.isDirty && baseline !== undefined) {
            this.editorBaselines.set(event.document, {content, baseline});
          }
          this.observe(event.document.uri, content, event.document.isDirty ? baseline : undefined);
        }
      }),
      vscode.workspace.onDidCloseTextDocument(document => this.changedOnDisk(document.uri)),
      vscode.workspace.onDidOpenTextDocument(document => {
        if (this.ready && this.tracking) {
          void this.trackOpenFile(document.uri).catch(error =>
            this.logger.warn('Inline review could not track open file', error),
          );
        }
      }),
    );
  }

  /** Our rejection and its undo/redo must retain the original review baseline. */
  async applyReviewEdit(uri: vscode.Uri, edit: () => Thenable<boolean>): Promise<boolean> {
    const key = uri.toString();
    const before = this.files.get(key)?.current ?? null;
    this.reviewEdits.add(key);
    try {
      const applied = await edit();
      await this.refresh(uri);
      if (applied) {
        const after = this.files.get(key)?.current ?? null;
        this.reviewUndo.add(this.transition(key, before, after));
        this.reviewUndo.add(this.transition(key, after, before));
        while (this.reviewUndo.size > 1000) {
          this.reviewUndo.delete(this.reviewUndo.values().next().value!);
        }
      }
      return applied;
    } finally {
      this.reviewEdits.delete(key);
    }
  }

  private transition(key: string, before: string | null, after: string | null): string {
    return createHash('sha256')
      .update(JSON.stringify([key, before, after]))
      .digest('hex');
  }

  async initialize(): Promise<void> {
    if (!vscode.workspace.isTrusted || this.context.storageUri == null) {
      return;
    }
    const current = this.context.workspaceState.get<StoredSession>(STORAGE_KEY);
    const saved = current ?? this.context.workspaceState.get<StoredSession>(LEGACY_STORAGE_KEY);
    if (saved != null && Array.isArray(saved.files)) {
      for (const item of saved.files) {
        if (
          typeof item.uri !== 'string' ||
          (item.baseline !== null && typeof item.baseline !== 'string')
        ) {
          continue;
        }
        const uri = vscode.Uri.parse(item.uri);
        if (this.includes(uri)) {
          try {
            const baseline =
              current != null && item.baseline != null
                ? this.snapshots.load(item.baseline)
                : item.baseline;
            this.files.set(item.uri, new ReviewFile(baseline));
          } catch (error) {
            this.logger.warn('Could not restore inline review snapshot', error);
            this.skip(item.uri);
          }
        }
      }
      this.tracking = saved.tracking === true;
    }
    const enabled = vscode.workspace
      .getConfiguration('sapling')
      .get<boolean>('inlineReview.enabled', true);
    if (enabled && (saved == null || saved.tracking)) {
      await this.start();
    } else {
      this.tracking = false;
      this.ready = true;
      await this.refreshKnownFiles();
      this.notify();
    }
  }

  async start(): Promise<void> {
    if (this.starting || this.disposed) {
      return;
    }
    if (!vscode.workspace.isTrusted) {
      throw new Error('Trust this workspace before starting inline review.');
    }
    this.starting = true;
    this.ready = false;
    this.notify();
    try {
      const uris = await this.sources.discover();
      for (const key of this.files.keys()) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await this.sources.includes(vscode.Uri.parse(key)))) {
          this.files.delete(key);
        }
      }
      // Restore pending changes before discovering new source files.
      await this.refreshKnownFiles();
      for (const document of vscode.workspace.textDocuments) {
        // eslint-disable-next-line no-await-in-loop
        await this.trackOpenFile(document.uri);
      }
      for (const uri of uris) {
        if (this.disposed) {
          return;
        }
        const key = uri.toString();
        if (this.files.has(key) || !this.includes(uri)) {
          continue;
        }
        // Snapshot one file at a time; unchanged contents are offloaded to disk.
        // eslint-disable-next-line no-await-in-loop
        const content = await this.read(uri);
        if (content != null) {
          const file = new ReviewFile(content);
          this.files.set(key, file);
          // eslint-disable-next-line no-await-in-loop
          await file.saveBaseline(this.snapshots);
        } else if (content !== null) {
          this.skip(key);
        }
      }
      this.tracking = true;
      this.ready = true;
      await this.refreshKnownFiles();
      // Changes made during initialization are re-read before reporting ready.
      for (const uri of this.queued.values()) {
        // eslint-disable-next-line no-await-in-loop
        await this.refresh(uri);
      }
      this.queued.clear();
      this.logger.info(
        `Inline review tracking ${this.files.size} source files; ${this.skipped} binary or unreadable files skipped.`,
      );
      if (this.skipped > 0) {
        void vscode.window.showWarningMessage(
          'Inline review cannot review some binary or unreadable files. See the status tooltip for the count.',
        );
      }
    } finally {
      this.starting = false;
      this.notify();
    }
  }

  pause(): void {
    this.tracking = false;
    this.notify();
  }

  private async trackOpenFile(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    if (
      this.disposed ||
      !vscode.workspace.isTrusted ||
      !this.includes(uri) ||
      this.files.has(key)
    ) {
      return;
    }
    if (!(await this.sources.includes(uri))) {
      return;
    }
    const content = await this.read(uri);
    if (content == null || this.disposed || this.files.has(key)) {
      return;
    }
    const latest = await this.read(uri);
    if (this.disposed || this.files.has(key)) {
      return;
    }
    if (latest != null) {
      const file = new ReviewFile(latest);
      this.files.set(key, file);
      await file.saveBaseline(this.snapshots);
      if (this.ignored.delete(key)) {
        this.skipped--;
      }
      this.notify();
    } else {
      this.skip(key);
    }
  }

  async refresh(uri: vscode.Uri): Promise<ReviewFile | undefined> {
    if (this.disposed || !this.includes(uri)) {
      return undefined;
    }
    const key = uri.toString();
    if (!this.files.has(key) && !this.tracking) {
      return undefined;
    }
    if (!(await this.sources.includes(uri))) {
      return undefined;
    }
    const sequence = (this.reads.get(key) ?? 0) + 1;
    this.reads.set(key, sequence);
    const content = await this.read(uri);
    if (sequence !== this.reads.get(key) || this.disposed) {
      return this.files.get(key);
    }
    if (content === undefined) {
      this.skip(key);
      return undefined;
    }
    return this.observe(uri, content) ? this.files.get(key) : undefined;
  }

  /** Re-read immediately before an action; never reject against stale disk contents. */
  async reviewable(uri: vscode.Uri): Promise<ReviewFile> {
    const file = await this.refresh(uri);
    if (file == null) {
      throw new Error('This file cannot currently be reviewed. It may be binary or unavailable.');
    }
    return file;
  }

  get pending(): Array<[string, ReviewFile]> {
    return [...this.files]
      .filter(([key, file]) => file.pending && !this.unavailable.has(key))
      .sort(([a], [b]) => a.localeCompare(b));
  }

  accept(uri: vscode.Uri, revision: number, index: number): void {
    const key = uri.toString();
    const file = this.files.get(key);
    if (file == null || this.unavailable.has(key)) {
      throw new Error('This file is not available for review.');
    }
    file.accept(revision, index);
    this.notify();
  }

  notify(): void {
    if (this.disposed) {
      return;
    }
    this.changes.fire();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), 400);
  }

  async flush(): Promise<void> {
    this.persist();
    await this.saveQueue;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.saveTimer);
    this.persist();
    vscode.Disposable.from(...this.disposables, this.changes).dispose();
  }

  private changedOnDisk(uri: vscode.Uri): void {
    if (!this.includes(uri)) {
      return;
    }
    if (!this.ready) {
      this.queued.set(uri.toString(), uri);
      return;
    }
    void this.refresh(uri).catch(error =>
      this.logger.warn('Inline review could not refresh file', error),
    );
  }

  private observe(uri: vscode.Uri, content: string | null, baseline?: string): boolean {
    const key = uri.toString();
    if (content != null && content.includes('\0')) {
      this.skip(key);
      return false;
    }
    const existing = this.files.get(key);
    if (existing != null) {
      const recovered = this.unavailable.delete(key);
      if (existing.matchesCurrent(content) && !recovered && baseline === undefined) {
        return true;
      }
      if (baseline !== undefined && baseline !== existing.baseline) {
        existing.baseline = baseline;
        existing.invalidate();
      }
      existing.update(content);
    } else if (this.tracking && content != null) {
      this.files.set(key, new ReviewFile(null, content));
    } else {
      if (content != null) {
        this.skip(key);
      }
      return false;
    }
    this.notify();
    return true;
  }

  private includes(uri: vscode.Uri): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (uri.scheme !== 'file' || folder == null) {
      return false;
    }
    return !uri.path
      .slice(folder.uri.path.length)
      .split('/')
      .some(part => EXCLUDED_DIRECTORIES.has(part));
  }

  private skip(key: string): void {
    if (this.files.has(key) && !this.unavailable.has(key)) {
      this.unavailable.add(key);
      this.files.get(key)?.invalidate();
      this.notify();
    }
    if (!this.ignored.has(key)) {
      this.skipped++;
      this.ignored.add(key);
    }
  }

  private async read(uri: vscode.Uri): Promise<string | null | undefined> {
    const open = vscode.workspace.textDocuments.find(
      document => document.uri.toString() === uri.toString() && document.isDirty,
    );
    if (open != null) {
      const content = open.getText();
      return !content.includes('\0') ? content : undefined;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File) {
        return undefined;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.includes(0)) {
        return undefined;
      }
      return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
        return null;
      }
      this.logger.warn('Inline review skipped unreadable file', uri.fsPath, error);
      return undefined;
    }
  }

  private async refreshKnownFiles(): Promise<void> {
    for (const key of this.files.keys()) {
      // Keep disk reads and snapshot memory bounded for large workspaces.
      // eslint-disable-next-line no-await-in-loop
      const file = await this.refresh(vscode.Uri.parse(key));
      if (file != null) {
        // eslint-disable-next-line no-await-in-loop
        await file.saveBaseline(this.snapshots);
      }
    }
  }

  private persist(): void {
    if (!this.ready) {
      return;
    }
    const tracking = this.tracking;
    const files = [...this.files];
    this.saveQueue = this.saveQueue
      .then(async () => {
        const saved: StoredSession = {tracking, files: []};
        for (const [uri, file] of files) {
          // eslint-disable-next-line no-await-in-loop
          const baseline = await file.saveBaseline(this.snapshots);
          saved.files.push({uri, baseline});
        }
        await this.context.workspaceState.update(STORAGE_KEY, saved);
      })
      .catch(error => {
        this.logger.warn('Could not save local inline review session', error);
        void vscode.window.showWarningMessage(
          'Inline review could not save its snapshots. Check available disk space.',
        );
      });
  }
}
