/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {UserFragment} from './generated/graphql';

import {PullRequestReviewState} from './generated/graphql';
import reviewReRequestState, {isReReviewRequested} from './reviewReRequestState';

function user(login: string): UserFragment {
  return {__typename: 'User', id: `id-${login}`, login, avatarUrl: `https://avatars/${login}`};
}

function review(state: PullRequestReviewState, author: ReturnType<typeof user> | null) {
  return {state, author};
}

const changesRequested = (login: string) =>
  review(PullRequestReviewState.ChangesRequested, user(login));

describe('reviewReRequestState', () => {
  it('lists reviewers who requested changes as still to re-request, sorted by login', () => {
    const state = reviewReRequestState(
      [changesRequested('zoe'), changesRequested('alice')],
      [changesRequested('zoe'), changesRequested('alice')],
      [],
    );

    expect(state.toReRequest.map(({login}) => login)).toEqual(['alice', 'zoe']);
    expect(state.toReRequest[0]).toEqual(user('alice'));
    expect(state.awaitingReReview).toEqual([]);
  });

  it('moves a reviewer to awaiting once their review is requested again', () => {
    // After a re-request GitHub keeps the verdict only in the opinionated list.
    const state = reviewReRequestState(
      [changesRequested('alice'), changesRequested('bob')],
      [changesRequested('bob')],
      [{requestedReviewer: user('alice')}, {requestedReviewer: {__typename: 'Team'}}],
    );

    expect(state.toReRequest.map(({login}) => login)).toEqual(['bob']);
    expect(state.awaitingReReview.map(({login}) => login)).toEqual(['alice']);
  });

  it('leaves approvals, comments, dismissed and pending reviews alone', () => {
    const state = reviewReRequestState(
      [
        review(PullRequestReviewState.Approved, user('approver')),
        review(PullRequestReviewState.Dismissed, user('dismissed')),
      ],
      [
        review(PullRequestReviewState.Commented, user('commenter')),
        review(PullRequestReviewState.Pending, user('pending')),
        changesRequested('blocker'),
      ],
      [{requestedReviewer: user('approver')}],
    );

    expect(state.toReRequest.map(({login}) => login)).toEqual(['blocker']);
    expect(state.awaitingReReview).toEqual([]);
  });

  it('ignores reviews without a user author, null entries and duplicates', () => {
    const state = reviewReRequestState(
      [
        review(PullRequestReviewState.ChangesRequested, null),
        {
          state: PullRequestReviewState.ChangesRequested,
          author: {__typename: 'Bot', login: 'bot', avatarUrl: ''},
        },
        null,
        changesRequested('alice'),
      ],
      [changesRequested('alice'), undefined],
      [null],
    );

    expect(state.toReRequest.map(({login}) => login)).toEqual(['alice']);
  });

  it('returns nothing when nobody requested changes', () => {
    expect(reviewReRequestState([], [], [])).toEqual({toReRequest: [], awaitingReReview: []});
  });
});

describe('isReReviewRequested', () => {
  it('is true only once everyone who requested changes was asked again', () => {
    expect(isReReviewRequested({toReRequest: [], awaitingReReview: [user('alice')]})).toBe(true);
    expect(
      isReReviewRequested({toReRequest: [user('bob')], awaitingReReview: [user('alice')]}),
    ).toBe(false);
    expect(isReReviewRequested({toReRequest: [], awaitingReReview: []})).toBe(false);
  });
});
