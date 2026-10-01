# Aionic inline change review

Review edits from your editor, an AI coding tool, or another process without making
a commit. This is a local review session, independent of Sapling's working-copy diff.

## Try the local build

1. In **Visual Studio Code**, disable the original **Sapling SCM** extension
   (`meta.sapling-scm`) and Diffus for the test workspace. They overlap in commands
   or decorations; do not run both Sapling extensions together.
2. Run **Extensions: Install from VSIX…** and choose
   `addons/vscode/aionic-sapling-inline-review.vsix` from this checkout.
3. Reload VS Code and open a trusted local workspace. The package identifies as
   **Aionic Sapling** (`aioniclabs.sapling-scm`), not Meta's extension.
4. Wait for the status bar to show **Review: 0 files**, then edit a file or let your
   coding tool change it. Click the status item to list changed files.

Installation is manual: building the package does not install it, publish it, open
a pull request, or change your other extensions. Use VS Code's UI, not an ambiguous
`code` shell alias that might point to Cursor.

## Review a change

The normal editable file shows green changed lines, a red summary of removed text,
and **Accept**, **Reject**, and **Review −N / +N** controls above each change.
Hover the removal summary to read the old text. Enable `editor.codeLens` if these
controls are hidden; the same actions are available from the Command Palette.

Click **Review −N / +N** to open a read-only inline review: complete removed lines
appear in red directly above their green replacements. Accept/Reject works there
too. This view is deliberately separate from the editable document; removed lines
are never inserted into your working file to render a diff.

- **Accept** moves just that change into the review baseline. Your code is untouched.
- **Reject** restores just that change's previous content using VS Code's edit API.
  Text edits remain unsaved and support normal editor undo/redo.
- **Accept All Changes in File** acknowledges the current file.
- **Reject All Changes in File** restores the remaining unaccepted changes after
  confirmation. Previously accepted changes stay intact.
- New-file rejection deletes that file; deleted-file rejection recreates it.
  Both require confirmation. Creation/deletion is reviewed as one whole-file change.

Changes are contiguous line-based hunks, not individual keystrokes. Adjacent edits
may form one hunk. New edits to a previously accepted line appear as new changes.
Stale per-change actions are refused if the file changed after the button was shown.

## Navigate

Use the editor-title arrows or these default shortcuts (Alt is Option on macOS):

| Action                | Shortcut    |
| --------------------- | ----------- |
| Next change           | Alt+]       |
| Previous change       | Alt+[       |
| Next changed file     | Alt+Shift+] |
| Previous changed file | Alt+Shift+[ |

Navigation wraps through pending files in path order. It remains available after
you finish the current file. The status-bar file picker opens the full inline
review. Every action is also available under **Aionic Sapling: Inline Review** in
the Command Palette, including when a deleted file has no normal editor tab.

## What is the baseline?

On first activation, the extension snapshots eligible files as they currently
exist, including unsaved open buffers. Existing uncommitted edits become part of
that starting baseline; this feature does **not** reinterpret them against HEAD.
Subsequent editor and filesystem changes are compared with those snapshots.

Baselines and tracking state are saved in VS Code's local workspace storage and
restored after reload. Pending changes made while the editor was closed are detected
on restart for previously tracked files. A previously unknown file first found on
restart becomes a new baseline, rather than an inferred file-creation event.

**Start Tracking** adds snapshots for currently untracked files and resumes watching
for new files without acknowledging existing changes. **Pause New File Tracking**
stops discovering new files; already tracked files stay live and reviewable. Set
`sapling.inlineReview.enabled` to `false` and reload to prevent automatic discovery.
Existing snapshots remain available. Disable the extension to stop it completely.

Snapshots contain source text and remain local to VS Code's workspace storage.
The review feature performs no network calls and invokes no Sapling/Git commands.
Accepting a change is not staging, committing, or submitting it. Existing Sapling
commands remain separate and retain their usual behavior.

## Current boundaries

- Trusted **local file** workspaces, including multiple workspace folders.
- UTF-8 text files up to 512 KiB; at most 2,000 files and a 16 MiB snapshot budget
  reserved for baselines and current text. Unsupported/excess files are skipped.
  Initial skips produce a warning; the status tooltip reports skipped files.
  If accepting an insertion before a deletion would exceed the baseline limit,
  accept the deletion first or accept the entire file.
- Symlinks, binary files, and `.git`, `.sl`, `.hg`, `node_modules`, `.venv`, `venv`,
  `dist`, `build`, `target`, and `__pycache__` directories are excluded. These are
  explicit exclusions, not an implementation of every repository ignore rule.
- File renames are represented as deletion plus creation. Review is a current
  baseline comparison, not a complete history of every intermediate edit.
- The full red/green review is read-only. The editable file uses decorations and
  CodeLens, not Cursor's private editor widgets.
- This build uses stable VS Code APIs. The upstream proposed multi-diff title menu
  is omitted because the new Aionic extension ID is not in Meta's API allowlist;
  the existing command itself remains available.

## Build and test

From `addons/`, using Yarn 1 and the repository's supported Node environment:

```sh
npx --yes yarn@1.22.22 install --frozen-lockfile
npx --yes yarn@1.22.22 --cwd vscode test --runInBand
./node_modules/.bin/tsc --noEmit -p vscode/tsconfig.json
npx --yes yarn@1.22.22 --cwd vscode package-local
```

`package-local` builds the extension and webview, then creates a VSIX. It does not
publish anything. Unit tests cover partial decisions, exact newline preservation,
creation/deletion, stale actions, dirty buffers, watcher races, persistence, trust,
and snapshot limits.

An additional real-editor smoke test lives at
`extension/__tests__/inlineReview.smoke.cjs`. Launch VS Code with this directory as
`--extensionDevelopmentPath`, that file as `--extensionTestsPath`, isolated
`--user-data-dir` and `--extensions-dir`, and `--disable-extensions`. Use an **empty
temporary workspace** beneath a directory named `aionic-inline-review-smoke.*`;
the test refuses other paths. It creates and edits fixture files. This tests the
actual extension host, external changes, editable CodeLens, partial decisions,
undo, preview updates, and navigation without modifying your normal VS Code profile.
The smoke test first checks native Undo in an unrelated scratch buffer. If the
automated host cannot dispatch Undo even there, it explicitly skips that check;
verify Undo manually in the editable source file instead.
