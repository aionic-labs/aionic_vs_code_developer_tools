/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {PullRequestReviewState} from './generated/graphql';
import reviewersToReRequest from './reviewersToReRequest';

function user(login: string) {
  return {__typename: 'User', id: `id-${login}`, login, avatarUrl: `https://avatars/${login}`};
}

function review(state: PullRequestReviewState, author: ReturnType<typeof user> | null) {
  return {state, author};
}

describe('reviewersToReRequest', () => {
  it('returns reviewers whose latest review requested changes, sorted by login', () => {
    const reviewers = reviewersToReRequest(
      [
        review(PullRequestReviewState.ChangesRequested, user('zoe')),
        review(PullRequestReviewState.ChangesRequested, user('alice')),
      ],
      [],
    );

    expect(reviewers.map(({login}) => login)).toEqual(['alice', 'zoe']);
    expect(reviewers[0]).toEqual(user('alice'));
  });

  it('leaves approvals, comments, dismissed and pending reviews alone', () => {
    const reviewers = reviewersToReRequest(
      [
        review(PullRequestReviewState.Approved, user('approver')),
        review(PullRequestReviewState.Commented, user('commenter')),
        review(PullRequestReviewState.Dismissed, user('dismissed')),
        review(PullRequestReviewState.Pending, user('pending')),
        review(PullRequestReviewState.ChangesRequested, user('blocker')),
      ],
      [],
    );

    expect(reviewers.map(({login}) => login)).toEqual(['blocker']);
  });

  it('skips reviewers whose review is already requested again', () => {
    const reviewers = reviewersToReRequest(
      [
        review(PullRequestReviewState.ChangesRequested, user('alice')),
        review(PullRequestReviewState.ChangesRequested, user('bob')),
      ],
      [{requestedReviewer: user('alice')}, {requestedReviewer: {__typename: 'Team'}}],
    );

    expect(reviewers.map(({login}) => login)).toEqual(['bob']);
  });

  it('ignores reviews without a user author and null entries', () => {
    const reviewers = reviewersToReRequest(
      [
        review(PullRequestReviewState.ChangesRequested, null),
        {
          state: PullRequestReviewState.ChangesRequested,
          author: {__typename: 'Bot', login: 'bot', avatarUrl: ''},
        },
        null,
        review(PullRequestReviewState.ChangesRequested, user('alice')),
        review(PullRequestReviewState.ChangesRequested, user('alice')),
      ],
      [null],
    );

    expect(reviewers.map(({login}) => login)).toEqual(['alice']);
  });

  it('returns nothing when nobody requested changes', () => {
    expect(reviewersToReRequest([], [])).toEqual([]);
    expect(
      reviewersToReRequest([review(PullRequestReviewState.Approved, user('alice'))], []),
    ).toEqual([]);
  });
});
