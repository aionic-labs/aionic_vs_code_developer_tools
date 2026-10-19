/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {MergePullRequestInput, MergePullRequestMutationData} from './generated/graphql';
import type StackLandingClient from './github/StackLandingClient';
import type {
  CreateGitCommitInput,
  GitCommitObject,
  LandingPullRequestState,
} from './github/StackLandingClient';
import type {PullRequestMergeCandidate, PullRequestLandingProgress} from './pullRequestMerge';

import {
  MergeableState,
  PullRequestReviewDecision,
  PullRequestReviewState,
  PullRequestState,
  StatusState,
} from './generated/graphql';
import {buildPullRequestMergePlan, landPullRequestStack} from './pullRequestMerge';

function pullRequest(
  number: number,
  overrides: Partial<PullRequestMergeCandidate> = {},
): PullRequestMergeCandidate {
  return {
    baseRefName: 'main',
    headRefOid: `head-${number}`,
    id: `id-${number}`,
    isDraft: false,
    latestReviews: {nodes: []},
    mergeable: MergeableState.Mergeable,
    number,
    reviewDecision: PullRequestReviewDecision.Approved,
    state: PullRequestState.Open,
    title: `Change ${number}`,
    viewerCanUpdate: true,
    ...overrides,
  };
}

test('lands the selected Sapling prefix from oldest to newest', () => {
  const stack = [6, 5, 4, 3, 2, 1].map(number => pullRequest(number));

  const plan = buildPullRequestMergePlan(stack, 4);

  expect(plan.blockers).toEqual([]);
  expect(plan.totalPullRequests).toBe(4);
  expect(plan.pullRequests.map(({number}) => number)).toEqual([1, 2, 3, 4]);
});

test('skips merged parents and blocks an unsafe stack before landing', () => {
  const plan = buildPullRequestMergePlan(
    [
      pullRequest(3),
      pullRequest(2, {reviewDecision: PullRequestReviewDecision.ReviewRequired}),
      pullRequest(1, {mergeable: MergeableState.Conflicting}),
    ],
    3,
  );

  expect(plan.pullRequests.map(({number}) => number)).toEqual([3]);
  expect(plan.totalPullRequests).toBe(3);
  expect(plan.blockers).toEqual(['#1 has merge conflicts.', '#2 is not approved.']);
});

test('lets landing restack pull requests that conflict only with their squash-merged parents', () => {
  const plan = buildPullRequestMergePlan(
    [
      pullRequest(3, {mergeable: MergeableState.Conflicting}),
      pullRequest(2, {mergeable: MergeableState.Conflicting}),
      pullRequest(1, {state: PullRequestState.Merged}),
    ],
    3,
  );

  expect(plan.blockers).toEqual([]);
  expect(plan.totalPullRequests).toBe(2);
  expect(plan.pullRequests.map(({number, previousHeadOid}) => [number, previousHeadOid])).toEqual([
    [2, 'head-1'],
    [3, 'head-2'],
  ]);
});

test('accepts the latest approval fallback used by ReviewStack', () => {
  const plan = buildPullRequestMergePlan(
    [
      pullRequest(1, {
        latestReviews: {nodes: [{state: PullRequestReviewState.Approved}]},
        reviewDecision: null,
      }),
    ],
    1,
  );

  expect(plan.blockers).toEqual([]);
  expect(plan.pullRequests.map(({number}) => number)).toEqual([1]);
});

type FakeCommit = Omit<GitCommitObject, 'oid'>;

const AUTHOR = {name: 'Author', email: 'author@example.com', date: '2026-10-19T00:00:00Z'};

/**
 * In-memory GitHub repository. Squash-merging a pull request adds one commit
 * with the pull request's files to main, which is what GitHub does when main
 * has not moved since the pull request was restacked.
 */
class FakeGitHub implements StackLandingClient {
  commits = new Map<string, FakeCommit>();
  branches = new Map<string, string>();
  pullRequests = new Map<number, LandingPullRequestState>();
  checkStates = new Map<string, StatusState | null>();
  mergeErrors: string[] = [];
  replayResult: 'replayed-tree' | null = 'replayed-tree';
  deletedBranches: string[] = [];
  private nextOid = 0;

