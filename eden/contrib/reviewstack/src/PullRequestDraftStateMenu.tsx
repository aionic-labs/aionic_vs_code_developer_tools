/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {PullRequestReviewDecision, PullRequestState, UserFragment} from './generated/graphql';

import PullRequestStateLabel from './PullRequestStateLabel';
import {PullRequestState as PullRequestStateValue} from './generated/graphql';
import {gitHubClientAtom, notificationMessageAtom} from './jotai';
import pullRequestStatusAndLabel from './pullRequestStatusAndLabel';
import useRefreshPullRequest from './useRefreshPullRequest';
import {ActionList, ActionMenu, Button, StateLabel} from '@primer/react';
import {useAtomValue, useSetAtom} from 'jotai';
import {useCallback, useState} from 'react';

export default function PullRequestDraftStateMenu({
  awaitingReReview,
  id,
  isDraft,
  reRequestReviewers,
  reviewDecision,
  state,
  viewerCanUpdate,
}: {
  /** Reviewers who requested changes and were already asked again, see reviewReRequestState(). */
  awaitingReReview: ReadonlyArray<UserFragment>;
  id: string;
  isDraft: boolean;
  /** Reviewers who requested changes and can be asked again, see reviewReRequestState(). */
  reRequestReviewers: ReadonlyArray<UserFragment>;
  reviewDecision: PullRequestReviewDecision | null;
  state: PullRequestState;
  viewerCanUpdate: boolean;
}): React.ReactElement {
  const client = useAtomValue(gitHubClientAtom);
  const refreshPullRequest = useRefreshPullRequest();
  const setNotification = useSetAtom(notificationMessageAtom);
  const [updating, setUpdating] = useState(false);

  const updateDraftState = useCallback(
    async (nextIsDraft: boolean) => {
      if (client == null || nextIsDraft === isDraft) {
        return;
      }
      setUpdating(true);
      try {
        if (nextIsDraft) {
          await client.convertPullRequestToDraft({pullRequestId: id});
        } else {
          await client.markPullRequestReadyForReview({pullRequestId: id});
        }
        refreshPullRequest();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setNotification({
          type: 'error',
          message: `Failed to update pull request state: ${message}`,
        });
      } finally {
        setUpdating(false);
      }
    },
    [client, id, isDraft, refreshPullRequest, setNotification],
  );

  const reRequestLogins = reRequestReviewers.map(({login}) => login).join(', ');
  const awaitingLogins = awaitingReReview.map(({login}) => login).join(', ');
  // Only once everyone who requested changes has been asked again does the
  // pull request read as waiting for a re-review rather than blocked.
  const reReviewRequested = awaitingReReview.length > 0 && reRequestReviewers.length === 0;
  const reRequestReview = useCallback(async () => {
    if (client == null || reRequestReviewers.length === 0) {
      return;
    }
    setUpdating(true);
    try {
      // `union` adds to the pending requests instead of replacing them, so
      // reviewers who are still waiting to review are left untouched.
      await client.requestReviews({
        pullRequestId: id,
        userIds: reRequestReviewers.map(({id}) => id),
        union: true,
      });
      setNotification({
        type: 'info',
        message: `Re-requested review from ${reRequestLogins}`,
      });
      refreshPullRequest();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotification({
        type: 'error',
        message: `Failed to re-request review: ${message}`,
      });
    } finally {
      setUpdating(false);
    }
  }, [client, id, reRequestLogins, reRequestReviewers, refreshPullRequest, setNotification]);

  if (state !== PullRequestStateValue.Open || !viewerCanUpdate) {
    return (
      <PullRequestStateLabel
        isDraft={isDraft}
        reReviewRequested={reReviewRequested}
        reviewDecision={reviewDecision}
        state={state}
      />
    );
  }

  const {label, color} = pullRequestStatusAndLabel(state, reviewDecision, isDraft, {
    reReviewRequested,
  });
  return (
    <ActionMenu>
      <ActionMenu.Anchor>
        <Button
          aria-label={`${label}. Change pull request state`}
          disabled={updating}
          variant="invisible"
          sx={{height: 'auto', padding: 0}}>
          <StateLabel
            status="pullOpened"
            sx={{backgroundColor: color, cursor: updating ? 'wait' : 'pointer'}}>
            {label}
          </StateLabel>
        </Button>
      </ActionMenu.Anchor>
      <ActionMenu.Overlay width="small">
        <ActionList selectionVariant="single">
          <ActionList.Item
            selected={isDraft}
            disabled={updating || isDraft}
            onSelect={() => updateDraftState(true)}>
            Convert to draft
          </ActionList.Item>
          <ActionList.Item
            selected={!isDraft}
            disabled={updating || !isDraft}
            onSelect={() => updateDraftState(false)}>
            Mark ready for review
          </ActionList.Item>
          <ActionList.Divider />
          <ActionList.Group selectionVariant={false}>
            <ActionList.Item
              disabled={updating || reRequestReviewers.length === 0}
              onSelect={reRequestReview}>
              Re-request review
              <ActionList.Description variant="block">
                {reRequestReviewers.length > 0
                  ? `from ${reRequestLogins}`
                  : awaitingReReview.length > 0
                  ? `Waiting for ${awaitingLogins} to review again`
                  : 'No reviewer has requested changes'}
              </ActionList.Description>
            </ActionList.Item>
          </ActionList.Group>
        </ActionList>
      </ActionMenu.Overlay>
    </ActionMenu>
  );
}
