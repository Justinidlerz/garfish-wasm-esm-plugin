const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  const i = (sorted.length - 1) * q;
  return (
    sorted[Math.floor(i)] +
    (sorted[Math.ceil(i)] - sorted[Math.floor(i)]) * (i % 1)
  );
};
const stats = (values) => ({
  median: quantile(values, 0.5),
  p75: quantile(values, 0.75),
});

/** Validate a complete paired suite before reporting any performance result. */
export function summarize(suite) {
  const fail = (reason) => {
    throw new Error(`Invalid benchmark results: ${reason}`);
  };
  if (suite.schemaVersion !== 1 || !suite.completed || suite.failures.length)
    fail("suite incomplete or failed");
  const { pairs, warmups, fixtures } = suite.config;
  if (
    !Number.isInteger(pairs) ||
    pairs < 1 ||
    !Number.isInteger(warmups) ||
    warmups < 0 ||
    !fixtures.length ||
    new Set(fixtures).size !== fixtures.length
  )
    fail("configuration");
  if (suite.samples.length !== fixtures.length * (pairs + warmups) * 2)
    fail("sample count");
  const index = new Map();
  const environment = new Set();
  for (const sample of suite.samples) {
    const fixture = suite.manifest.fixtures.find(
      (f) => f.id === sample.fixture
    );
    if (
      !fixture ||
      !fixtures.includes(sample.fixture) ||
      !["native", "precompiled"].includes(sample.mode) ||
      !Number.isInteger(sample.pair) ||
      sample.pair < -warmups ||
      sample.pair >= pairs ||
      sample.warmup !== sample.pair < 0
    )
      fail("unexpected trial");
    if (
      sample.buildId !== suite.manifest.buildId ||
      sample.checksum !== fixture.expectedChecksum ||
      sample.bytes !== fixture[`${sample.mode}Bytes`] ||
      sample.visibility !== "visible"
    )
      fail("workload or build mismatch");
    for (const key of [
      "checksum",
      "defaultExport",
      "data",
      "exports",
      "callResult",
      "liveBinding",
      "executedOnce",
      "foreground",
      "noRuntimeWasm",
      "noErrors",
      "timing",
    ]) {
      if (sample.checks?.[key] !== true) fail(`check ${key}`);
    }
    for (const key of ["importReadyMs", "bodyMs", "prepareMs"]) {
      if (!Number.isFinite(sample[key]) || sample[key] < 0)
        fail(`metric ${key}`);
    }
    environment.add(
      JSON.stringify([sample.userAgent, sample.crossOriginIsolated])
    );
    const key = JSON.stringify([sample.fixture, sample.pair, sample.mode]);
    if (index.has(key)) fail("duplicate trial");
    index.set(key, sample);
  }
  if (environment.size !== 1) fail("mixed browser or timer environments");
  return fixtures.map((id) => {
    const get = (pair, mode) => {
      const sample = index.get(JSON.stringify([id, pair, mode]));
      if (!sample) fail("missing pair");
      return sample;
    };
    for (let pair = -warmups; pair < pairs; pair++) {
      get(pair, "native");
      get(pair, "precompiled");
    }
    const native = Array.from({ length: pairs }, (_, pair) =>
      get(pair, "native")
    );
    const precompiled = Array.from({ length: pairs }, (_, pair) =>
      get(pair, "precompiled")
    );
    const metrics = (samples) => ({
      importReadyMs: stats(samples.map((s) => s.importReadyMs)),
      bodyMs: stats(samples.map((s) => s.bodyMs)),
    });
    const before = metrics(native),
      after = metrics(precompiled);
    return {
      fixture: id,
      pairs,
      native: before,
      precompiled: after,
      ratio:
        before.importReadyMs.median > 0
          ? after.importReadyMs.median / before.importReadyMs.median
          : null,
      pairedOverheadMs: stats(
        native.map(
          (sample, i) => precompiled[i].importReadyMs - sample.importReadyMs
        )
      ),
    };
  });
}
