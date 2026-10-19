/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {StackPullRequestFragment} from './generated/graphql';
import type GitHubClient from './github/GitHubClient';
import type StackLandingClient from './github/StackLandingClient';
import type {GitCommitObject, LandingPullRequestState} from './github/StackLandingClient';
import type {GitObjectID, ID} from './github/types';

import effectivePullRequestReviewDecision from './effectivePullRequestReviewDecision';
import {
  MergeableState,
  PullRequestMergeMethod,
  PullRequestReviewDecision,
  PullRequestState,
  StatusState,
} from './generated/graphql';

export type PullRequestMergeCandidate = Pick<
  StackPullRequestFragment,
  | 'baseRefName'
  | 'headRefOid'
  | 'id'
  | 'isDraft'
  | 'latestReviews'
  | 'mergeable'
  | 'number'
  | 'reviewDecision'
  | 'state'
  | 'title'
  | 'viewerCanUpdate'
>;

export type PullRequestMergeStep = PullRequestMergeCandidate & {
  /**
   * Head of the next older pull request in the Sapling stack, merged or not.
   * Its commits are the ones this pull request must drop once that older pull
   * request is squash-merged.
   */
  previousHeadOid: GitObjectID | null;
};

export type PullRequestMergePlan = {
  blockers: string[];
  pullRequests: PullRequestMergeStep[];
  totalPullRequests: number;
};

/**
 * Sapling writes stack entries from newest to oldest. Landing a selected
 * change therefore means taking the suffix that starts at that change and
 * reversing it so GitHub receives merge requests from the root upward.
 */
export function buildPullRequestMergePlan(
  stack: PullRequestMergeCandidate[],
  selectedPullRequest: number,
): PullRequestMergePlan {
  const selectedIndex = stack.findIndex(({number}) => number === selectedPullRequest);
  if (selectedIndex === -1) {
    return {
      blockers: ['The selected pull request is missing from its Sapling stack.'],
      pullRequests: [],
      totalPullRequests: 0,
    };
  }

  const blockers: string[] = [];
  const pullRequests: PullRequestMergeStep[] = [];
  let totalPullRequests = 0;
  let previousHeadOid: GitObjectID | null = null;
  stack
    .slice(selectedIndex)
    .reverse()
    .forEach(pullRequest => {
      const step = {...pullRequest, previousHeadOid};
      previousHeadOid = pullRequest.headRefOid;
      const label = `#${pullRequest.number}`;
      if (pullRequest.state === PullRequestState.Merged) {
        return;
      }
      if (pullRequest.state !== PullRequestState.Open) {
        blockers.push(`${label} is closed without being merged.`);
        return;
      }
      totalPullRequests++;
      if (!pullRequest.viewerCanUpdate) {
        blockers.push(`You do not have permission to merge ${label}.`);
        return;
      }
      if (pullRequest.baseRefName !== 'main') {
        blockers.push(`${label} targets ${pullRequest.baseRefName}, not main.`);
        return;
      }
      if (pullRequest.isDraft) {
        blockers.push(`${label} is still a draft.`);
        return;
      }
      const reviewDecision = effectivePullRequestReviewDecision(
        pullRequest.reviewDecision,
        pullRequest.latestReviews?.nodes ?? [],
      );
      if (reviewDecision !== PullRequestReviewDecision.Approved) {
        blockers.push(`${label} is not approved.`);
        return;
      }
      // A pull request above another one in the stack still contains the
      // older commits, so GitHub reports a conflict once the older pull
      // request is squash-merged. Landing restacks it first, so only the
      // bottom of the stack can be blocked by a conflict here.
      if (step.previousHeadOid == null && pullRequest.mergeable === MergeableState.Conflicting) {
        blockers.push(`${label} has merge conflicts.`);
        return;
      }
      pullRequests.push(step);
    });

  return {blockers, pullRequests, totalPullRequests};
}

export type PullRequestLandingPhase = 'restacking' | 'waiting' | 'merging';

export type PullRequestLandingProgress = {
  completed: number;
  total: number;
  number: number;
  phase: PullRequestLandingPhase;
};

