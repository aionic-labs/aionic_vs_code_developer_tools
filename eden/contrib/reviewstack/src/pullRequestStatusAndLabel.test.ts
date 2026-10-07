/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {PullRequestReviewDecision, PullRequestState} from './generated/graphql';
import pullRequestStatusAndLabel from './pullRequestStatusAndLabel';

describe('pullRequestStatusAndLabel', () => {
  it.each([
    [null, 'Review Required', 'attention.fg'],
    [PullRequestReviewDecision.Approved, 'Approved', 'success.fg'],
    [PullRequestReviewDecision.ChangesRequested, 'Changes Req.', 'danger.fg'],
    [PullRequestReviewDecision.ReviewRequired, 'Review Required', 'attention.fg'],
  ])('formats an open pull request with decision %s', (decision, label, color) => {
    expect(pullRequestStatusAndLabel(PullRequestState.Open, decision, false)).toEqual({
      status: 'pullOpened',
      label,
      color,
    });
  });

  it('shows a teal re-requested state once changes-requested reviewers were asked again', () => {
    expect(
      pullRequestStatusAndLabel(
        PullRequestState.Open,
        PullRequestReviewDecision.ChangesRequested,
        false,
        {reReviewRequested: true},
      ),
    ).toEqual({status: 'pullOpened', label: 'Review Re-requested', color: '#0f766e'});
  });

  it('ignores the re-requested flag unless changes were requested', () => {
    expect(
      pullRequestStatusAndLabel(PullRequestState.Open, PullRequestReviewDecision.Approved, false, {
        reReviewRequested: true,
      }),
    ).toEqual({status: 'pullOpened', label: 'Approved', color: 'success.fg'});
    expect(
      pullRequestStatusAndLabel(
        PullRequestState.Open,
        PullRequestReviewDecision.ChangesRequested,
        true,
        {reReviewRequested: true},
      ),
    ).toEqual({status: 'pullOpened', label: 'Draft Review', color: 'fg.muted'});
  });

  it('shows draft state before the review decision', () => {
    expect(
      pullRequestStatusAndLabel(PullRequestState.Open, PullRequestReviewDecision.Approved, true),
    ).toEqual({status: 'pullOpened', label: 'Draft Review', color: 'fg.muted'});
  });
});
