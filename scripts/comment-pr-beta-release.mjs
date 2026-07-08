const marker = '<!-- garfish-wasm-esm-plugin-pr-beta-release -->';

const requiredEnv = {
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
  PR_NUMBER: process.env.PR_NUMBER,
  PACKAGE_NAME: process.env.PACKAGE_NAME,
  BETA_VERSION: process.env.BETA_VERSION,
  RUN_URL: process.env.RUN_URL,
};

const missing = Object.entries(requiredEnv)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

const [owner, repo] = requiredEnv.GITHUB_REPOSITORY.split('/');

if (!owner || !repo) {
  throw new Error('GITHUB_REPOSITORY must be in owner/repo format.');
}

if (!/^[1-9]\d*$/.test(requiredEnv.PR_NUMBER)) {
  throw new Error('PR_NUMBER must be a positive integer.');
}

const npmTag = process.env.NPM_TAG || 'beta';
const shortSha = process.env.HEAD_SHA ? process.env.HEAD_SHA.slice(0, 7) : '';
const packageSpec = `${requiredEnv.PACKAGE_NAME}@${requiredEnv.BETA_VERSION}`;
const npmUrl = `https://www.npmjs.com/package/${encodeURIComponent(
  requiredEnv.PACKAGE_NAME,
)}/v/${encodeURIComponent(requiredEnv.BETA_VERSION)}`;

const body = `${marker}
### PR beta package published

\`${packageSpec}\` has been published with the \`${npmTag}\` dist-tag.

- Install: \`pnpm add ${packageSpec}\`
- npm: [${packageSpec}](${npmUrl})
- Workflow: [release run](${requiredEnv.RUN_URL})
${shortSha ? `- Commit: \`${shortSha}\`\n` : ''}`;

const apiBase = process.env.GITHUB_API_URL || 'https://api.github.com';
const headers = {
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${requiredEnv.GITHUB_TOKEN}`,
  'content-type': 'application/json',
  'x-github-api-version': '2022-11-28',
};

async function githubRequest(path, init = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      ...headers,
      ...init.headers,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API request failed: ${response.status} ${response.statusText}\n${detail}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function listComments() {
  const comments = [];

  for (let page = 1; ; page += 1) {
    const batch = await githubRequest(
      `/repos/${owner}/${repo}/issues/${requiredEnv.PR_NUMBER}/comments?per_page=100&page=${page}`,
    );

    comments.push(...batch);

    if (batch.length < 100) {
      return comments;
    }
  }
}

const comments = await listComments();
const existing = comments.find((comment) => comment.body?.includes(marker));

if (existing) {
  await githubRequest(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
  console.log(`Updated PR beta release comment ${existing.id}.`);
} else {
  const comment = await githubRequest(`/repos/${owner}/${repo}/issues/${requiredEnv.PR_NUMBER}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  console.log(`Created PR beta release comment ${comment.id}.`);
}
