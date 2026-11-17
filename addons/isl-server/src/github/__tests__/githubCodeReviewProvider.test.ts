/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {mockLogger} from 'shared/testUtils';
import {GitHubCodeReviewProvider} from '../githubCodeReviewProvider';
import queryGraphQL from '../queryGraphQL';

jest.mock('../queryGraphQL', () => ({__esModule: true, default: jest.fn()}));
const mockQuery = queryGraphQL as jest.MockedFunction<typeof queryGraphQL>;

function pr(number: number) {
  return {
    __typename: 'PullRequest',
    number,
    title: `PR ${number}`,
    body: `PR ${number}\nbody`,
    state: 'OPEN',
    isDraft: false,
    url: `https://github.com/o/r/pull/${number}`,
    reviewDecision: null,
    comments: {totalCount: 0},
    baseRef: null,
    headRef: null,
    headRefName: `pr${number}`,
    commits: {nodes: []},
  };
}

function setup(respond: (query: string) => unknown) {
  mockQuery.mockImplementation(query => {
    if (query.includes('MergeQueueSupportQuery')) {
      return Promise.resolve({__type: null});
    }
    const result = respond(query);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  const provider = new GitHubCodeReviewProvider(
    {type: 'github', owner: 'o', repo: 'r', hostname: 'github.com'},
    mockLogger,
  );
  const summaries = jest.fn();
  provider.onChangeDiffSummaries(summaries);
  return {provider, summaries};
}

async function nextSummaries(summaries: jest.Mock) {
  for (let i = 0; i < 50 && summaries.mock.calls.length === 0; i++) {
    await new Promise(res => setImmediate(res));
  }
  return summaries.mock.calls[summaries.mock.calls.length - 1][0].value as Map<string, unknown>;
}

describe('GitHubCodeReviewProvider diff summaries', () => {
  beforeEach(() => mockQuery.mockReset());

  it('fetches pull requests missing from search by number', async () => {
    const {provider, summaries} = setup(query =>
      query.includes('PullRequestsByNumberQuery')
        ? {repository: {pr12: pr(12)}}
        : {search: {nodes: [pr(11)]}},
    );
    provider.triggerDiffSummariesFetch(['11', '12']);
    const map = await nextSummaries(summaries);
    expect([...map.keys()].sort()).toEqual(['11', '12']);
    const byNumber = mockQuery.mock.calls.find(([q]) => q.includes('PullRequestsByNumberQuery'));
    expect(byNumber?.[0]).toContain('pr12: pullRequest(number: 12)');
    expect(byNumber?.[0]).not.toContain('number: 11)');
    provider.dispose();
  });

  it('does not query by number when search found everything', async () => {
    const {provider, summaries} = setup(() => ({search: {nodes: [pr(11)]}}));
    provider.triggerDiffSummariesFetch(['11']);
    await nextSummaries(summaries);
    expect(mockQuery.mock.calls.some(([q]) => q.includes('PullRequestsByNumberQuery'))).toBe(false);
    provider.dispose();
  });

  it('falls back to one query per number when the batch errors', async () => {
    const {provider, summaries} = setup(query => {
      if (!query.includes('PullRequestsByNumberQuery')) {
        return {search: {nodes: []}};
      }
      if (query.includes('number: 99)')) {
        return new Error('Could not resolve to a PullRequest with the number of 99.');
      }
      return {repository: {pr12: pr(12)}};
    });
    provider.triggerDiffSummariesFetch(['12', '99']);
    const map = await nextSummaries(summaries);
    expect([...map.keys()]).toEqual(['12']);
    provider.dispose();
  });

  it('runs a fetch requested during the cooldown once it ends', async () => {
    jest.useFakeTimers();
    try {
      const {provider} = setup(() => ({search: {nodes: []}}));
      provider.triggerDiffSummariesFetch(['1']);
      provider.triggerDiffSummariesFetch(['1', '2']);
      provider.triggerDiffSummariesFetch(['1', '2', '3']);
      const searches = () =>
        mockQuery.mock.calls.filter(([q]) => q.includes('YourPullRequests')).length;
      await jest.advanceTimersByTimeAsync(0);
      expect(searches()).toBe(1);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(searches()).toBe(2);
      const lastByNumber = mockQuery.mock.calls
        .map(([q]) => q)
        .filter(q => q.includes('PullRequestsByNumberQuery'))
        .pop();
      expect(lastByNumber).toContain('pr3: pullRequest(number: 3)');
      provider.dispose();
    } finally {
      jest.useRealTimers();
    }
  });
});
