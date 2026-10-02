/** Local review state. Accepting a hunk changes the baseline, never the working file. */
import {diffLines, splitLines} from 'shared/diff';
import {Snapshot, type SnapshotStore} from './SnapshotStore';

export type ReviewHunk = {
  revision: number;
  index: number;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  oldOffset: number;
  oldEndOffset: number;
  newOffset: number;
  newEndOffset: number;
  removed: string;
  added: string;
};

export type EditorChange = {rangeOffset: number; rangeLength: number; text: string};

export class StaleReviewError extends Error {
  constructor() {
    super(
      'This change was edited since it was displayed. Review the updated change and try again.',
    );
  }
}

/** null denotes a missing file; an empty string denotes an existing empty file. */
export class ReviewFile {
  private revision = 0;
  private cachedHunks?: ReviewHunk[];
  private before: string | null | Snapshot;
  private after: string | null | Snapshot;
  private readonly acceptedUndo: Array<string | null | Snapshot> = [];
  private readonly acceptedRedo: Array<string | null | Snapshot> = [];

  constructor(baseline: string | null | Snapshot, current: string | null | Snapshot = baseline) {
    this.before = baseline;
    this.after = current;
  }

  get baseline(): string | null {
    return this.before instanceof Snapshot ? this.before.read() : this.before;
  }

  set baseline(text: string | null) {
    // A manual edit rebases the review. Old decisions must not restore that old baseline.
    this.acceptedUndo.length = 0;
    this.acceptedRedo.length = 0;
    this.before = text;
  }

  get canUndoAccept(): boolean {
    return this.acceptedUndo.length > 0;
  }

  get canRedoAccept(): boolean {
    return this.acceptedRedo.length > 0;
  }

  undoAccept(): void {
    if (this.canUndoAccept) {
      this.acceptedRedo.push(this.before);
      this.before = this.acceptedUndo.pop()!;
      this.invalidate();
    }
  }

  redoAccept(): void {
    if (this.canRedoAccept) {
      this.acceptedUndo.push(this.before);
      this.before = this.acceptedRedo.pop()!;
      this.invalidate();
    }
  }

  private recordAccept(baseline: string | null | Snapshot): void {
    this.acceptedUndo.push(this.before);
    this.acceptedRedo.length = 0;
    this.before = baseline;
    this.invalidate();
  }

  get current(): string | null {
    return this.after instanceof Snapshot ? this.after.read() : this.after;
  }

  set current(text: string | null) {
    this.after = text;
  }

  matchesCurrent(text: string | null): boolean {
    return this.after instanceof Snapshot
      ? text != null && this.after.matches(text)
      : text === this.after;
  }

  async saveBaseline(store: SnapshotStore): Promise<string | null> {
    const before = this.before;
    if (before == null) {
      return null;
    }
    if (before instanceof Snapshot) {
      if (!this.pending) {
        this.after = before;
      }
      return before.hash;
    }
    const snapshot = await store.save(before);
    // Edits may arrive while writing. Never replace a newer baseline.
    if (this.before === before) {
      this.before = snapshot;
      if (this.matchesCurrent(before)) {
        this.after = snapshot;
      }
    }
    return snapshot.hash;
  }

  update(content: string | null): void {
    if (!this.matchesCurrent(content)) {
      this.current = content;
      this.invalidate();
    }
  }

  /** Apply editor edits to both sides, acknowledging only pending hunks they touch. */
  editorBaseline(content: string, changes: readonly EditorChange[]): string | undefined {
    if (this.current == null || changes.length === 0) {
      return undefined;
    }
    const edits = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
    let expected = this.current;
    let end = expected.length;
    for (const edit of edits) {
      if (edit.rangeOffset < 0 || edit.rangeOffset + edit.rangeLength > end) {
        return undefined;
      }
      expected =
        expected.slice(0, edit.rangeOffset) +
        edit.text +
        expected.slice(edit.rangeOffset + edit.rangeLength);
      end = edit.rangeOffset;
    }
    // A watcher may have advanced the snapshot already. Never map stale offsets.
    if (expected !== content) {
      return undefined;
    }
    const touched = this.hunks.filter(hunk =>
      edits.some(edit => {
        const end = edit.rangeOffset + edit.rangeLength;
        return edit.rangeLength === 0 || hunk.newOffset === hunk.newEndOffset
          ? edit.rangeOffset <= hunk.newEndOffset && end >= hunk.newOffset
          : edit.rangeOffset < hunk.newEndOffset && end > hunk.newOffset;
      }),
    );
    let baseline = this.baseline ?? '';
    for (const hunk of [...touched].reverse()) {
      baseline = baseline.slice(0, hunk.oldOffset) + hunk.added + baseline.slice(hunk.oldEndOffset);
    }
    const remaining = this.hunks.filter(hunk => !touched.includes(hunk));
    const baselineOffset = (offset: number) =>
      offset +
      remaining
        .filter(hunk => hunk.newEndOffset <= offset)
        .reduce((delta, hunk) => delta + hunk.removed.length - hunk.added.length, 0);
    for (const edit of edits) {
      baseline =
        baseline.slice(0, baselineOffset(edit.rangeOffset)) +
        edit.text +
        baseline.slice(baselineOffset(edit.rangeOffset + edit.rangeLength));
    }
    return baseline;
  }