  constructor() {
    this.commits.set('base', {treeOid: 'tree-base', parents: [], message: 'base', author: AUTHOR});
    this.branches.set('main', 'base');
  }

  /** Adds a Sapling stack of single-commit pull requests on top of `parent`. */
  addStack(numbers: number[], bottomParent = 'base'): void {
    let parent = bottomParent;
    for (const number of numbers) {
      const oid = `head-${number}`;
      this.commits.set(oid, {
        treeOid: `tree-${number}`,
        parents: [parent],
        message: `Change ${number}`,
        author: AUTHOR,
      });
      this.branches.set(`pr${number}`, oid);
      this.pullRequests.set(number, {
        id: `id-${number}`,
        number,
        state: PullRequestState.Open,
        merged: false,
        mergeable: MergeableState.Mergeable,
        baseRefName: 'main',
        headRefName: `pr${number}`,
        headRefOid: oid,
        isCrossRepository: false,
        checkState: null,
      });
      parent = oid;
    }
  }

  getPullRequestState(pr: number): Promise<LandingPullRequestState> {
    const state = this.pullRequests.get(pr);
    if (state == null) {
      return Promise.reject(new Error(`missing #${pr}`));
    }
    const headRefOid = this.branches.get(state.headRefName) ?? state.headRefOid;
    return Promise.resolve({
      ...state,
      headRefOid,
      checkState: this.checkStates.get(headRefOid) ?? StatusState.Success,
    });
  }

  getBranchHead(branch: string): Promise<string> {
    const oid = this.branches.get(branch);
    return oid == null ? Promise.reject(new Error(`missing ${branch}`)) : Promise.resolve(oid);
  }

  getCommit(oid: string): Promise<GitCommitObject> {
    const commit = this.commits.get(oid);
    return commit == null
      ? Promise.reject(new Error(`missing ${oid}`))
      : Promise.resolve({oid, ...commit});
  }

  isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const pending = [descendant];
    while (pending.length > 0) {
      const oid = pending.pop() as string;
      if (oid === ancestor) {
        return Promise.resolve(true);
      }
      pending.push(...(this.commits.get(oid)?.parents ?? []));
    }
    return Promise.resolve(false);
  }

  createCommit({message, treeOid, parents, author}: CreateGitCommitInput): Promise<string> {
    const oid = `new-${++this.nextOid}`;
    this.commits.set(oid, {message, treeOid, parents, author: author ?? AUTHOR});
    return Promise.resolve(oid);
  }

  createBranch(branch: string, oid: string): Promise<void> {
    this.branches.set(branch, oid);
    return Promise.resolve();
  }

  forceUpdateBranch(branch: string, oid: string): Promise<void> {
    this.branches.set(branch, oid);
    return Promise.resolve();
  }

  deleteBranch(branch: string): Promise<void> {
    this.branches.delete(branch);
    this.deletedBranches.push(branch);
    return Promise.resolve();
  }

  async mergeIntoBranch(branch: string, head: string): Promise<GitCommitObject | null> {
    if (this.replayResult == null) {
      return null;
    }
    const oid = await this.createCommit({
      message: 'merge',
      treeOid: this.replayResult,
      parents: [await this.getBranchHead(branch), head],
    });
    this.branches.set(branch, oid);
    return this.getCommit(oid);
  }

  mergePullRequest = jest.fn(
    async ({
      expectedHeadOid,
      pullRequestId,
    }: MergePullRequestInput): Promise<MergePullRequestMutationData> => {
      const error = this.mergeErrors.shift();
      if (error != null) {
        throw new Error(error);
      }
      const state = [...this.pullRequests.values()].find(({id}) => id === pullRequestId);
      if (
        state == null ||
        expectedHeadOid == null ||
        this.branches.get(state.headRefName) !== expectedHeadOid
      ) {
        throw new Error('Head branch was modified.');
      }
      const head = await this.getCommit(expectedHeadOid);
      const squash = await this.createCommit({
        message: `squash #${state.number}`,
        treeOid: head.treeOid,
        parents: [await this.getBranchHead('main')],
      });
      this.branches.set('main', squash);
      this.pullRequests.set(state.number, {...state, merged: true, state: PullRequestState.Merged});
      return {
        mergePullRequest: {
          pullRequest: {
            id: pullRequestId,
            number: state.number,
            merged: true,
            state: PullRequestState.Merged,
          },
        },
      };
    },
  );
}

