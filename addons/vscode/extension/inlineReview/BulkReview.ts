import type {ReviewSession} from './ReviewSession';

import * as vscode from 'vscode';

export type HunkTarget = {uri: string; revision: number; index: number};

/** Capture decisions before confirmation; never include edits arriving during the action. */
export async function reviewAllFiles(
  session: Pick<ReviewSession, 'pending' | 'reviewable' | 'notify'>,
  action: 'accept' | 'reject',
  reject: (uri: vscode.Uri, target: HunkTarget, baseline: string | null) => Promise<void>,
): Promise<void> {
  const targets = session.pending.map(([uri, file]) => ({
    uri,
    revision: file.hunks[0].revision,
    index: 0,
  }));
  if (targets.length === 0) {
    void vscode.window.showInformationMessage('No unreviewed changes.');
    return;
  }
  if (action === 'reject') {
    const answer = await vscode.window.showWarningMessage(
      `Reject all unreviewed changes in ${targets.length} files?`,
      {
        modal: true,
        detail:
          'Previously accepted changes and manual edits are kept. Newly created files will be deleted; deleted files will be restored.',
      },
      'Reject all changes',
    );
    if (answer !== 'Reject all changes') {
      return;
    }
  }

  let completed = 0;
  const failed: string[] = [];
  for (const target of targets) {
    const uri = vscode.Uri.parse(target.uri);
    try {
      // Deliberately sequential: each file gets its own editor undo operation.
      // eslint-disable-next-line no-await-in-loop
      const file = await session.reviewable(uri);
      file.resolve(target.revision, target.index);
      if (action === 'accept') {
        file.acceptAll();
      } else {
        // eslint-disable-next-line no-await-in-loop
        await reject(uri, target, file.baseline);
      }
      completed++;
    } catch (error) {
      failed.push(
        `${vscode.workspace.asRelativePath(uri)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  session.notify();
  const message = `${action === 'accept' ? 'Accepted' : 'Rejected'} changes in ${completed} files.`;
  if (failed.length > 0) {
    void vscode.window.showWarningMessage(
      `${message} ${failed.length} files could not be completed. Review their remaining changes.\n${failed.join('\n')}`,
    );
  } else {
    void vscode.window.showInformationMessage(message);
  }
}
