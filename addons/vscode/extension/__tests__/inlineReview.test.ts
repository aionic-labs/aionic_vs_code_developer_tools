import {inlineReviewLines, ReviewFile, StaleReviewError} from '../inlineReview/ReviewFile';

function accept(file: ReviewFile, index = 0): void {
  const hunk = file.hunks[index];
  file.accept(hunk.revision, hunk.index);
}

function reject(file: ReviewFile, index = 0): void {
  const hunk = file.hunks[index];
  file.update(file.rejectedContent(hunk.revision, hunk.index));
}

describe('local inline review', () => {
  it('undoes and redoes partial accepts in order without changing the working file', () => {
    const file = new ReviewFile('one\nstable\nthree\n', 'ONE\nstable\nTHREE\n');
    const content = file.current;
    accept(file);
    const remaining = file.hunks[0];
    accept(file);
    expect(file.pending).toBe(false);
    file.undoAccept();
    expect(file.baseline).toBe('ONE\nstable\nthree\n');
    expect(file.hunks).toHaveLength(1);
    expect(() => file.resolve(remaining.revision, remaining.index)).toThrow(StaleReviewError);
    file.undoAccept();
    expect(file.baseline).toBe('one\nstable\nthree\n');
    expect(file.canUndoAccept).toBe(false);
    file.redoAccept();
    expect(file.hunks).toHaveLength(1);
    file.redoAccept();
    expect(file.pending).toBe(false);
    expect(file.canRedoAccept).toBe(false);
    expect(file.current).toBe(content);
  });

  it.each([
    ['text', 'old\r\n🐈', 'new\r\n🐕'],
    ['new file', null, 'new\n'],
    ['new empty file', null, ''],
    ['deleted file', 'old\n', null],
    ['deleted empty file', '', null],
  ])('undoes and redoes Accept All for a %s without touching contents', (_, before, current) => {
    const file = new ReviewFile(before, current);
    file.acceptAll();
    expect(file.pending).toBe(false);
    file.undoAccept();
    expect(file.baseline).toBe(before);
    expect(file.pending).toBe(true);
    file.redoAccept();
    expect(file.baseline).toBe(current);
    expect(file.current).toBe(current);
  });

  it('preserves later external changes when undoing and redoing acceptance', () => {
    const file = new ReviewFile('old\n', 'accepted\n');
    file.acceptAll();
    file.update('new external edit\n');
    file.undoAccept();
    expect(file.baseline).toBe('old\n');
    file.redoAccept();
    expect(file.baseline).toBe('accepted\n');
    expect(file.current).toBe('new external edit\n');
    expect(file.pending).toBe(true);
  });

  it('clears redo on a new decision and does not record no-op accepts', () => {
    const file = new ReviewFile('one\nstable\nthree\n', 'ONE\nstable\nTHREE\n');
    accept(file);
    file.undoAccept();
    accept(file, 1);
    expect(file.canRedoAccept).toBe(false);
    file.acceptAll();
    file.acceptAll();
    file.undoAccept();
    expect(file.hunks).toHaveLength(1);
    file.undoAccept();
    expect(file.hunks).toHaveLength(2);
    expect(file.canUndoAccept).toBe(false);
    file.undoAccept();
    expect(file.hunks).toHaveLength(2);
  });

  it('clears acceptance history when manual edits rebase a file', () => {
    const file = new ReviewFile('old\n', 'accepted\n');
    file.acceptAll();
    file.undoAccept();
    file.baseline = 'manual\n';
    file.update('manual\n');
    expect(file.canRedoAccept).toBe(false);
    expect(file.canUndoAccept).toBe(false);
    file.redoAccept();
    expect(file.baseline).toBe('manual\n');
  });

  it('keeps acceptance history independent for each file and rejects stale accepts', () => {
    const first = new ReviewFile('one', 'ONE');
    const second = new ReviewFile('two', 'TWO');
    const target = first.hunks[0];
    first.acceptAll();
    second.acceptAll();
    first.undoAccept();
    expect(second.canUndoAccept).toBe(true);
    expect(second.pending).toBe(false);
    expect(() => first.accept(target.revision, target.index)).toThrow(StaleReviewError);
    expect(first.canRedoAccept).toBe(true);
    expect(first.canUndoAccept).toBe(false);
  });

  it('folds typing into the baseline while preserving a separate external hunk', () => {
    const file = new ReviewFile('one\nstable\nthree\n', 'ONE\nstable\nthree\n');
    const content = 'ONE\nstable\nmy three\n';
    const baseline = file.editorBaseline(content, [{rangeOffset: 11, rangeLength: 0, text: 'my '}]);
    expect(baseline).toBe('one\nstable\nmy three\n');
    file.baseline = baseline!;
    file.update(content);
    reject(file);
    expect(file.current).toBe('one\nstable\nmy three\n');
  });

  it('acknowledges a manually rewritten external hunk without accepting other hunks', () => {
    const file = new ReviewFile('a\nkeep\nc\n', 'AI\nkeep\nC\n');
    expect(
      file.editorBaseline('mine\nkeep\nC\n', [{rangeOffset: 0, rangeLength: 2, text: 'mine'}]),
    ).toBe('mine\nkeep\nc\n');
  });

  it.each([
    ['external insertion', 'a\nb\n', 'extra\na\nb\n', 8, 'a\nB\n'],
    ['external deletion', 'extra\na\nb\n', 'a\nb\n', 2, 'extra\na\nB\n'],
    ['CRLF and unicode', '🐈\r\nb\r\n', '🐈\r\nAI\r\nb\r\n', 8, '🐈\r\nB\r\n'],
  ])('maps manual edits after %s', (_, before, current, offset, expected) => {
    const file = new ReviewFile(before, current);
    const content = current.slice(0, offset) + 'B' + current.slice(offset + 1);
    expect(file.editorBaseline(content, [{rangeOffset: offset, rangeLength: 1, text: 'B'}])).toBe(
      expected,
    );
  });

  it('handles multiple editor selections without acknowledging a pending middle hunk', () => {
    const file = new ReviewFile('a\nkeep\nb\nkeep\nc\n', 'a\nkeep\nB\nkeep\nc\n');
    expect(
      file.editorBaseline('A\nkeep\nB\nkeep\nC\n', [
        {rangeOffset: 0, rangeLength: 1, text: 'A'},
        {rangeOffset: 14, rangeLength: 1, text: 'C'},
      ]),
    ).toBe('A\nkeep\nb\nkeep\nC\n');
  });

  it('does not acknowledge anything when editor offsets no longer match the snapshot', () => {
    const file = new ReviewFile('old', 'external');
    expect(
      file.editorBaseline('typed', [{rangeOffset: 0, rangeLength: 3, text: 'typed'}]),
    ).toBeUndefined();
    expect(file.baseline).toBe('old');
  });

  it('accepts one change without touching the working content or acknowledging another', () => {
    const file = new ReviewFile('one\nstable\nthree\n', 'ONE\nstable\nTHREE\n');
    expect(file.hunks).toHaveLength(2);
    accept(file);
    expect(file.baseline).toBe('ONE\nstable\nthree\n');
    expect(file.current).toBe('ONE\nstable\nTHREE\n');
    expect(file.hunks).toHaveLength(1);
    reject(file);
    expect(file.current).toBe('ONE\nstable\nthree\n');
    expect(file.pending).toBe(false);
  });

  it('retains accepted changes when rejecting the rest of a file', () => {
    const file = new ReviewFile('a\nb\nc\n', 'inserted\na\nb\nC\n');
    accept(file);
    expect(file.baseline).toBe('inserted\na\nb\nc\n');
    file.update(file.baseline);
    expect(file.current).toBe('inserted\na\nb\nc\n');
  });

  it.each([
    ['insert', 'a\nb\n', 'a\nnew\nb\n'],
    ['delete', 'a\nb\nc\n', 'a\nc\n'],
    ['CRLF', 'a\r\nb\r\n', 'a\r\nB\r\n'],
    ['no final newline', 'hello', 'hello world'],
    ['add final newline', 'hello', 'hello\n'],
    ['remove final newline', 'hello\n', 'hello'],
    ['empty file', '', 'hello'],
    ['delete all text', 'hello\n', ''],
    ['unicode', '🐈 café\n', '🐕 naïve\n'],
    ['repeated lines', 'a\na\na\n', 'a\nb\na\n'],
  ])('round-trips %s without losing newline or character information', (_, before, after) => {
    const accepted = new ReviewFile(before, after);
    while (accepted.pending) {
      accept(accepted);
    }
    expect(accepted.baseline).toBe(after);
    expect(accepted.current).toBe(after);
    const rejected = new ReviewFile(before, after);
    while (rejected.pending) {
      reject(rejected);
    }
    expect(rejected.current).toBe(before);
  });

  it.each(['', 'new content\n'])('distinguishes new files from existing empty files', content => {
    const file = new ReviewFile(null, content);
    expect(file.pending).toBe(true);
    expect(file.hunks).toHaveLength(1);
    reject(file);
    expect(file.current).toBeNull();
    expect(file.pending).toBe(false);
  });

  it.each(['', 'deleted content\n'])('can restore a deleted file', content => {
    const file = new ReviewFile(content, null);
    reject(file);
    expect(file.current).toBe(content);
    expect(file.pending).toBe(false);
  });

  it('accepts creation and deletion without changing the filesystem content state', () => {
    const created = new ReviewFile(null, 'new');
    accept(created);
    expect(created.baseline).toBe('new');
    const deleted = new ReviewFile('old', null);
    accept(deleted);
    expect(deleted.baseline).toBeNull();
    expect(deleted.pending).toBe(false);
  });

  it('rejects stale buttons after typing, including edit then undo back to the same text', () => {
    const file = new ReviewFile('before', 'after');
    const stale = file.hunks[0];
    file.update('later');
    file.update('after');
    expect(() => file.accept(stale.revision, stale.index)).toThrow(StaleReviewError);
    expect(() => file.rejectedContent(stale.revision, stale.index)).toThrow(StaleReviewError);
    expect(file.current).toBe('after');
  });

  it('invalidates other old buttons when an acceptance shifts the baseline', () => {
    const file = new ReviewFile('a\nb\nc\n', 'A\nb\nC\n');
    const stale = file.hunks[1];
    accept(file);
    expect(() => file.rejectedContent(stale.revision, stale.index)).toThrow(StaleReviewError);
  });

  it('keeps buttons valid across repeated watcher notifications with unchanged text', () => {
    const file = new ReviewFile('old', 'new');
    const target = file.hunks[0];
    file.update('new');
    file.accept(target.revision, target.index);
    expect(file.pending).toBe(false);
  });

  it('shows complete removed lines above replacements in the read-only preview', () => {
    const file = new ReviewFile(
      'context\nold one\nold two\ntail\n',
      'context\nreplacement\ntail\n',
    );
    expect(inlineReviewLines(file).map(({text, kind}) => [text, kind])).toEqual([
      ['context\n', 'context'],
      ['old one\n', 'removed'],
      ['old two\n', 'removed'],
      ['replacement\n', 'added'],
      ['tail\n', 'context'],
    ]);
  });

  it('keeps an empty-file creation visible in the preview', () => {
    const lines = inlineReviewLines(new ReviewFile(null, ''));
    expect(lines).toHaveLength(1);
    expect(lines[0].hunk).toBeDefined();
    expect(lines[0].kind).toBe('added');
  });

  it('handles edits in different orders without corrupting offsets', () => {
    for (let count = 1; count <= 20; count++) {
      const before = Array.from({length: count}, (_, i) => `line ${i}\r\n`).join('');
      const after = before
        .replaceAll('line 0', '🙂 new\r\nline zero')
        .replaceAll('line 3', 'changed');
      const file = new ReviewFile(before, after);
      let steps = 0;
      while (file.pending) {
        expect(++steps).toBeLessThan(100);
        accept(file, file.hunks.length - 1);
      }
      expect(file.baseline).toBe(after);
    }
  });
});
