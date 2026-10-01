/** Local review state. Accepting a hunk changes the baseline, never the working file. */
import {diffLines, splitLines} from 'shared/diff';

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

  constructor(
    public baseline: string | null,
    public current: string | null = baseline,
  ) {}

  update(content: string | null): void {
    if (content !== this.current) {
      this.current = content;
      this.invalidate();
    }
  }

  get pending(): boolean {
    return this.baseline !== this.current;
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
    this.baseline = this.acceptedContent(revision, index);
    this.invalidate();
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
    this.baseline = this.current;
    this.invalidate();
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
