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

const PR_FIELDS = `
  number title url state isDraft createdAt mergedAt body
  mergeable mergeStateStatus
  files(first: 100) { nodes { path } }
  reviewThreads(first: 100) { nodes { isResolved } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
`;

/** One pull request, with what the steward checklist needs. */
export async function pullRequest(context, number) {
  const data = await graphql(
    context,
    `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} } } }`,
    { owner: context.owner, name: context.name, number },
  );
  return data.repository.pullRequest;
}

/** The most recently merged pull requests, newest first. */
export async function mergedPullRequests(context, limit = 50) {
  const data = await graphql(
    context,
    `query($owner: String!, $name: String!, $limit: Int!) { repository(owner: $owner, name: $name) {
       pullRequests(states: MERGED, last: $limit, orderBy: { field: UPDATED_AT, direction: ASC }) { nodes { ${PR_FIELDS} } } } }`,
    { owner: context.owner, name: context.name, limit },
  );
  return data.repository.pullRequests.nodes;
}

/** Completed runs of one workflow on one branch, newest first. */
export async function workflowRuns(context, workflow, branch, limit = 30) {
  const data = await rest(
    context,
    `/repos/${context.owner}/${context.name}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=${limit}`,
  );
  return data.workflow_runs;
}