function plannedSteps(github: FakeGitHub, numbers: number[]) {
  const stack = [...numbers].reverse().map(number => {
    const state = github.pullRequests.get(number) as LandingPullRequestState;
    return pullRequest(number, {
      headRefOid: state.headRefOid,
      state: state.merged ? PullRequestState.Merged : PullRequestState.Open,
    });
  });
  return buildPullRequestMergePlan(stack, numbers[numbers.length - 1]).pullRequests;
}

function land(
  github: FakeGitHub,
  numbers: number[],
  options: {progress?: PullRequestLandingProgress[]; now?: () => number} = {},
) {
  return landPullRequestStack({
    client: github,
    lander: github,
    pullRequests: plannedSteps(github, numbers),
    onProgress: progress => options.progress?.push(progress),
    sleep: () => Promise.resolve(),
    now: options.now,
  });
}

test('restacks each pull request onto the squash-merged main before merging it', async () => {
  const github = new FakeGitHub();
  github.addStack([1, 2, 3]);
  const progress: PullRequestLandingProgress[] = [];

  await land(github, [1, 2, 3], {progress});

  expect([...github.pullRequests.values()].every(({merged}) => merged)).toBe(true);
  const mergedHeads = github.mergePullRequest.mock.calls.map(
    ([input]) => input.expectedHeadOid as string,
  );
  expect(mergedHeads[0]).toBe('head-1');
  // The restacked commits keep the pull request's files and author but sit on
  // the squash commit of the previous pull request.
  const restacked = await Promise.all(mergedHeads.slice(1).map(oid => github.getCommit(oid)));
  const restackedParents = await Promise.all(
    restacked.map(commit => github.getCommit(commit.parents[0])),
  );
  expect(restacked).toMatchObject(
    [2, 3].map(number => ({
      treeOid: `tree-${number}`,
      message: `Change ${number}`,
      author: AUTHOR,
    })),
  );
  expect(restackedParents.map(({message}) => message)).toEqual(['squash #1', 'squash #2']);
  expect(progress.filter(({phase}) => phase === 'restacking').map(({number}) => number)).toEqual([
    2, 3,
  ]);
  expect(progress[progress.length - 1]).toMatchObject({completed: 3, total: 3});
});

test('replays the changes on GitHub when main moved after the previous merge', async () => {
  const github = new FakeGitHub();
  github.addStack([1, 2]);
  github.pullRequests.set(1, {
    ...(github.pullRequests.get(1) as LandingPullRequestState),
    merged: true,
    state: PullRequestState.Merged,
  });
  github.commits.set('other', {
    treeOid: 'tree-other',
    parents: ['base'],
    message: 'other',
    author: AUTHOR,
  });
  github.branches.set('main', 'other');

  await land(github, [1, 2]);

  const merged = github.mergePullRequest.mock.calls[0][0].expectedHeadOid as string;
  expect(await github.getCommit(merged)).toMatchObject({
    treeOid: 'replayed-tree',
    parents: ['other'],
  });
  expect(github.deletedBranches).toHaveLength(1);
  expect(github.deletedBranches[0]).toMatch(/^reviewstack-restack\/2-/);
});

