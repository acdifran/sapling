/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type {
  CodeReviewSystem,
  DiffComment,
  DiffId,
  DiffSignalSummary,
  Disposable,
  Hash,
  Result,
} from 'isl/src/types';
import type {CodeReviewProvider} from '../CodeReviewProvider';
import type {Logger} from '../logger';
import type {
  MergeQueueSupportQueryData,
  MergeQueueSupportQueryVariables,
  PullRequestCommentsQueryData,
  PullRequestCommentsQueryVariables,
  PullRequestReviewComment,
  PullRequestReviewDecision,
  PullRequestSummary as PullRequestSummaryData,
  ReactionContent,
  YourPullRequestsQueryData,
  YourPullRequestsQueryVariables,
  YourPullRequestsWithoutMergeQueueQueryData,
  YourPullRequestsWithoutMergeQueueQueryVariables,
} from './generated/graphql';

import {TypedEventEmitter} from 'shared/TypedEventEmitter';
import {notEmpty} from 'shared/utils';
import {
  MergeQueueSupportQuery,
  PullRequestCommentsQuery,
  PullRequestState,
  PullRequestSummary,
  StatusState,
  YourPullRequestsQuery,
  YourPullRequestsWithoutMergeQueueQuery,
} from './generated/graphql';
import queryGraphQL from './queryGraphQL';

export type GitHubDiffSummary = {
  type: 'github';
  title: string;
  commitMessage: string;
  state: PullRequestState | 'DRAFT' | 'MERGE_QUEUED';
  number: DiffId;
  url: string;
  commentCount: number;
  anyUnresolvedComments: false;
  signalSummary?: DiffSignalSummary;
  reviewDecision?: PullRequestReviewDecision;
  /**
   * Base of the Pull Request (public parent), as it is on GitHub (may be out of date).
   * Undefined if the ref no longer exists (e.g. branch deleted after merge).
   */
  base?: Hash;
  /**
   * Head of the Pull Request (topmost commit), as it is on GitHub (may be out of date).
   * Undefined if the ref no longer exists (e.g. branch deleted after merge).
   */
  head?: Hash;
  /** Name of the branch on GitHub, which should match the local bookmark */
  branchName?: string;
};

const DEFAULT_GH_FETCH_TIMEOUT = 60_000; // 1 minute
const DIFF_SUMMARIES_FETCH_COOLDOWN = 2_000;
/** Bounds the aliased by-number query; anything beyond waits for the next fetch. */
const MAX_PRS_TO_FETCH_BY_NUMBER = 50;

type SummaryFields = Omit<PullRequestSummaryData, '__typename'> & {
  mergeQueueEntry?: {estimatedTimeToMerge?: number | null} | null;
};

type GitHubCodeReviewSystem = CodeReviewSystem & {type: 'github'};
export class GitHubCodeReviewProvider implements CodeReviewProvider {
  constructor(
    private codeReviewSystem: GitHubCodeReviewSystem,
    private logger: Logger,
  ) {}
  private diffSummaries = new TypedEventEmitter<'data', Map<DiffId, GitHubDiffSummary>>();
  private hasMergeQueueSupport: Promise<boolean> | null = null;

  onChangeDiffSummaries(
    callback: (result: Result<Map<DiffId, GitHubDiffSummary>>) => unknown,
  ): Disposable {
    const handleData = (data: Map<DiffId, GitHubDiffSummary>) => callback({value: data});
    const handleError = (error: Error) => callback({error});
    this.diffSummaries.on('data', handleData);
    this.diffSummaries.on('error', handleError);
    return {
      dispose: () => {
        this.diffSummaries.off('data', handleData);
        this.diffSummaries.off('error', handleError);
      },
    };
  }

  private detectMergeQueueSupport(): Promise<boolean> {
    if (this.hasMergeQueueSupport == null) {
      this.hasMergeQueueSupport = (async (): Promise<boolean> => {
        this.logger.info('detecting if merge queue is supported');
        const data = await this.query<MergeQueueSupportQueryData, MergeQueueSupportQueryVariables>(
          MergeQueueSupportQuery,
          {},
          10_000,
        ).catch(err => {
          this.logger.info('failed to detect merge queue support', err);
          return undefined;
        });
        const hasMergeQueueSupport = data?.__type != null;
        this.logger.info('set merge queue support to ' + hasMergeQueueSupport);
        return hasMergeQueueSupport;
      })();
    }
    return this.hasMergeQueueSupport;
  }

