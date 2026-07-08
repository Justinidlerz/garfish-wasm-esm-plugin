import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Bench } from 'tinybench';
import initWasm, { transform } from '../pkg/garfish_wasm_esm_plugin.js';

const benchmarkBlockStart = '<!-- benchmark-results:start -->';
const benchmarkBlockEnd = '<!-- benchmark-results:end -->';
const benchTimeMs = Number(process.env.BENCH_TIME_MS ?? 1000);
const benchWarmupMs = Number(process.env.BENCH_WARMUP_MS ?? 250);

function trimSource(source) {
  return `${source.trim()}\n`;
}

function createMediumFixture() {
  const imports = Array.from(
    { length: 12 },
    (_, index) => `import { value${index}, next${index} as step${index} } from './dep-${index}.js';`,
  ).join('\n');
  const exports = Array.from(
    { length: 12 },
    (_, index) => `export const result${index} = step${index}(value${index});`,
  ).join('\n');

  return trimSource(`
    ${imports}

    export const bag = {
      ${Array.from({ length: 12 }, (_, index) => `value${index}`).join(',\n')}
    };

    ${exports}
  `);
}

function createLargeFixture() {
  const importBlocks = Array.from(
    { length: 40 },
    (_, index) =>
      `import item${index}, { value as value${index}, run as run${index} } from './module-${index}.js';`,
  ).join('\n');
  const statements = Array.from(
    { length: 40 },
    (_, index) => `const local${index} = run${index}(value${index}, item${index});`,
  ).join('\n');
  const exportSpecifiers = Array.from(
    { length: 40 },
    (_, index) => `local${index} as export${index}`,
  ).join(', ');

  return trimSource(`
    ${importBlocks}

    ${statements}

    export { ${exportSpecifiers} };
    export * from './shared.js';
  `);
}

const fixtures = [
  {
    name: 'small-live-bindings',
    code: trimSource(`
      import def, { count, inc as plus } from './dep.js';

      const snapshot = count;
      const bag = { count, plus };

      export { count as liveCount };
      export default function read() {
        return plus() + def + snapshot + bag.count;
      }
    `),
  },
  {
    name: 'medium-dashboard',
    code: createMediumFixture(),
  },
  {
    name: 'large-re-export',
    code: createLargeFixture(),
  },
];

await initWasm({
  module_or_path: readFileSync(resolve('pkg/garfish_wasm_esm_plugin_bg.wasm')),
});

const bench = new Bench({
  time: benchTimeMs,
  warmupTime: benchWarmupMs,
});

for (const fixture of fixtures) {
  bench.add(fixture.name, () => {
    transform(fixture.code, `https://benchmark.test/${fixture.name}.js`);
  });
}

await bench.run();

const rows = bench.tasks.map((task, index) => {
  const result = task.result;
  if (!result) {
    throw new Error(`Benchmark task "${task.name}" did not produce a result.`);
  }

  return {
    name: task.name,
    bytes: new TextEncoder().encode(fixtures[index].code).length,
    meanMs: result.latency.mean,
    p75Ms: result.latency.p75,
    p99Ms: result.latency.p99,
    hz: result.throughput.mean,
    samples: result.latency.samplesCount,
  };
});

const markdown = [
  benchmarkBlockStart,
  '',
  '| Fixture | Source bytes | Mean | p75 | p99 | Throughput | Samples |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...rows.map((row) => {
    const cells = [
      `\`${row.name}\``,
      row.bytes.toLocaleString('en-US'),
      `${row.meanMs.toFixed(3)} ms`,
      `${row.p75Ms.toFixed(3)} ms`,
      `${row.p99Ms.toFixed(3)} ms`,
      `${Math.round(row.hz).toLocaleString('en-US')} ops/sec`,
      row.samples.toLocaleString('en-US'),
    ];
    return `| ${cells.join(' | ')} |`;
  }),
  '',
  `Measured on Node ${process.version} with \`BENCH_TIME_MS=${benchTimeMs}\` and \`BENCH_WARMUP_MS=${benchWarmupMs}\`.`,
  '',
  benchmarkBlockEnd,
].join('\n');

console.log(markdown);

if (process.argv.includes('--update-readme')) {
  const readmePath = new URL('../README.md', import.meta.url);
  const readme = readFileSync(readmePath, 'utf8');
  const start = readme.indexOf(benchmarkBlockStart);
  const end = readme.indexOf(benchmarkBlockEnd);

  if (start === -1 || end === -1 || end < start) {
    throw new Error('README.md does not contain benchmark result markers.');
  }

  const nextReadme = `${readme.slice(0, start)}${markdown}${readme.slice(
    end + benchmarkBlockEnd.length,
  )}`;
  writeFileSync(readmePath, nextReadme);
  console.log('Updated README.md benchmark results.');
}