test('stops with advice when the replay conflicts, and removes the scratch branch', async () => {
  const github = new FakeGitHub();
  github.addStack([1, 2]);
  github.commits.set('other', {
    treeOid: 'tree-other',
    parents: ['base'],
    message: 'other',
    author: AUTHOR,
  });
  github.replayResult = null;
  // Another change lands on main between the two merges.
  const merge = github.mergePullRequest.getMockImplementation() as (
    input: MergePullRequestInput,
  ) => Promise<MergePullRequestMutationData>;
  github.mergePullRequest.mockImplementationOnce(async input => {
    const result = await merge(input);
    github.commits.set('later', {
      treeOid: 'tree-later',
      parents: [github.branches.get('main') as string],
      message: 'later',
      author: AUTHOR,
    });
    github.branches.set('main', 'later');
    return result;
  });

  await expect(land(github, [1, 2])).rejects.toThrow('#2 conflicts with main. Rebase it with sl');
  expect(github.branches.get('pr2')).toBe('head-2');
  expect([...github.branches.keys()].some(branch => branch.startsWith('reviewstack-'))).toBe(false);
});

test('merges an already restacked pull request without rewriting it', async () => {
  const github = new FakeGitHub();
  github.addStack([1]);
  await land(github, [1]);
  // Someone ran sl rebase and sl pr submit after #1 landed.
  github.addStack([2], github.branches.get('main'));
  const restackedByHand = github.branches.get('pr2');
  github.commits.set('head-1-old', {treeOid: 'x', parents: ['base'], message: '', author: AUTHOR});

  await landPullRequestStack({
    client: github,
    lander: github,
    pullRequests: [{...pullRequest(2), previousHeadOid: 'head-1-old'}],
    sleep: () => Promise.resolve(),
  });

  expect(github.mergePullRequest.mock.calls[1][0].expectedHeadOid).toBe(restackedByHand);
});

test('waits for required checks on the restacked commit', async () => {
  const github = new FakeGitHub();
  github.addStack([1, 2]);
  const originalForceUpdate = github.forceUpdateBranch.bind(github);
  github.forceUpdateBranch = async (branch, oid) => {
    github.checkStates.set(oid, StatusState.Pending);
    await originalForceUpdate(branch, oid);
  };
  const sleep = jest.fn(() => {
    // CI finishes, but GitHub has not attached the required check yet.
    for (const oid of github.checkStates.keys()) {
      github.checkStates.set(oid, null);
    }
    return Promise.resolve();
  });
  const progress: PullRequestLandingProgress[] = [];
  await landPullRequestStack({
    client: github,
    lander: github,
    pullRequests: plannedSteps(github, [1, 2]),
    onProgress: next => {
      progress.push(next);
      if (next.number === 2 && next.phase === 'restacking') {
        github.mergeErrors = ['Required status check "check" is expected.'];
      }
    },
    sleep,
  });

  expect(sleep).toHaveBeenCalledTimes(2);
  expect(progress.some(({number, phase}) => number === 2 && phase === 'waiting')).toBe(true);
  expect(github.pullRequests.get(2)?.merged).toBe(true);
});

test('stops when required checks fail', async () => {
  const github = new FakeGitHub();
  github.addStack([1]);
  github.checkStates.set('head-1', StatusState.Failure);
  github.mergeErrors = ['Required status check "check" is failing.'];

  await expect(land(github, [1])).rejects.toThrow('Required checks failed on #1.');
});

test('gives up when checks never finish', async () => {
  const github = new FakeGitHub();
  github.addStack([1]);
  github.checkStates.set('head-1', StatusState.Pending);
  let time = 0;

  await expect(land(github, [1], {now: () => (time += 60_000)})).rejects.toThrow(
    'Timed out waiting for the checks on #1.',
  );
  expect(github.mergePullRequest).not.toHaveBeenCalled();
});

test('stops at the first merge GitHub refuses for another reason', async () => {
  const github = new FakeGitHub();
  github.addStack([1, 2]);
  github.mergeErrors = ['At least 1 approving review is required.'];

  await expect(land(github, [1, 2])).rejects.toThrow('At least 1 approving review is required.');
  expect(github.pullRequests.get(2)?.merged).toBe(false);
});
