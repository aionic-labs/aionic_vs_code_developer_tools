/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {PullRequestReviewDecision, PullRequestState} from './generated/graphql';

type Status = 'pullClosed' | 'pullMerged' | 'pullOpened';

/**
 * Teal for a pull request whose "changes requested" reviewers were all asked
 * to review again. Primer has no teal token, and the color must stay distinct
 * from the attention yellow of "Review Required" and the danger red of
 * "Changes Req." in both color modes.
 */
export const RE_REVIEW_REQUESTED_COLOR = '#0f766e';

export default function pullRequestStatusAndLabel(
  state: PullRequestState,
  reviewDecision: PullRequestReviewDecision | null | undefined,
  isDraft: boolean,
  options: {
    /** Every reviewer who requested changes has a pending review request. */
    reReviewRequested?: boolean;
  } = {},
): {
  status: Status;
  label: string;
  color?: string;
} {
  switch (state) {
    case PullRequestState.Closed:
      return {status: 'pullClosed', label: 'Closed'};
    case PullRequestState.Merged:
      return {status: 'pullMerged', label: 'Merged'};
    case PullRequestState.Open: {
      const status = 'pullOpened';
      if (isDraft) {
        return {status, label: 'Draft Review', color: 'fg.muted'};
      }
      switch (reviewDecision) {
        case PullRequestReviewDecision.Approved:
          return {status, label: 'Approved', color: 'success.fg'};
        case PullRequestReviewDecision.ChangesRequested:
          if (options.reReviewRequested) {
            return {status, label: 'Review Re-requested', color: RE_REVIEW_REQUESTED_COLOR};
          }
          return {status, label: 'Changes Req.', color: 'danger.fg'};
        case PullRequestReviewDecision.ReviewRequired:
        case null:
        case undefined:
          return {status, label: 'Review Required', color: 'attention.fg'};
      }
    }
  }
}
