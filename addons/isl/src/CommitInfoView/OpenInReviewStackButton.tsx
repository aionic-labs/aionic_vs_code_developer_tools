import type {CommitInfo} from '../types';

import {Button} from 'isl-components/Button';
import {Icon} from 'isl-components/Icon';
import {useAtomValue} from 'jotai';
import {codeReviewProvider, diffSummary} from '../codeReview/CodeReviewInfo';
import {T} from '../i18n';
import platform from '../platform';

/** Open the selected commit's PR in Aionic's ReviewStack deployment. */
export function OpenInReviewStackButton({commit}: {commit: CommitInfo}) {
  const provider = useAtomValue(codeReviewProvider);
  const summary = useAtomValue(diffSummary(commit.diffId)).value;
  const system = provider?.system;
  if (
    system?.type !== 'github' ||
    system.hostname !== 'github.com' ||
    commit.diffId == null ||
    !/^[1-9]\d*$/.test(commit.diffId)
  ) {
    return null;
  }

  // The fetched URL reflects repository renames and the PR's actual destination.
  // Until it loads, use the same repository and diff ID as the commit's PR badge.
  const canonical =
    summary?.type === 'github'
      ? /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(summary.url)
      : null;
  const owner = canonical?.[3] === commit.diffId ? canonical[1] : system.owner;
  const repo = canonical?.[3] === commit.diffId ? canonical[2] : system.repo;
  const url = `https://review.aioniclabs.dev/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull/${commit.diffId}`;

  return (
    <div className="button-row">
      <Button icon onClick={() => platform.openExternalLink(url)}>
        <Icon icon="link-external" slot="start" />
        <T>Open in ReviewStack</T>
      </Button>
    </div>
  );
}