  private fetchYourPullRequestsGraphQL(
    includeMergeQueue: boolean,
  ): Promise<YourPullRequestsQueryData | undefined> {
    const variables = {
      // TODO: somehow base this query on the list of DiffIds
      // This is not very easy with github's graphql API, which doesn't allow more than 5 "OR"s in a search query.
      // But if we used one-query-per-diff we would reach rate limiting too quickly.
      searchQuery: `repo:${this.codeReviewSystem.owner}/${this.codeReviewSystem.repo} is:pr author:@me`,
      numToFetch: 50,
    };
    if (includeMergeQueue) {
      return this.query<YourPullRequestsQueryData, YourPullRequestsQueryVariables>(
        YourPullRequestsQuery,
        variables,
      );
    } else {
      return this.query<
        YourPullRequestsWithoutMergeQueueQueryData,
        YourPullRequestsWithoutMergeQueueQueryVariables
      >(YourPullRequestsWithoutMergeQueueQuery, variables);
    }
  }

  private fetchCooldown: ReturnType<typeof setTimeout> | undefined;
  private queuedFetch: Array<DiffId> | undefined;

  /**
   * Fetches right away, then at most once per cooldown. A call during the cooldown runs when it
   * ends instead of being dropped: the call that carries a just-submitted PR's number often lands
   * right after another fetch, and dropping it would leave that PR without a summary until the
   * next refresh.
   */
  triggerDiffSummariesFetch = Object.assign(
    (diffs: Array<DiffId>) => {
      if (this.fetchCooldown != null) {
        this.queuedFetch = diffs;
        return;
      }
      void this.fetchDiffSummaries(diffs);
      this.fetchCooldown = setTimeout(() => {
        this.fetchCooldown = undefined;
        const queued = this.queuedFetch;
        this.queuedFetch = undefined;
        if (queued != null) {
          this.triggerDiffSummariesFetch(queued);
        }
      }, DIFF_SUMMARIES_FETCH_COOLDOWN);
    },
    {
      dispose: () => {
        clearTimeout(this.fetchCooldown);
        this.fetchCooldown = undefined;
        this.queuedFetch = undefined;
      },
    },
  );

  private async fetchDiffSummaries(diffs: Array<DiffId>) {
    try {
      const hasMergeQueueSupport = await this.detectMergeQueueSupport();
      this.logger.info('fetching github PR summaries');
      const allSummaries = await this.fetchYourPullRequestsGraphQL(hasMergeQueueSupport);

      const map = new Map<DiffId, GitHubDiffSummary>();
      for (const summary of allSummaries?.search.nodes ?? []) {
        if (summary != null && summary.__typename === 'PullRequest') {
          map.set(String(summary.number), toDiffSummary(summary));
        }
      }
      // GitHub's search index lags behind newly created pull requests, so a PR that was just
      // submitted is often missing from the search above. Fetch those directly.
      const missing = diffs.filter(id => /^\d+$/.test(id) && !map.has(id));
      for (const summary of await this.fetchPullRequestsByNumber(missing)) {
        map.set(String(summary.number), toDiffSummary(summary));
      }
      this.logger.info(`fetched ${map.size} github PR summaries`);
      this.diffSummaries.emit('data', map);
    } catch (error) {
      this.logger.info('error fetching github PR summaries: ', error);
      this.diffSummaries.emit('error', error as Error);
    }
  }

  private async fetchPullRequestsByNumber(
    numbers: Array<DiffId>,
  ): Promise<Array<PullRequestSummaryData>> {
    const wanted = numbers.slice(0, MAX_PRS_TO_FETCH_BY_NUMBER);
    if (wanted.length === 0) {
      return [];
    }
    try {
      return await this.queryPullRequestsByNumber(wanted);
    } catch (error) {
      if (wanted.length === 1) {
        this.logger.info('error fetching github PR by number: ', error);
        return [];
      }
      // Any number that isn't a pull request (e.g. a deleted one) errors the whole aliased query,
      // so fall back to one query each and keep the ones that resolve.
      const results = await Promise.allSettled(
        wanted.map(n => this.queryPullRequestsByNumber([n])),
      );
      return results.flatMap(result => (result.status === 'fulfilled' ? result.value : []));
    }
  }

  private async queryPullRequestsByNumber(
    numbers: Array<DiffId>,
  ): Promise<Array<PullRequestSummaryData>> {
    // One aliased field per pull request, so any number of them costs a single request.
    const fields = numbers
      .map(n => `pr${n}: pullRequest(number: ${n}) { ...PullRequestSummary }`)
      .join('\n');
    const query = `query PullRequestsByNumberQuery($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${fields}
  }
}
${PullRequestSummary}`;
    const data = await this.query<
      {repository?: Record<string, PullRequestSummaryData | null> | null},
      {owner: string; name: string}
    >(query, {owner: this.codeReviewSystem.owner, name: this.codeReviewSystem.repo});
    return Object.values(data?.repository ?? {}).filter(notEmpty);
  }

