import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const summaryPath = new URL('../coverage/coverage-summary.json', import.meta.url);
const badgePath = new URL('../badges/coverage.svg', import.meta.url);
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const percentage = summary.total?.lines?.pct;

if (typeof percentage !== 'number') {
  throw new Error('coverage-summary.json does not include total.lines.pct.');
}

const color =
  percentage >= 90 ? '#4c1' : percentage >= 80 ? '#97ca00' : percentage >= 70 ? '#dfb317' : '#e05d44';
const label = 'coverage';
const value = `${percentage.toFixed(1)}%`;
const labelWidth = 67;
const valueWidth = Math.max(48, 11 * value.length);
const totalWidth = labelWidth + valueWidth;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="${(labelWidth * 10) / 2}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(labelWidth - 10) * 10}">${label}</text>
    <text x="${(labelWidth * 10) / 2}" y="140" transform="scale(.1)" fill="#fff" textLength="${(labelWidth - 10) * 10}">${label}</text>
    <text aria-hidden="true" x="${(labelWidth + valueWidth / 2) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(valueWidth - 10) * 10}">${value}</text>
    <text x="${(labelWidth + valueWidth / 2) * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${(valueWidth - 10) * 10}">${value}</text>
  </g>
</svg>
`;

mkdirSync(new URL('../badges', import.meta.url), { recursive: true });
writeFileSync(badgePath, svg);
console.log(`Updated ${badgePath.pathname} to ${value}.`);
