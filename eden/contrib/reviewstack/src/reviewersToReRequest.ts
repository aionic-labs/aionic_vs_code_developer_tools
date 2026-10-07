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

function isUser(author: ReviewAuthor | null | undefined): author is UserFragment {
  return (
    author?.__typename === 'User' &&
    typeof author.id === 'string' &&
    typeof author.login === 'string' &&
    typeof author.avatarUrl === 'string'
  );
}

/**
 * Reviewers whose latest review requested changes and who are not already
 * awaiting a new review. GitHub drops a reviewer from `reviewRequests` once
 * they submit a review, so after the author addresses the feedback these are
 * the reviewers a "Re-request review" action should ask again.
 *
 * Approvals are left alone so they keep counting, and reviewers who are
 * already requested are skipped because GitHub would not notify them again.
 */
export default function reviewersToReRequest(
  latestReviews: ReadonlyArray<LatestReview>,
  reviewRequests: ReadonlyArray<ReviewRequest>,
): Array<UserFragment> {
  const requestedIDs = new Set<string>();
  for (const request of reviewRequests) {
    const reviewer = request?.requestedReviewer;
    if (reviewer?.__typename === 'User' && reviewer.id != null) {
      requestedIDs.add(reviewer.id);
    }
  }

  const reviewers: Array<UserFragment> = [];
  const seenIDs = new Set<string>();
  for (const review of latestReviews) {
    const author = review?.author;
    if (
      review?.state !== ReviewState.ChangesRequested ||
      !isUser(author) ||
      requestedIDs.has(author.id) ||
      seenIDs.has(author.id)
    ) {
      continue;
    }
    seenIDs.add(author.id);
    reviewers.push({
      __typename: 'User',
      id: author.id,
      login: author.login,
      avatarUrl: author.avatarUrl,
    });
  }

  reviewers.sort((a, b) => a.login.localeCompare(b.login));
  return reviewers;
}
