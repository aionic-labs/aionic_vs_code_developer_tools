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
