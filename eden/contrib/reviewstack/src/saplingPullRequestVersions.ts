/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  Commit,
  DateTime,
  ForcePushEvent,
  GitObjectID,
  Version,
  VersionCommit,
} from './github/types';

/**
 * Builds the versions of a PR in a Sapling stack, oldest first.
 *
 * `versionHeads` are the heads of each version, oldest first, and
 * `commitsForVersions` are the commits each version was made of, which are
 * found by walking back from its head because the PR's commit list only covers
 * the latest version. `parentHeadRefOid` is the head of the PR below this one
 * in the stack, if any.
 */
export default function saplingPullRequestVersions(
  versionHeads: ReadonlyArray<{oid: GitObjectID; committedDate: DateTime}>,
  forcePushes: ReadonlyArray<ForcePushEvent>,
  commitsForVersions: ReadonlyArray<
    ReadonlyArray<Pick<Commit, 'oid' | 'committedDate' | 'messageHeadline' | 'parents'>>
  >,
  parentHeadRefOid: GitObjectID | null,
): Version[] {
  return versionHeads.map((version, versionIndex) => {
    const validCommits = commitsForVersions[versionIndex] ?? [];

    // Earlier versions are listed first so that they can be compared.
    const versionCommits: VersionCommit[] = forcePushes.slice(0, versionIndex).map((f, i) => ({
      author: null,
      commit: f.beforeCommit,
      committedDate: f.beforeCommittedDate,
      title: 'Version ' + (i + 1),
      parents: f.beforeParents,
      version: i + 1,
    }));

    validCommits.forEach(c =>
      versionCommits.push({
        author: null,
        commit: c.oid,
        committedDate: c.committedDate,
        title: c.messageHeadline,
        parents: c.parents,
        version: versionIndex + 1,
      }),
    );

    let baseParent: GitObjectID | null = null;
    let baseParentCommittedDate: DateTime | null = null;
    if (parentHeadRefOid == null) {
      // the first PR in stack case
      if (validCommits.length > 0) {
        baseParent = validCommits[0].parents[0];
      } else if (forcePushes.length > 0) {
        baseParent = forcePushes[0].beforeParents[0];
        baseParentCommittedDate = forcePushes[0].beforeCommittedDate;
      }
    } else {
      // the not first PR in stack case
      baseParent = parentHeadRefOid;
    }

    return {
      headCommit: version.oid,
      headCommittedDate: version.committedDate,
      baseParent,
      baseParentCommittedDate,
      commits: versionCommits,
    };
  });
}
