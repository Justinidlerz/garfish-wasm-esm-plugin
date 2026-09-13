# Browser module execution benchmark

Compare a native ESM module with the artifact produced from exactly the same
source by `compileGarfishModule`. Both execute in a real browser. The compiled
variant uses the repository's `Runtime.importByCode` with `runtimeCompile: false`
and `compileCache: false`; browser WASM requests invalidate a sample.

```sh
pnpm benchmark:browser
```

Open the printed URL in an **existing browser instance**, keep the tab visible,
and click **Run comparison**. The command builds and serves the benchmark; it
does not launch a browser. After building once:

```sh
pnpm benchmark:browser:serve
# Optional port override:
ESM_BROWSER_BENCHMARK_PORT=5180 pnpm benchmark:browser:serve
```

## What is timed

| Metric                        | Native ESM                                                      | Precompiled artifact                                                |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------- |
| `importReadyMs` (primary)     | Before `import(blobUrl)` until its promise resolves             | Before `Runtime.importByCode(code, url)` until its promise resolves |
| `bodyMs`                      | Source-internal first timestamp to the last top-level statement | The same timestamps carried through precompilation                  |
| `prepareMs` (raw diagnostics) | Fixture fetch, hash check and Blob creation                     | Fixture fetch, hash check and Runtime construction                  |

Before the timed import, the source is fetched and SHA-256 checked against the
build manifest. Native ESM uses a fresh Blob URL, so the browser actually parses
and evaluates the module instead of returning a previously imported namespace.
The precompiled case uses a fresh Runtime. Framework bundle loading, network
transfer, Blob/Runtime creation and build-time compilation are outside
`importReadyMs`. Native in-memory Blob loading, parsing/linking, and asynchronous
import resolution are included; the precompiled path includes artifact decoding,
Runtime graph/module bookkeeping, provider creation, JavaScript parsing/evaluation
and asynchronous completion.

`bodyMs` measures the instrumented source body, not total parsing/evaluation cost:
native linking and some generated export setup happen outside those markers.
Do not interpret `importReadyMs - bodyMs` as a pure parsing measurement.
This compares **module execution**, not a full Garfish sandbox, application
load/mount, rendering, network delivery or LCP. For dependency scheduling and
Garfish mounting, use the separate [scheduling experiment](../../examples/vite/performance/README.md).

## Workload and sampling

The build emits original ESM and precompiled assets directly, without letting
Rollup bundle or tree-shake either workload. Three self-contained modules contain
128 / 1,024 / 8,192 deterministic product rows, grouped indexing, 8 / 64 / 256
exported selector functions, and 8 / 16 / 32 aggregation rounds. Source and
artifact sizes and hashes are recorded in `manifest.json`. These are synthetic
single modules; they do not model dependency graphs or every production bundle.

The page defaults to 20 pairs per size with two additional warmup pairs. Every
sample uses a fresh same-origin iframe document. Pair order alternates native →
precompiled and precompiled → native. Workload responses use `no-store`; browser
engine/JIT/code caches and OS scheduling are not reset. Warmups use separate
documents too, so this is a first-import comparison, not steady-state repeated
execution of one already-evaluated namespace.

Both variants must pass checksum, data shape, default/named exports, live-binding,
function return and execute-once checks. Samples with an error, hidden document,
WASM request or unexpected input are rejected. Failed suites can be exported for
diagnosis but cannot produce a performance summary. Browser and isolation state
must remain identical across a suite. The local server uses COOP/COEP for finer
browser timer precision; the actual isolation state is saved in every sample.

Keep DevTools recording and unrelated CPU work off during statistical runs.
The Conditions field only records external throttling; it does not apply it.
Very small modules can approach timer resolution, so inspect absolute differences
alongside ratios. A precompiled/native ratio above 1 means precompiled was slower.
The paired-overhead statistic is the median of each pair's compiled-minus-native
time, not the difference of two medians. No pass/fail speed threshold is imposed.

## Raw results and automation

Download JSON from the page. It includes warmups, all samples, Resource Timing,
browser information, input hashes, runtime source hash, package version and
correctness checks. Keep local measurements under the ignored `log/` directory.

```sh
node benchmarks/browser/summarize.mjs log/browser-benchmark/results.json
pnpm exec tsc -p benchmarks/browser/tsconfig.json
```

The summary rejects incomplete, missing, duplicate or mismatched A/B pairs and
reports median/P75 for ready and body time, the ratio of ready medians, and
paired overhead. Different suites are not silently pooled.

The same **existing** browser can start a run after the page is ready:

```js
await window.esmExecutionBenchmark.runSuite({
  fixtures: ["small", "medium", "large"],
  pairs: 20,
  warmups: 2,
  condition: "No external throttling",
});
// window.esmExecutionBenchmark.suite contains the exportable results.
```

For a trace, open `trial.html?mode=native&fixture=large` and repeat with
`mode=precompiled` in the same browser. The trial emits
`module-benchmark:import-ready` as a User Timing measure. Capture traces separately
from the statistical suite. Build output stays in `log/browser-benchmark/dist`.