  public async fetchComments(diffId: string): Promise<DiffComment[]> {
    const response = await this.query<
      PullRequestCommentsQueryData,
      PullRequestCommentsQueryVariables
    >(PullRequestCommentsQuery, {
      url: this.getPrUrl(diffId),
      numToFetch: 50,
    });

    if (response == null) {
      throw new Error(`Failed to fetch comments for ${diffId}`);
    }

    const pr = response?.resource as
      (PullRequestCommentsQueryData['resource'] & {__typename: 'PullRequest'}) | undefined;

    const comments = pr?.comments.nodes ?? [];

    const inline =
      pr?.reviews?.nodes?.filter(notEmpty).flatMap(review => review.comments.nodes) ?? [];

    this.logger.info(`fetched ${comments?.length} comments for github PR ${diffId}}`);

    return (
      [...comments, ...inline]?.filter(notEmpty).map(comment => {
        return {
          author: comment.author?.login ?? '',
          authorAvatarUri: comment.author?.avatarUrl,
          html: comment.bodyHTML,
          created: new Date(comment.createdAt),
          filename: (comment as PullRequestReviewComment).path ?? undefined,
          line: (comment as PullRequestReviewComment).line ?? undefined,
          reactions:
            comment.reactions?.nodes
              ?.filter(
                (reaction): reaction is {user: {login: string}; content: ReactionContent} =>
                  reaction?.user?.login != null,
              )
              .map(reaction => ({
                name: reaction.user.login,
                reaction: reaction.content,
              })) ?? [],
          replies: [], // PR top level doesn't have nested replies, you just reply to their name
        };
      }) ?? []
    );
  }

  private query<D, V>(query: string, variables: V, timeoutMs?: number): Promise<D | undefined> {
    return queryGraphQL<D, V>(
      query,
      variables,
      this.codeReviewSystem.hostname,
      timeoutMs ?? DEFAULT_GH_FETCH_TIMEOUT,
    );
  }

  public dispose() {
    this.diffSummaries.removeAllListeners();
    this.triggerDiffSummariesFetch.dispose();
  }

  public getSummaryName(): string {
    return `github:${this.codeReviewSystem.hostname}/${this.codeReviewSystem.owner}/${this.codeReviewSystem.repo}`;
  }

  public getPrUrl(diffId: DiffId): string {
    return `https://${this.codeReviewSystem.hostname}/${this.codeReviewSystem.owner}/${this.codeReviewSystem.repo}/pull/${diffId}`;
  }

  public getDiffUrlMarkdown(diffId: DiffId): string {
    return `[#${diffId}](${this.getPrUrl(diffId)})`;
  }

  public getCommitHashUrlMarkdown(hash: string): string {
    return `[\`${hash.slice(0, 12)}\`](https://${this.codeReviewSystem.hostname}/${
      this.codeReviewSystem.owner
    }/${this.codeReviewSystem.repo}/commit/${hash})`;
  }

  getRemoteFileURL(
    path: string,
    publicCommitHash: string | null,
    selectionStart?: {line: number; char: number},
    selectionEnd?: {line: number; char: number},
  ): string {
    const {hostname, owner, repo} = this.codeReviewSystem;
    let url = `https://${hostname}/${owner}/${repo}/blob/${publicCommitHash ?? 'HEAD'}/${path}`;
    if (selectionStart != null) {
      url += `#L${selectionStart.line + 1}`;
      if (
        selectionEnd &&
        (selectionEnd.line !== selectionStart.line || selectionEnd.char !== selectionStart.char)
      ) {
        url += `C${selectionStart.char + 1}-L${selectionEnd.line + 1}C${selectionEnd.char + 1}`;
      }
    }
    return url;
  }
}

function toDiffSummary(summary: SummaryFields): GitHubDiffSummary {
  const id = String(summary.number);
  return {
    type: 'github',
    title: summary.title,
    commitMessage: summary.body.slice(summary.title.length + 1),
    // For some reason, `isDraft` is a separate boolean and not a state,
    // but we generally treat it as its own state in the UI.
    state:
      summary.isDraft && summary.state === PullRequestState.Open
        ? 'DRAFT'
        : summary.mergeQueueEntry != null
          ? 'MERGE_QUEUED'
          : summary.state,
    number: id,
    url: summary.url,
    commentCount: summary.comments.totalCount,
    anyUnresolvedComments: false,
    signalSummary: githubStatusRollupStateToCIStatus(
      summary.commits.nodes?.[0]?.commit.statusCheckRollup?.state,
    ),
    reviewDecision: summary.reviewDecision ?? undefined,
    base: summary.baseRef?.target?.oid,
    head: summary.headRef?.target?.oid,
    // Prefer headRefName: it persists even after the branch is deleted
    // (e.g. once the PR is merged), whereas headRef becomes null.
    branchName: summary.headRefName ?? summary.headRef?.name,
  };
}

function githubStatusRollupStateToCIStatus(state: StatusState | undefined): DiffSignalSummary {
  switch (state) {
    case undefined:
    case StatusState.Expected:
      return 'no-signal';
    case StatusState.Pending:
      return 'running';
    case StatusState.Error:
    case StatusState.Failure:
      return 'failed';
    case StatusState.Success:
      return 'pass';
  }
}
