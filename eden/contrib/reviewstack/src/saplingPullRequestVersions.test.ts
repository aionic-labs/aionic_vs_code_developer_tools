/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {ForcePushEvent} from './github/types';

import saplingPullRequestVersions from './saplingPullRequestVersions';

function forcePush(before: string, beforeCommittedDate: string, after: string): ForcePushEvent {
  return {
    beforeCommit: before,
    beforeCommittedDate,
    beforeParents: [`${before}-parent`],
    afterCommit: after,
  } as ForcePushEvent;
}

function commit(oid: string, committedDate: string) {
  return {oid, committedDate, messageHeadline: `${oid} headline`, parents: [`${oid}-parent`]};
}

// Four force pushes, each producing a new version of a one-commit PR.
const forcePushes = [
  forcePush('v1', '2026-10-05T13:01:53Z', 'v2'),
  forcePush('v2', '2026-10-05T14:30:58Z', 'v3'),
  forcePush('v3', '2026-10-06T07:35:01Z', 'v4'),
  forcePush('v4', '2026-10-06T07:51:09Z', 'v5'),
];
const versionHeads = [
  ...forcePushes.map(f => ({oid: f.beforeCommit, committedDate: f.beforeCommittedDate})),
  {oid: 'v5', committedDate: '2026-10-08T12:45:39Z'},
];
const commitsForVersions = versionHeads.map(({oid, committedDate}) => [commit(oid, committedDate)]);

test('dates each version by its own head commit', () => {
  const versions = saplingPullRequestVersions(versionHeads, forcePushes, commitsForVersions, null);

  expect(
    versions.map(({headCommit, headCommittedDate}) => [headCommit, headCommittedDate]),
  ).toEqual(versionHeads.map(({oid, committedDate}) => [oid, committedDate]));
});

test('lists earlier versions followed by the commits of the version itself', () => {
  const versions = saplingPullRequestVersions(versionHeads, forcePushes, commitsForVersions, null);

  expect(versions[2].commits.map(({commit, version}) => [commit, version])).toEqual([
    ['v1', 1],
    ['v2', 2],
    ['v3', 3],
  ]);
  expect(versions[0].commits.map(({commit, version}) => [commit, version])).toEqual([['v1', 1]]);
  expect(versions[4].commits.map(({commit}) => commit)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']);
});

test('labels every commit of a multi-commit version with that version', () => {
  const versions = saplingPullRequestVersions(
    versionHeads.slice(0, 2),
    forcePushes.slice(0, 1),
    [
      [commit('v1-a', '2026-10-05T13:00:00Z'), commit('v1', '2026-10-05T13:01:53Z')],
      [commit('v2-a', '2026-10-05T14:30:00Z'), commit('v2', '2026-10-05T14:30:58Z')],
    ],
    null,
  );

  expect(versions[1].commits.map(({commit, version}) => [commit, version])).toEqual([
    ['v1', 1],
    ['v2-a', 2],
    ['v2', 2],
  ]);
  expect(versions[1].baseParent).toBe('v2-a-parent');
});

test('uses the head of the PR below as the base of every version', () => {
  const versions = saplingPullRequestVersions(
    versionHeads,
    forcePushes,
    commitsForVersions,
    'parent-head',
  );

  expect(versions.map(({baseParent}) => baseParent)).toEqual(versionHeads.map(() => 'parent-head'));
});