export type PullRequestLandingOptions = {
  client: Pick<GitHubClient, 'mergePullRequest'>;
  lander: StackLandingClient;
  pullRequests: PullRequestMergeStep[];
  onProgress?: (progress: PullRequestLandingProgress) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  /** How long to wait for one pull request's checks before giving up. */
  checksTimeoutMs?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_CHECKS_TIMEOUT_MS = 45 * 60_000;

/**
 * Lands a Sapling stack one squash-merge at a time, oldest first.
 *
 * Each Sapling pull request contains the commits of the pull requests below
 * it. After an older pull request is squash-merged, ReviewStack does on GitHub
 * what `sl rebase -d main` and `sl pr submit` would do locally: it replaces the
 * next pull request's branch with a single commit on top of main that carries
 * only that pull request's changes. It then waits for the required checks on
 * the new commit and squash-merges it.
 */
export async function landPullRequestStack({
  client,
  lander,
  pullRequests,
  onProgress,
  sleep = defaultSleep,
  now = Date.now,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  checksTimeoutMs = DEFAULT_CHECKS_TIMEOUT_MS,
}: PullRequestLandingOptions): Promise<void> {
  const total = pullRequests.length;
  for (let index = 0; index < total; index++) {
    const step = pullRequests[index];
    const report = (phase: PullRequestLandingPhase) =>
      onProgress?.({completed: index, total, number: step.number, phase});
    // Stack landing must be ordered because every successful merge changes main.
    // eslint-disable-next-line no-await-in-loop
    const state = await lander.getPullRequestState(step.number);
    if (state.merged) {
      continue;
    }
    if (state.headRefOid !== step.headRefOid) {
      throw new Error(`#${step.number} changed on GitHub after the merge started.`);
    }
    // eslint-disable-next-line no-await-in-loop
    const headOid = await restackPullRequest(lander, step, state, now, () => report('restacking'));
    // eslint-disable-next-line no-await-in-loop
    await mergeWhenReady({
      client,
      lander,
      step,
      headOid,
      report,
      sleep,
      now,
      pollIntervalMs,
      deadline: now() + checksTimeoutMs,
    });
    onProgress?.({completed: index + 1, total, number: step.number, phase: 'merging'});
  }
}

/**
 * Returns the head commit to merge, after replacing the branch with a commit
 * on top of the base branch when it still carries commits of an older pull
 * request that has been squash-merged.
 */
async function restackPullRequest(
  lander: StackLandingClient,
  step: PullRequestMergeStep,
  state: LandingPullRequestState,
  now: () => number,
  onRestack: () => void,
): Promise<GitObjectID> {
  const {previousHeadOid, number} = step;
  const headOid = state.headRefOid;
  if (previousHeadOid == null || !(await lander.isAncestor(previousHeadOid, headOid))) {
    // The bottom of the stack, or a branch that was already restacked.
    return headOid;
  }
  const baseOid = await lander.getBranchHead(state.baseRefName);
  if (await lander.isAncestor(previousHeadOid, baseOid)) {
    // The older commits reached main unchanged, so GitHub can merge as is.
    return headOid;
  }
  if (state.isCrossRepository) {
    throw new Error(
      `#${number} comes from a fork, so ReviewStack cannot restack it. Rebase it with sl and submit it again.`,
    );
  }
  onRestack();

  const [previous, head, base] = await Promise.all([
    lander.getCommit(previousHeadOid),
    lander.getCommit(headOid),
    lander.getCommit(baseOid),
  ]);
  // When main has the same files as the older pull request's head, which is
  // the case right after squash-merging it, the restacked commit keeps this
  // pull request's files exactly. Otherwise GitHub has to replay the changes.
  const treeOid =
    base.treeOid === previous.treeOid
      ? head.treeOid
      : await replayChanges(lander, number, previous, head, base, now);
  const restackedOid = await lander.createCommit({
    message: head.message,
    treeOid,
    parents: [base.oid],
    author: head.author,
  });
  await lander.forceUpdateBranch(state.headRefName, restackedOid);
  return restackedOid;
}

/**
 * Computes the files of `head` replayed onto `base`, like a cherry-pick of the
 * commits between `previous` and `head`. GitHub can only merge into a branch,
 * so this merges `head` into a temporary branch whose commit has the files of
 * `base` and `previous` as its parent. That makes `previous` the merge base.
 */
async function replayChanges(
  lander: StackLandingClient,
  number: number,
  previous: GitCommitObject,
  head: GitCommitObject,
  base: GitCommitObject,
  now: () => number,
): Promise<GitObjectID> {
  const message = `ReviewStack restack of #${number}`;
  const scratchOid = await lander.createCommit({
    message,
    treeOid: base.treeOid,
    parents: [previous.oid],
  });
  const scratchBranch = `reviewstack-restack/${number}-${now()}`;
  await lander.createBranch(scratchBranch, scratchOid);
  try {
    const merged = await lander.mergeIntoBranch(scratchBranch, head.oid, message);
    if (merged == null) {
      throw new Error(
        `#${number} conflicts with main. Rebase it with sl, submit it again, and merge the rest of the stack.`,
      );
    }
    return merged.treeOid;
  } finally {
    await lander.deleteBranch(scratchBranch).catch(() => undefined);
  }
}

// GitHub rejects a merge with one of these while required checks are still
// running or have not reported for a commit that was just pushed.
const WAITING_FOR_CHECKS_ERROR = /status check|is expected|in progress|pending/i;
// GitHub can refuse a merge while it is still recomputing mergeability.
const TRANSIENT_MERGE_ERROR = /base branch was modified|try (the merge )?again/i;

async function mergeWhenReady({
  client,
  lander,
  step,
  headOid,
  report,
  sleep,
  now,
  pollIntervalMs,
  deadline,
}: {
  client: Pick<GitHubClient, 'mergePullRequest'>;
  lander: StackLandingClient;
  step: PullRequestMergeStep;
  headOid: GitObjectID;
  report: (phase: PullRequestLandingPhase) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollIntervalMs: number;
  deadline: number;
}): Promise<void> {
  const label = `#${step.number}`;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const state = await lander.getPullRequestState(step.number);
    if (state.merged) {
      return;
    }
    if (state.state !== PullRequestState.Open) {
      throw new Error(`${label} was closed.`);
    }
    if (state.headRefOid !== headOid) {
      throw new Error(`${label} changed on GitHub after the merge started.`);
    }
    if (state.mergeable === MergeableState.Conflicting) {
      throw new Error(`${label} has merge conflicts with main.`);
    }

    const checksFailed =
      state.checkState === StatusState.Failure || state.checkState === StatusState.Error;
    const checksRunning =
      state.checkState === StatusState.Pending || state.checkState === StatusState.Expected;
    if (state.mergeable !== MergeableState.Unknown && !checksRunning) {
      report('merging');
      // eslint-disable-next-line no-await-in-loop
      const error = await mergePullRequest(client, state.id, headOid).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
      if (error == null) {
        return;
      }
      const waitingForChecks = WAITING_FOR_CHECKS_ERROR.test(error.message);
      if (waitingForChecks && checksFailed) {
        throw new Error(`Required checks failed on ${label}. ${error.message}`);
      }
      if (!waitingForChecks && !TRANSIENT_MERGE_ERROR.test(error.message)) {
        throw error;
      }
    }

    if (now() >= deadline) {
      throw new Error(`Timed out waiting for the checks on ${label}.`);
    }
    report('waiting');
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollIntervalMs);
  }
}

async function mergePullRequest(
  client: Pick<GitHubClient, 'mergePullRequest'>,
  pullRequestId: ID,
  expectedHeadOid: GitObjectID,
): Promise<void> {
  const result = await client.mergePullRequest({
    expectedHeadOid,
    mergeMethod: PullRequestMergeMethod.Squash,
    pullRequestId,
  });
  if (result.mergePullRequest?.pullRequest?.merged !== true) {
    throw new Error('GitHub did not merge the pull request.');
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
