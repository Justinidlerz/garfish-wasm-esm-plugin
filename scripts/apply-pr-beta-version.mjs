import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const packageJsonUrl = new URL('../package.json', import.meta.url);
const packageJson = JSON.parse(readFileSync(packageJsonUrl, 'utf8'));
const prNumber = process.env.PR_NUMBER;
const stamp =
  process.env.BETA_DATE ??
  new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);

if (!prNumber || !/^[1-9]\d*$/.test(prNumber)) {
  throw new Error('PR_NUMBER must be a positive integer.');
}

if (!/^\d{8,14}$/.test(stamp)) {
  throw new Error('BETA_DATE must be a UTC timestamp like YYYYMMDD or YYYYMMDDHHMMSS.');
}

const versionMatch = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
  packageJson.version,
);

if (!versionMatch) {
  throw new Error(`Package version "${packageJson.version}" is not valid semver.`);
}

const betaVersion = `${versionMatch[1]}.${versionMatch[2]}.${versionMatch[3]}-pr-${prNumber}-${stamp}`;

packageJson.version = betaVersion;
writeFileSync(packageJsonUrl, `${JSON.stringify(packageJson, null, 2)}\n`);

const output = `beta_version=${betaVersion}`;

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
}

console.log(output);
