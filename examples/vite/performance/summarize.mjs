import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file)
  throw new Error(
    'Usage: node examples/vite/performance/summarize.mjs results.json',
  );
const samples = JSON.parse(readFileSync(file, 'utf8'));
const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  return (
    sorted[Math.floor(index)] +
    (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1)
  );
};
const groups = new Map();
for (const sample of samples.filter((r) => !r.warmup)) {
  if (!Object.values(sample.checks).every(Boolean))
    throw new Error('Failed workload checks');
  const condition = sample.condition || `CPU ${sample.cpuThrottlingRate || 1}x`;
  const key = JSON.stringify([condition, sample.profile]);
  if (!groups.has(key))
    groups.set(key, {
      condition,
      profile: sample.profile,
      batch: [],
      streaming: [],
    });
  groups.get(key)[sample.mode].push(sample);
}
const report = [];
for (const group of groups.values()) {
  const { condition, profile, batch, streaming } = group;
  if (batch.length !== streaming.length || batch.length === 0)
    throw new Error(`Unequal A/B sample counts: ${condition}/${profile}`);
  const pairKey = (sample) =>
    JSON.stringify([sample.suiteId, sample.seed, sample.pair]);
  const indexPairs = (records) => {
    const indexed = new Map();
    for (const record of records) {
      const key = pairKey(record);
      if (indexed.has(key))
        throw new Error(`Duplicate pair: ${condition}/${profile}/${key}`);
      indexed.set(key, record);
    }
    return indexed;
  };
  indexPairs(batch);
  const streamingPairs = indexPairs(streaming);
  const pairs = batch.map((before) => {
    const after = streamingPairs.get(pairKey(before));
    if (!after)
      throw new Error(`Missing pair: ${condition}/${profile}/${before.seed}`);
    const requests = (r) =>
      r.resources
        .map((e) => [e.name, e.encodedBodySize, e.serverTiming])
        .sort(([a], [b]) => a.localeCompare(b));
    if (JSON.stringify(requests(before)) !== JSON.stringify(requests(after)))
      throw new Error('A/B resources or seeded delays differ');
    for (const r of [before, after]) {
      if (new Set(r.resources.map((e) => e.name)).size !== r.resources.length)
        throw new Error('Duplicate resource request');
      if (
        r.resources.some(
          (e) =>
            e.responseStatus !== 200 ||
            e.workerStart !== 0 ||
            e.deliveryType === 'cache',
        )
      )
        throw new Error('Unexpected resource delivery');
    }
    return before.appReadyMs - after.appReadyMs;
  });
  const stats = (rs) =>
    Object.fromEntries(
      [
        'graphMs',
        'appReadyMs',
        'appFrameMs',
        'expandWaitMaxMs',
        'dynamicMs',
      ].map((field) => [
        field,
        {
          median: quantile(
            rs.map((r) => r[field]),
            0.5,
          ),
          p75: quantile(
            rs.map((r) => r[field]),
            0.75,
          ),
        },
      ]),
    );
  const before = stats(batch),
    after = stats(streaming);
  report.push({
    condition,
    profile,
    pairs: pairs.length,
    before,
    after,
    appReadyReductionPercent:
      (1 - after.appReadyMs.median / before.appReadyMs.median) * 100,
    graphReductionPercent:
      (1 - after.graphMs.median / before.graphMs.median) * 100,
    pairedWins: pairs.filter((n) => n > 0).length,
    pairedAppReadySavingsMs: pairs,
  });
}
console.log(
  JSON.stringify(
    {
      measuredTrials: samples.filter((r) => !r.warmup).length,
      warmups: samples.filter((r) => r.warmup).length,
      allPairsUseIdenticalResourcesAndDelays: true,
      report,
    },
    null,
    2,
  ),
);