  get pending(): boolean {
    if (this.before === this.after) {
      return false;
    }
    if (this.before instanceof Snapshot) {
      return this.after instanceof Snapshot
        ? this.before.hash !== this.after.hash
        : this.after == null || !this.before.matches(this.after);
    }
    return !this.matchesCurrent(this.before);
  }

  get hunks(): ReviewHunk[] {
    return (this.cachedHunks ??= this.computeHunks());
  }

  /** Also invalidate buttons while the file is temporarily unreadable. */
  invalidate(): void {
    this.revision++;
    this.cachedHunks = undefined;
  }

  private computeHunks(): ReviewHunk[] {
    if (!this.pending) {
      return [];
    }
    const before = splitLines(this.baseline ?? '');
    const after = splitLines(this.current ?? '');
    const ranges =
      this.baseline == null || this.current == null
        ? [[0, before.length, 0, after.length]]
        : diffLines(before, after);
    const beforeOffsets = lineOffsets(before);
    const afterOffsets = lineOffsets(after);
    return ranges.map(([oldStart, oldEnd, newStart, newEnd], index) => ({
      revision: this.revision,
      index,
      oldStart,
      oldEnd,
      newStart,
      newEnd,
      oldOffset: beforeOffsets[oldStart],
      oldEndOffset: beforeOffsets[oldEnd],
      newOffset: afterOffsets[newStart],
      newEndOffset: afterOffsets[newEnd],
      removed: before.slice(oldStart, oldEnd).join(''),
      added: after.slice(newStart, newEnd).join(''),
    }));
  }

  resolve(revision: number, index: number): ReviewHunk {
    const hunk = this.hunks[index];
    if (revision !== this.revision || hunk == null) {
      throw new StaleReviewError();
    }
    return hunk;
  }

  accept(revision: number, index: number): void {
    this.recordAccept(this.acceptedContent(revision, index));
  }

  acceptedContent(revision: number, index: number): string | null {
    const hunk = this.resolve(revision, index);
    if (this.baseline == null || this.current == null) {
      return this.current;
    }
    return (
      this.baseline.slice(0, hunk.oldOffset) + hunk.added + this.baseline.slice(hunk.oldEndOffset)
    );
  }

  acceptAll(): void {
    if (this.pending) {
      this.recordAccept(this.after);
    }
  }

  /** Preview only. The controller applies the edit through VS Code's undoable edit API. */
  rejectedContent(revision: number, index: number): string | null {
    const hunk = this.resolve(revision, index);
    if (this.baseline == null || this.current == null) {
      return this.baseline;
    }
    return (
      this.current.slice(0, hunk.newOffset) + hunk.removed + this.current.slice(hunk.newEndOffset)
    );
  }
}

function lineOffsets(lines: string[]): number[] {
  const offsets = [0];
  for (const line of lines) {
    offsets.push(offsets[offsets.length - 1] + line.length);
  }
  return offsets;
}

export type ReviewLine = {text: string; kind: 'context' | 'removed' | 'added'; hunk?: ReviewHunk};

/** Read-only inline preview: complete removed lines above their replacements. */
export function inlineReviewLines(file: ReviewFile): ReviewLine[] {
  const lines = splitLines(file.current ?? '');
  const result: ReviewLine[] = [];
  let cursor = 0;
  for (const hunk of file.hunks) {
    for (const text of lines.slice(cursor, hunk.newStart)) {
      result.push({text, kind: 'context'});
    }
    for (const text of splitLines(hunk.removed)) {
      result.push({text, kind: 'removed', hunk});
    }
    for (const text of splitLines(hunk.added)) {
      result.push({text, kind: 'added', hunk});
    }
    if (hunk.removed === '' && hunk.added === '') {
      result.push({
        text: file.current == null ? '(File deleted)\n' : '(Empty file created)\n',
        kind: file.current == null ? 'removed' : 'added',
        hunk,
      });
    }
    cursor = hunk.newEnd;
  }
  for (const text of lines.slice(cursor)) {
    result.push({text, kind: 'context'});
  }
  return result;
}
