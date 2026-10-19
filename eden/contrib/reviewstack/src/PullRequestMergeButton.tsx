/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {PullRequest} from './github/pullRequestTimelineTypes';
import type {PullRequestLandingProgress} from './pullRequestMerge';

import {
  gitHubClientAtom,
  notificationMessageAtom,
  stackLandingClientAtom,
  stackedPullRequestFragmentsAtom,
} from './jotai';
import {buildPullRequestMergePlan, landPullRequestStack} from './pullRequestMerge';
import useRefreshPullRequest from './useRefreshPullRequest';
import {Button, Tooltip} from '@primer/react';
import {useAtomValue, useSetAtom} from 'jotai';
import {loadable} from 'jotai/utils';
import {useEffect, useMemo, useState} from 'react';

const loadableStackedPullRequestFragmentsAtom = loadable(stackedPullRequestFragmentsAtom);

export default function PullRequestMergeButton({
  pullRequest,
}: {
  pullRequest: PullRequest;
}): React.ReactElement | null {
  const client = useAtomValue(gitHubClientAtom);
  const lander = useAtomValue(stackLandingClientAtom);
  const stackLoadable = useAtomValue(loadableStackedPullRequestFragmentsAtom);
  const setNotification = useSetAtom(notificationMessageAtom);
  const refreshPullRequest = useRefreshPullRequest();
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<PullRequestLandingProgress | null>(null);
  const landing = progress != null;

  // Landing runs in this tab. Leaving it stops after the current step, which
  // is safe to resume, but warn so the stack is not left half landed by accident.
  useEffect(() => {
    if (!landing) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [landing]);

  const stack = useMemo(() => {
    if (stackLoadable.state !== 'hasData') {
      return null;
    }
    const loadedStack = stackLoadable.data;
    return loadedStack.some(({number}) => number === pullRequest.number)
      ? loadedStack
      : [pullRequest];
  }, [pullRequest, stackLoadable]);
  const plan = useMemo(
    () => (stack == null ? null : buildPullRequestMergePlan(stack, pullRequest.number)),
    [pullRequest.number, stack],
  );

  if (pullRequest.state !== 'OPEN') {
    return null;
  }

  const stackError =
    stackLoadable.state === 'hasError'
      ? stackLoadable.error instanceof Error
        ? stackLoadable.error.message
        : String(stackLoadable.error)
      : null;
  const disabledReason =
    stackLoadable.state === 'loading'
      ? 'Loading the Sapling stack.'
      : stackLoadable.state === 'hasError'
      ? `Could not load the Sapling stack: ${stackError}`
      : plan != null && plan.blockers.length > 0
      ? plan.blockers.join(' ')
      : plan?.pullRequests.length === 0
      ? 'There are no open pull requests to merge.'
      : null;
  const disabled =
    client == null || lander == null || checking || landing || disabledReason != null;
  const count = plan?.totalPullRequests ?? 0;
  const label = checking
    ? 'Checking stack…'
    : progress == null
    ? count > 1
      ? `Merge ${count} commits to main`
      : 'Merge to main'
    : landingLabel(progress);

  const merge = async (): Promise<void> => {
    if (
      client == null ||
      lander == null ||
      plan == null ||
      disabled ||
      plan.pullRequests.length === 0
    ) {
      return;
    }
    let completed = 0;
    let freshPlan = plan;
    setChecking(true);
    try {
      const selectedIndex = stack?.findIndex(({number}) => number === pullRequest.number) ?? -1;
      const expectedNumbers = (stack ?? []).slice(selectedIndex).map(({number}) => number);
      const freshStack = await client.getFreshStackPullRequests(expectedNumbers);
      const freshNumbers = new Set(freshStack.map(({number}) => number));
      const missingNumbers = expectedNumbers.filter(number => !freshNumbers.has(number));
      if (missingNumbers.length > 0) {
        throw new Error(
          `GitHub did not return ${missingNumbers.map(number => `#${number}`).join(', ')}.`,
        );
      }
      freshPlan = buildPullRequestMergePlan(freshStack, pullRequest.number);
      if (freshPlan.blockers.length > 0 || freshPlan.pullRequests.length === 0) {
        throw new Error(
          freshPlan.blockers.join(' ') || 'There are no open pull requests to merge.',
        );
      }
      const lines = freshPlan.pullRequests
        .map(({number, title}) => `#${number} ${title}`)
        .join('\n');
      const many = freshPlan.pullRequests.length > 1;
      const confirmed = window.confirm(
        `Squash-merge ${freshPlan.pullRequests.length} approved pull request${
          many ? 's' : ''
        } into main, oldest first?\n\n${lines}${
          many
            ? '\n\nAfter each merge ReviewStack restacks the next pull request onto main, ' +
              'like sl rebase and sl pr submit, and merges it once its required checks pass. ' +
              'Keep this tab open until it finishes. If it stops, click the button again to continue.'
            : ''
        }\n\nIf one merge fails, later pull requests will not be merged.`,
      );
      if (!confirmed) {
        return;
      }

      setChecking(false);
      setProgress({
        completed,
        total: freshPlan.pullRequests.length,
        number: freshPlan.pullRequests[0].number,
        phase: 'merging',
      });
      await landPullRequestStack({
        client,
        lander,
        pullRequests: freshPlan.pullRequests,
        onProgress: nextProgress => {
          completed = nextProgress.completed;
          setProgress(nextProgress);
        },
      });
      setNotification({
        type: 'info',
        message: `Merged ${freshPlan.pullRequests.length} pull request${
          freshPlan.pullRequests.length === 1 ? '' : 's'
        } into main.`,
      });
    } catch (error) {
      const message = describeLandingError(error);
      setNotification({
        type: 'error',
        message: `Merged ${completed} of ${freshPlan.pullRequests.length}. Stopped: ${message}`,
      });
    } finally {
      setChecking(false);
      setProgress(null);
      refreshPullRequest();
    }
  };

  const button = (
    <Button disabled={disabled} onClick={merge} variant="primary">
      {label}
    </Button>
  );
  return disabledReason == null ? button : <Tooltip text={disabledReason}>{button}</Tooltip>;
}

function landingLabel({completed, total, number, phase}: PullRequestLandingProgress): string {
  const position = `${Math.min(completed + 1, total)} of ${total}`;
  switch (phase) {
    case 'restacking':
      return `Restacking #${number} (${position})…`;
    case 'waiting':
      return `Waiting for checks on #${number} (${position})…`;
    case 'merging':
      return `Merging #${number} (${position})…`;
  }
}

function describeLandingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // GitHub refuses branch updates that touch workflow files unless the app
  // may change workflows.
  return /workflow/i.test(message) && /permission|refusing/i.test(message)
    ? `${message} The ReviewStack GitHub App needs the Workflows permission to restack pull requests that change workflow files.`
    : message;
}
