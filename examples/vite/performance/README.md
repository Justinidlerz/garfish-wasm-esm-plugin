**ESM dependency scheduling experiment**

Run `pnpm example:performance`, then open the printed local URL in an existing browser instance. After building once, `pnpm example:performance:serve` starts only the production example server. The ordinary Vite preview server does not simulate workload delays. No browser is launched by these commands.

The comparison uses the same build with `dependencyScheduling: 'batch'` (default) and `'streaming'` (opt-in). Batch retains the breadth-first/allSettled barrier; both modes share failed-subgraph protection, URL resolution, the 24-load Runtime queue and evaluation. Successful independent subgraphs remain reusable when another branch fails. Streaming is experimental and does not change the default policy.

The scenario generator creates five layers with widths `[8, 24, 24, 24, 24]`, ten shared modules, a two-module cycle and a dynamic-import branch: 117 initial modules, 124 in total, 295 static edges across both graphs. Each generated source is compiled by the actual OXC/WASM compiler into a separate artifact; original ESM is emitted beside it for inspection. Module payloads vary from about 1 to 7 KiB. The subapp mounts 80 data cards and a visible heading after executing its graph.

The server applies identical seeded delays to both modes:

| Profile | Added response delay |
| --- | --- |
| mixed | 20–69 ms, with a seeded one-in-seven subset receiving another 220–319 ms |
| uniform | 65 ms per workload response |
| local | No added delay |

These are server response delays over HTTP/1.1, not a network throughput or RTT emulator. Browser per-origin connection limits still apply. No resource URL or scenario name is special-cased in the runtime. The seed affects only server timing, not module contents or scheduling.

Each comparison uses a fresh iframe document/Runtime/Loader, and workload responses use `Cache-Control: no-store`. This deliberately measures cold module resources; it does not measure browser preload reuse. Shell resources may be cached. There are no workload preload hints and runtime compilation is disabled. Each pair uses the same seed and URLs, with A/B order alternating. One warmup per mode/profile is retained in raw output but excluded from summary statistics.

The UI runs eight pairs by default. The existing browser can also call:

```js
await window.esmPerformance.runSuite({
  profiles: ['mixed', 'uniform', 'local'],
  pairs: 8,
  condition: 'CPU 1x',
});
```

Read `window.esmPerformance.results` or use Download raw results. Each record includes module load/expand events, Resource Timing and Server Timing, long tasks, actual module execution order, checksum, cycle/live-binding results and dynamic import validation. The harness checks concurrency and execution exactly once. `pnpm test` also covers dependency scheduling, failure handling, diagnostic callbacks, removal of plugin preload APIs, generated import metadata and sample-summary validation.

The condition label records externally configured CPU/network emulation; it does not apply throttling. Set it accurately when using DevTools emulation so separate conditions are not aggregated. Summarize exported records with `node examples/vite/performance/summarize.mjs results.json`. This also rejects missing or duplicate pairs and checks paired response sizes/seeded delays, duplicate requests and observed delivery sources. Keep exported measurements, traces and local reports in the ignored `log/` directory.

Metrics use `performance.now()`:

- `graphMs`: initial graph start → graph-ready. This excludes Core's earlier HTML/entry fetch and module evaluation.
- `appReadyMs`: Garfish loadApp start → provider render and mount complete. This includes entry discovery/loading, graph loading, execution and DOM creation.
- `appFrameMs`: loadApp start → two requestAnimationFrame callbacks after mount. This is a rendering opportunity milestone, not an assertion about pixel presentation or LCP.
- `expandWaitMaxMs`: maximum parse-ready → dependency expansion delay for an initial-graph module.
- `expandWaitSumMs`: sum of module waits for diagnosis only. Modules overlap; this is not graph/page elapsed time.
- `dynamicMs`: dynamic import after the initial rendering opportunity. Shared modules should be reused.

For a Chrome Performance trace, navigate the same existing browser tab directly to `/performance-run.html?mode=batch&profile=mixed&seed=41`, start a reload trace, then repeat with `mode=streaming`. The page emits `esm:load:*`, `esm:expand-wait:*`, `esm:graph`, `esm:app-ready` and `esm:app-frame` User Timing measures. Record traces separately from the paired statistical runs because tracing adds overhead. LCP from a top-level trace is a synthetic-page measurement; iframe timings are not a Seller Center LCP result.

`loadObserver` is optional synchronous diagnostics with isolated exceptions/rejections. It reports load/graph timing rather than full production tracing: it does not yet provide navigation correlation, sampling policy or cross-Runtime request identity. Keep the callback cheap; the example bounds its event array. Streaming remains opt-in pending broader compatibility and production validation. Plugin-owned preload APIs have been removed; Garfish retains responsibility for resource hints. Compiler/sourcemap behavior is unchanged.
