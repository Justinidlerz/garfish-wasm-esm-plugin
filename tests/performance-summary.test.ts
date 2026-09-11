import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function sample(mode: string, appReadyMs: number, suiteId = 'first') {
  return {
    mode,
    appReadyMs,
    suiteId,
    seed: 41,
    pair: 0,
    condition: 'CPU 1x',
    profile: 'mixed',
    warmup: false,
    graphMs: appReadyMs - 10,
    appFrameMs: appReadyMs + 10,
    expandWaitMaxMs: 5,
    dynamicMs: 10,
    checks: { checksum: true, executionOrder: true },
    resources: [
      {
        name: 'https://example.test/entry.js',
        encodedBodySize: 1024,
        serverTiming: [
          { name: 'fixture-delay', duration: 65, description: '' },
        ],
        responseStatus: 200,
        workerStart: 0,
        deliveryType: '',
      },
    ],
  };
}

function summarize(samples: unknown[]) {
  const directory = mkdtempSync(resolve(tmpdir(), 'esm-summary-test-'));
  temporaryDirectories.push(directory);
  const file = resolve(directory, 'samples.json');
  writeFileSync(file, JSON.stringify(samples));
  return JSON.parse(
    execFileSync(
      process.execPath,
      [resolve('examples/vite/performance/summarize.mjs'), file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
}

describe('performance sample summary', () => {
  it('pairs repeated suites separately, excludes warmups, and computes interpolated quantiles', () => {
    const report = summarize([
      { ...sample('batch', 99999), warmup: true, checks: { checksum: false } },
      sample('batch', 200),
      sample('batch', 100, 'second'),
      sample('streaming', 60, 'second'),
      sample('streaming', 150),
    ]);
    expect(report.measuredTrials).toBe(4);
    expect(report.warmups).toBe(1);
    expect(report.report).toHaveLength(1);
    expect(report.report[0]).toMatchObject({
      pairs: 2,
      pairedWins: 2,
      pairedAppReadySavingsMs: [50, 40],
      before: { appReadyMs: { median: 150, p75: 175 } },
      after: { appReadyMs: { median: 105, p75: 127.5 } },
    });
    expect(report.report[0].appReadyReductionPercent).toBeCloseTo(30);
  });

  it('keeps CPU conditions in separate groups', () => {
    const report = summarize([
      sample('batch', 100),
      sample('streaming', 80),
      { ...sample('batch', 300), condition: 'CPU 4x' },
      { ...sample('streaming', 200), condition: 'CPU 4x' },
    ]);
    expect(
      report.report.map((group: { condition: string }) => group.condition),
    ).toEqual(['CPU 1x', 'CPU 4x']);
  });

  it.each([
    ['missing mode', [sample('batch', 100)]],
    [
      'unmatched suite',
      [sample('batch', 100), sample('streaming', 80, 'other')],
    ],
    [
      'extra streaming sample',
      [
        sample('batch', 100),
        sample('streaming', 80),
        sample('streaming', 70, 'extra'),
      ],
    ],
    [
      'duplicate pair',
      [
        sample('batch', 100),
        sample('batch', 100),
        sample('streaming', 80),
        sample('streaming', 80),
      ],
    ],
  ])('rejects %s', (_label, samples) => {
    expect(() => summarize(samples as unknown[])).toThrow();
  });

  it.each([
    'failed check',
    'changed bytes',
    'changed delay',
    'duplicate request',
    'cache',
    'worker',
    'status',
  ])('rejects %s evidence', (kind) => {
    const before = sample('batch', 100);
    const after = sample('streaming', 80);
    if (kind === 'failed check') after.checks.checksum = false;
    if (kind === 'changed bytes') after.resources[0].encodedBodySize++;
    if (kind === 'changed delay') after.resources[0].serverTiming[0].duration++;
    // Apply delivery errors to both sides so they cannot fail merely because
    // the A/B resource lists differ.
    for (const record of [before, after]) {
      if (kind === 'duplicate request')
        record.resources.push({ ...record.resources[0] });
      if (kind === 'cache') record.resources[0].deliveryType = 'cache';
      if (kind === 'worker') record.resources[0].workerStart = 1;
      if (kind === 'status') record.resources[0].responseStatus = 500;
    }
    expect(() => summarize([before, after])).toThrow();
  });
});
