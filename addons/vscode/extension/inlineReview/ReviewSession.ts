import type {Logger} from 'isl-server/src/logger';

import * as vscode from 'vscode';
import {ReviewFile} from './ReviewFile';

const STORAGE_KEY = 'aionic.inlineReview.session.v1';
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
  '.git',
  '.sl',
  '.hg',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  '__pycache__',
]);
const EXCLUDE_GLOB = `**/{${[...EXCLUDED_DIRECTORIES].join(',')}}/**`;

type StoredSession = {tracking: boolean; files: Array<{uri: string; baseline: string | null}>};

/** Workspace-local snapshots. No SCM commands, network calls, or commits. */
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
  private disposed = false;
  private starting = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {
    this.onDidChange = this.changes.event;
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      watcher.onDidCreate(uri => this.changedOnDisk(uri)),
      watcher.onDidChange(uri => this.changedOnDisk(uri)),
      watcher.onDidDelete(uri => this.changedOnDisk(uri)),
      vscode.workspace.onDidChangeTextDocument(event => {
        const key = event.document.uri.toString();
        if (!this.ready) {
          this.queued.set(key, event.document.uri);
          return;
        }
        if (this.files.has(key)) {
          this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
          this.observe(event.document.uri, event.document.getText());
        }
      }),
      vscode.workspace.onDidCloseTextDocument(document => this.changedOnDisk(document.uri)),
    );
  }

  async initialize(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      return;
    }
    const saved = this.context.workspaceState.get<StoredSession>(STORAGE_KEY);
    if (saved != null && Array.isArray(saved.files)) {
      for (const item of saved.files.slice(0, MAX_FILES)) {
        if (
          typeof item.uri !== 'string' ||
          (item.baseline !== null && typeof item.baseline !== 'string')
        ) {
          continue;
        }
        const uri = vscode.Uri.parse(item.uri);
        if (this.includes(uri) && this.canAdd(item.baseline)) {
          this.files.set(item.uri, new ReviewFile(item.baseline));
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
      const uris = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, MAX_FILES + 1);
      if (uris.length > MAX_FILES) {
        this.skipped++;
      }
      for (const uri of uris.slice(0, MAX_FILES)) {
        if (this.disposed) {
          return;
        }
        const key = uri.toString();
        if (this.files.has(key) || !this.includes(uri)) {
          continue;
        }
        // Read sequentially to bound memory while enforcing the snapshot budget.
        // eslint-disable-next-line no-await-in-loop
        const content = await this.read(uri);
        if (content != null && this.canAdd(content)) {
          this.files.set(key, new ReviewFile(content));
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
      if (this.skipped > 0) {
        void vscode.window.showWarningMessage(
          'Inline review skipped oversized, binary, unreadable, or excess files. See the inline review documentation for snapshot limits.',
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

  async refresh(uri: vscode.Uri): Promise<ReviewFile | undefined> {
    if (this.disposed || !this.includes(uri)) {
      return undefined;
    }
    const key = uri.toString();
    if (!this.files.has(key) && (!this.tracking || this.ignored.has(key))) {
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
      throw new Error(
        'This file cannot currently be reviewed. It may be binary, too large, or unavailable.',
      );
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
    const baseline = file.acceptedContent(revision, index);
    if (
      Buffer.byteLength(baseline ?? '') > MAX_FILE_BYTES ||
      !this.fitsBudget(file.current, key, baseline)
    ) {
      throw new Error(
        'This partial acceptance exceeds the snapshot limit. Accept a deletion first, or accept the entire file.',
      );
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

  private observe(uri: vscode.Uri, content: string | null): boolean {
    const key = uri.toString();
    if (
      content != null &&
      (Buffer.byteLength(content) > MAX_FILE_BYTES || content.includes('\0'))
    ) {
      this.skip(key);
      return false;
    }
    const existing = this.files.get(key);
    if (existing != null) {
      if (!this.fitsBudget(content, key)) {
        this.skip(key);
        return false;
      }
      const recovered = this.unavailable.delete(key);
      if (existing.current === content && !recovered) {
        return true;
      }
      existing.update(content);
    } else if (this.tracking && content != null && this.canAdd(content)) {
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

  private canAdd(content: string | null): boolean {
    return (
      this.files.size < MAX_FILES &&
      Buffer.byteLength(content ?? '') <= MAX_FILE_BYTES &&
      this.fitsBudget(content)
    );
  }

  private fitsBudget(
    content: string | null,
    replacingKey?: string,
    baseline?: string | null,
  ): boolean {
    // Reserve space for accepting the entire current file into the baseline, too.
    let bytes = replacingKey == null ? Buffer.byteLength(content ?? '') * 2 : 0;
    for (const [key, file] of this.files) {
      bytes +=
        2 *
        Math.max(
          Buffer.byteLength(
            (key === replacingKey && baseline !== undefined ? baseline : file.baseline) ?? '',
          ),
          Buffer.byteLength((key === replacingKey ? content : file.current) ?? ''),
        );
    }
    return bytes <= MAX_SESSION_BYTES;
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
      return Buffer.byteLength(content) <= MAX_FILE_BYTES && !content.includes('\0')
        ? content
        : undefined;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File || stat.size > MAX_FILE_BYTES) {
        return undefined;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) {
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
      await this.refresh(vscode.Uri.parse(key));
    }
  }

  private persist(): void {
    if (!this.ready) {
      return;
    }
    const saved: StoredSession = {
      tracking: this.tracking,
      files: [...this.files].map(([uri, file]) => ({uri, baseline: file.baseline})),
    };
    this.saveQueue = this.saveQueue
      .then(() => this.context.workspaceState.update(STORAGE_KEY, saved))
      .catch(error => this.logger.warn('Could not save local inline review session', error));
  }
}
