/**
 * A minimal GitHub client for the harness: REST and GraphQL over `fetch`,
 * authenticated with GITHUB_TOKEN (set automatically in GitHub Actions).
 *
 * No dependency: the harness checks a codebase whose supply chain is part of
 * its threat model, and three API calls do not justify an SDK.
 */
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';

export function githubContext() {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) return undefined;
  const [owner, name] = repository.split('/');
  return { token, owner, name };
}

async function call(context, path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${context.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path} answered ${response.status}`);
  return response.json();
}

export const rest = (context, path) => call(context, path);

export async function graphql(context, query, variables = {}) {
  const body = await call(context, '/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (body.errors?.length) throw new Error(`GitHub GraphQL: ${body.errors.map((error) => error.message).join('; ')}`);
  return body.data;
}

/**
 * Each check on a commit, with enough timing to tell a check that ran on the
 * pull request from one that ran after it merged. When a PR is fast-forwarded
 * its head commit becomes the main commit, and the checks main runs on push
 * land on the same commit; the live rollup then reads "pending" for a PR that
 * was green when it merged.
 */
const CONTEXT_FIELDS = `
  nodes {
    __typename
    ... on CheckRun { name status conclusion completedAt checkSuite { createdAt } }
    ... on StatusContext { context state createdAt }
  }
  pageInfo { hasNextPage endCursor }
`;

const PR_FIELDS = `
  number title url state isDraft createdAt mergedAt body
  mergeable mergeStateStatus
  files(first: 100) { nodes { path } pageInfo { hasNextPage endCursor } }
  reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { ${CONTEXT_FIELDS} } } } } }
`;

/**
 * Completes a PR's files and review threads past the first page.
 *
 * Metrics computed from a truncated list are wrong in the direction that
 * matters: a decision-path file or an unresolved thread past item 100 would
 * simply not be seen. So every connection is followed to its end.
 */
async function complete(context, pr) {
  for (const [field, selection] of [
    ['files', 'nodes { path }'],
    ['reviewThreads', 'nodes { isResolved }'],
  ]) {
    let page = pr[field].pageInfo;
    while (page?.hasNextPage) {
      const data = await graphql(
        context,
        `query($owner: String!, $name: String!, $number: Int!, $after: String!) { repository(owner: $owner, name: $name) {
           pullRequest(number: $number) { ${field}(first: 100, after: $after) { ${selection} pageInfo { hasNextPage endCursor } } } } }`,
        { owner: context.owner, name: context.name, number: pr.number, after: page.endCursor },
      );
      const next = data.repository.pullRequest[field];
      pr[field].nodes.push(...next.nodes);
      page = next.pageInfo;
    }
  }
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
  let page = rollup?.contexts?.pageInfo;
  while (page?.hasNextPage) {
    const data = await graphql(
      context,
      `query($owner: String!, $name: String!, $number: Int!, $after: String!) { repository(owner: $owner, name: $name) {
         pullRequest(number: $number) { commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $after) { ${CONTEXT_FIELDS} } } } } } } } }`,
      { owner: context.owner, name: context.name, number: pr.number, after: page.endCursor },
    );
    const next = data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts;
    rollup.contexts.nodes.push(...next.nodes);
    page = next.pageInfo;
  }
  return pr;
}

/**
 * Whether a merged PR's checks were green when it merged.
 *
 * Only checks whose suite was created before the merge count, so the runs
 * main starts on the same commit after a fast-forward cannot turn a green PR
 * pending. Green means at least one such check, every one completed by the
 * merge with success, neutral or skipped, and no failing status. Anything
 * else, including no checks at all, is not green.
 */
export function greenAtMerge(pr) {
  const mergedAt = Date.parse(pr.mergedAt);
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts?.nodes ?? [];
  const before = contexts.filter((check) => {
    const created = check.__typename === 'CheckRun' ? check.checkSuite?.createdAt : check.createdAt;
    return created !== undefined && created !== null && Date.parse(created) < mergedAt;
  });
  if (before.length === 0) return false;
  return before.every((check) => {
    if (check.__typename === 'StatusContext') return check.state === 'SUCCESS';
    return (
      check.status === 'COMPLETED' &&
      ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion) &&
      check.completedAt !== null &&
      Date.parse(check.completedAt) <= mergedAt
    );
  });
}

/** One pull request, with what the steward checklist needs. */
export async function pullRequest(context, number) {
  const data = await graphql(
    context,
    `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} } } }`,
    { owner: context.owner, name: context.name, number },
  );
  return complete(context, data.repository.pullRequest);
}

/** The most recently merged pull requests, each with every file and review thread. */
export async function mergedPullRequests(context, limit = 50) {
  const data = await graphql(
    context,
    `query($owner: String!, $name: String!, $limit: Int!) { repository(owner: $owner, name: $name) {
       pullRequests(states: MERGED, last: $limit, orderBy: { field: UPDATED_AT, direction: ASC }) { nodes { ${PR_FIELDS} } } } }`,
    { owner: context.owner, name: context.name, limit },
  );
  const prs = [];
  for (const pr of data.repository.pullRequests.nodes) prs.push(await complete(context, pr));
  return prs;
}

/** Completed runs of one workflow on one branch, newest first. */
export async function workflowRuns(context, workflow, branch, limit = 30) {
  const data = await rest(
    context,
    `/repos/${context.owner}/${context.name}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=${limit}`,
  );
  return data.workflow_runs;
}
