/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {GitObjectID, ID} from './types';
import type {
  MergeableState,
  PullRequestLandingStateQueryData,
  PullRequestLandingStateQueryVariables,
  PullRequestState,
  StatusState,
} from '../generated/graphql';

import {createGraphQLEndpointForHostname} from './gitHubCredentials';
import queryGraphQL from './queryGraphQL';
import {PullRequestLandingStateQuery} from '../generated/graphql';
import {createRequestHeaders} from 'shared/github/auth';

export type LandingPullRequestState = {
  id: ID;
  number: number;
  state: PullRequestState;
  merged: boolean;
  mergeable: MergeableState;
  baseRefName: string;
  headRefName: string;
  headRefOid: GitObjectID;
  isCrossRepository: boolean;
  /** Combined state of the checks on the head commit, or null before any report. */
  checkState: StatusState | null;
};

export type GitCommitAuthor = {
  name: string;
  email: string;
  date: string;
};

export type GitCommitObject = {
  oid: GitObjectID;
  treeOid: GitObjectID;
  parents: GitObjectID[];
  message: string;
  author: GitCommitAuthor;
};

export type CreateGitCommitInput = {
  message: string;
  treeOid: GitObjectID;
  parents: GitObjectID[];
  author?: GitCommitAuthor;
};

/**
 * Uncached GitHub operations needed to land a Sapling stack. Landing rewrites
 * pull request branches, so every read must reflect GitHub's current state.
 */
export default interface StackLandingClient {
  getPullRequestState(pr: number): Promise<LandingPullRequestState>;
  getBranchHead(branch: string): Promise<GitObjectID>;
  getCommit(oid: GitObjectID): Promise<GitCommitObject>;
  /** True when `ancestor` is `descendant` or one of its ancestors. */
  isAncestor(ancestor: GitObjectID, descendant: GitObjectID): Promise<boolean>;
  createCommit(input: CreateGitCommitInput): Promise<GitObjectID>;
  createBranch(branch: string, oid: GitObjectID): Promise<void>;
  forceUpdateBranch(branch: string, oid: GitObjectID): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
  /**
   * Merges `head` into `branch` on GitHub and returns the branch's new head
   * commit, or null when the merge conflicts.
   */
  mergeIntoBranch(
    branch: string,
    head: GitObjectID,
    message: string,
  ): Promise<GitCommitObject | null>;
}

export class GitHubRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'GitHubRequestError';
  }
}

type RestCommit = {
  sha: GitObjectID;
  tree: {sha: GitObjectID};
  parents: Array<{sha: GitObjectID}>;
  message: string;
  author: GitCommitAuthor;
};

export class GitHubStackLandingClient implements StackLandingClient {
  private requestHeaders: Record<string, string>;
  private graphQLEndpoint: string;

  constructor(
    private hostname: string,
    private organization: string,
    private repositoryName: string,
    token: string,
  ) {
    this.requestHeaders = createRequestHeaders(token);
    this.graphQLEndpoint = createGraphQLEndpointForHostname(hostname);
  }

  async getPullRequestState(pr: number): Promise<LandingPullRequestState> {
    const data = await queryGraphQL<
      PullRequestLandingStateQueryData,
      PullRequestLandingStateQueryVariables
    >(
      PullRequestLandingStateQuery,
      {owner: this.organization, name: this.repositoryName, pr},
      this.requestHeaders,
      this.graphQLEndpoint,
    );
    const pullRequest = data.repository?.pullRequest;
    if (pullRequest == null) {
      throw new Error(`GitHub did not return #${pr}.`);
    }
    const {commits, ...rest} = pullRequest;
    const headCommit = commits.nodes?.[0]?.commit;
    return {
      ...rest,
      checkState:
        headCommit?.oid === pullRequest.headRefOid
          ? headCommit.statusCheckRollup?.state ?? null
          : null,
    };
  }

  async getBranchHead(branch: string): Promise<GitObjectID> {
    const ref = await this.rest<{object: {sha: GitObjectID}}>(
      'GET',
      `git/ref/heads/${encodeRefPath(branch)}`,
    );
    return ref.object.sha;
  }

  async getCommit(oid: GitObjectID): Promise<GitCommitObject> {
    return toGitCommitObject(await this.rest<RestCommit>('GET', `git/commits/${oid}`));
  }

  async isAncestor(ancestor: GitObjectID, descendant: GitObjectID): Promise<boolean> {
    const comparison = await this.rest<{status: string}>(
      'GET',
      `compare/${ancestor}...${descendant}?per_page=1`,
    );
    return comparison.status === 'ahead' || comparison.status === 'identical';
  }

  async createCommit({
    message,
    treeOid,
    parents,
    author,
  }: CreateGitCommitInput): Promise<GitObjectID> {
    const commit = await this.rest<RestCommit>('POST', 'git/commits', {
      message,
      tree: treeOid,
      parents,
      ...(author == null ? {} : {author}),
    });
    return commit.sha;
  }

  async createBranch(branch: string, oid: GitObjectID): Promise<void> {
    await this.rest('POST', 'git/refs', {ref: `refs/heads/${branch}`, sha: oid});
  }

  async forceUpdateBranch(branch: string, oid: GitObjectID): Promise<void> {
    await this.rest('PATCH', `git/refs/heads/${encodeRefPath(branch)}`, {sha: oid, force: true});
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.rest('DELETE', `git/refs/heads/${encodeRefPath(branch)}`);
  }

  async mergeIntoBranch(
    branch: string,
    head: GitObjectID,
    message: string,
  ): Promise<GitCommitObject | null> {
    try {
      const merge = await this.rest<{sha: GitObjectID} | null>('POST', 'merges', {
        base: branch,
        head,
        commit_message: message,
      });
      // GitHub answers 204 without a body when the branch already contains head.
      return this.getCommit(merge?.sha ?? (await this.getBranchHead(branch)));
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 409) {
        return null;
      }
      throw error;
    }
  }

  private async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `https://api.${this.hostname}/repos/${encodeURIComponent(
      this.organization,
    )}/${encodeURIComponent(this.repositoryName)}/${path}`;
    const response = await fetch(url, {
      method,
      headers:
        body == null
          ? this.requestHeaders
          : {...this.requestHeaders, 'Content-Type': 'application/json'},
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let message = response.statusText;
      try {
        const json = await response.json();
        if (typeof json?.message === 'string') {
          message = json.message;
        }
      } catch {
        // Keep the status text when GitHub does not return JSON.
      }
      throw new GitHubRequestError(
        response.status,
        `GitHub returned ${response.status}: ${message}`,
      );
    }
    return response.status === 204 ? (null as T) : ((await response.json()) as T);
  }
}

function encodeRefPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

function toGitCommitObject(commit: RestCommit): GitCommitObject {
  return {
    oid: commit.sha,
    treeOid: commit.tree.sha,
    parents: commit.parents.map(({sha}) => sha),
    message: commit.message,
    author: commit.author,
  };
}
