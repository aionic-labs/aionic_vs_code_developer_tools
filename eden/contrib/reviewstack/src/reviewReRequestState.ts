/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {PullRequestReviewState, UserFragment} from './generated/graphql';

import {PullRequestReviewState as ReviewState} from './generated/graphql';

/**
 * Loose shapes of the generated query types: GitHub actors other than users
 * carry only an optional `__typename`, and the user fields are only present on
 * the `User` branch.
 */
type ReviewAuthor = {
  __typename?: string;
  id?: string;
  login?: string;
  avatarUrl?: string;
};

type LatestReview =
  | {
      state: PullRequestReviewState;
      author?: ReviewAuthor | null;
    }
  | null
  | undefined;

type ReviewRequest =
  | {
      requestedReviewer?: {__typename?: string; id?: string} | null;
    }
  | null
  | undefined;

export type ReviewReRequestState = {
  /** Reviewers who requested changes and have not been asked to review again. */
  toReRequest: Array<UserFragment>;
  /** Reviewers who requested changes and now have a pending review request. */
  awaitingReReview: Array<UserFragment>;
};

function isUser(author: ReviewAuthor | null | undefined): author is UserFragment {
  return (
    author?.__typename === 'User' &&
    typeof author.id === 'string' &&
    typeof author.login === 'string' &&
    typeof author.avatarUrl === 'string'
  );
}

/**
 * Splits the reviewers whose latest review requested changes by whether a new
 * review has already been requested from them.
 *
 * Once a review is re-requested, GitHub drops the reviewer from
 * `latestReviews` and lists them in `reviewRequests` again, but keeps their
 * "changes requested" verdict in `latestOpinionatedReviews` and in the pull
 * request's reviewDecision until they review again. Reading both review lists
 * finds everyone who requested changes before and after a re-request.
 * Approvals are left alone so they keep counting.
 */
export default function reviewReRequestState(
  latestOpinionatedReviews: ReadonlyArray<LatestReview>,
  latestReviews: ReadonlyArray<LatestReview>,
  reviewRequests: ReadonlyArray<ReviewRequest>,
): ReviewReRequestState {
  const requestedIDs = new Set<string>();
  for (const request of reviewRequests) {
    const reviewer = request?.requestedReviewer;
    if (reviewer?.__typename === 'User' && reviewer.id != null) {
      requestedIDs.add(reviewer.id);
    }
  }

  const toReRequest: Array<UserFragment> = [];
  const awaitingReReview: Array<UserFragment> = [];
  const seenIDs = new Set<string>();
  for (const review of [...latestOpinionatedReviews, ...latestReviews]) {
    const author = review?.author;
    if (
      review?.state !== ReviewState.ChangesRequested ||
      !isUser(author) ||
      seenIDs.has(author.id)
    ) {
      continue;
    }
    seenIDs.add(author.id);
    const user: UserFragment = {
      __typename: 'User',
      id: author.id,
      login: author.login,
      avatarUrl: author.avatarUrl,
    };
    if (requestedIDs.has(author.id)) {
      awaitingReReview.push(user);
    } else {
      toReRequest.push(user);
    }
  }

  const byLogin = (a: UserFragment, b: UserFragment) => a.login.localeCompare(b.login);
  toReRequest.sort(byLogin);
  awaitingReReview.sort(byLogin);
  return {toReRequest, awaitingReReview};
}
