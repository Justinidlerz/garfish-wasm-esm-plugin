import { appendFileSync, readFileSync } from 'node:fs';

const statusPath = process.argv[2] ?? '.changeset/status.json';
const status = JSON.parse(readFileSync(statusPath, 'utf8'));
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const releases = Array.isArray(status.releases) ? status.releases : [];
const release = releases.find((item) => item.name === packageJson.name);
const fields = {
  has_release: release ? 'true' : 'false',
  package_name: packageJson.name,
  release_type: release?.type ?? '',
};

const output = Object.entries(fields)
  .map(([key, value]) => `${key}=${value}`)
  .join('\n');

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
}

console.log(output);
