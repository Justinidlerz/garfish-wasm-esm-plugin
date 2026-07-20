import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Bench } from 'tinybench';

const benchTimeMs = Number(process.env.BENCH_TIME_MS ?? 1000);
const benchWarmupMs = Number(process.env.BENCH_WARMUP_MS ?? 250);
const imports = Array.from(
  { length: 40 },
  (_, index) =>
    `import item${index}, { value as value${index}, run as run${index} } from "./module-${index}.js";`,
).join('\n');
const statements = Array.from(
  { length: 40 },
  (_, index) => `const local${index}=run${index}(value${index},item${index});`,
).join('\n');
const source = `${imports}\n${statements}`;
const filename = 'benchmark.js';
const encoder = new TextEncoder();

const { instance } = await WebAssembly.instantiate(
  readFileSync(resolve('zig-out/bin/garfish_parse_benchmark.wasm')),
);
const wasm = instance.exports;

const parse = () => {
  const sourceBytes = encoder.encode(source);
  const filenameBytes = encoder.encode(filename);
  const sourcePointer = wasm.alloc(sourceBytes.length);
  const filenamePointer = wasm.alloc(filenameBytes.length);
  try {
    new Uint8Array(wasm.memory.buffer, sourcePointer, sourceBytes.length).set(
      sourceBytes,
    );
    new Uint8Array(
      wasm.memory.buffer,
      filenamePointer,
      filenameBytes.length,
    ).set(filenameBytes);
    const nodeCount = wasm.parse(
      sourcePointer,
      sourceBytes.length,
      filenamePointer,
      filenameBytes.length,
    );
    if (nodeCount === 0xffffffff) throw new Error('Yuku parse benchmark failed');
  } finally {
    wasm.free(sourcePointer, sourceBytes.length);
    wasm.free(filenamePointer, filenameBytes.length);
  }
};

const bench = new Bench({
  time: benchTimeMs,
  warmupTime: benchWarmupMs,
});
bench.add('yuku-zig-wasm-parse', parse);
await bench.run();

const result = bench.tasks[0].result;
if (!result) throw new Error('Parse benchmark did not produce a result');

console.log(
  JSON.stringify(
    {
      fixture: 'large-module',
      sourceBytes: encoder.encode(source).length,
      meanMs: result.latency.mean,
      p75Ms: result.latency.p75,
      p99Ms: result.latency.p99,
      throughput: result.throughput.mean,
      samples: result.latency.samplesCount,
      node: process.version,
      benchTimeMs,
      benchWarmupMs,
    },
    null,
    2,
  ),
);
