# garfish-wasm-esm-plugin

## 0.4.0

### Minor Changes

- 94146d5: Add a limitConcurrency option to disable the per-Runtime module load concurrency
  limit through the plugin or Runtime options. Preserve the default limit of 24
  concurrent loads when the option is omitted or true.

### Patch Changes

- 4abe3a8: Preserve original module evaluation failures across repeated and concurrent imports instead of reporting missing modules after cleanup. Invalidate failed static importers, including cycles, while retaining independent dependencies and keeping failure state local to each Runtime. Preserve falsy thrown values and the first failure through the Garfish execution queue.

## 0.3.0

### Minor Changes

- a904864: Remove plugin-owned preload, prefetch, and modulepreload handling so resource hints remain under Garfish's control. Remove Runtime.preloadByUrl, Runtime.preloadScript, GARFISH_ES_MODULE_PRELOADS_SYMBOL, and the GarfishEsModulePreload types. Consumers of these APIs should use Garfish's resource loading facilities instead.

### Patch Changes

- a904864: Add opt-in completion-driven dependency scheduling and isolated load diagnostics, preserving the batch default, request limits, and PR-8 failed-subgraph protection. Add a reproducible browser performance example comparing both schedulers on the same multi-layer module graph.

## 0.2.1

### Patch Changes

- daf3459: Preserve complete successful module subgraphs when a sibling dependency fails,
  while keeping failed static graphs rejected and dynamic imports promise-based.

## 0.2.0

### Minor Changes

- b9b00bf: Add circular module graph loading, per-Runtime dependency rebuilding, entry
  preload consumption, build-time OXC compilation, runtime-only and Vite package
  entries, mirrored Garfish build output, and an option to disable browser
  compilation.

## 0.1.3

### Patch Changes

- db55d5e: Match Garfish external prefixes only when the external key uses import-map-style trailing slash syntax.
- cf4ba9a: Fix module execution races and make export rewrites rely on OXC AST spans.

## 0.1.2

### Patch Changes

- 5352f6c: Preserve runtime wasm and Garfish external option identities, and add Vitest coverage plus transform benchmarks.

## 0.1.1

### Patch Changes

- 3154fd3: Preserve ESM live bindings when rewriting named and default imports.
- d51cfe8: Add Changesets release automation and npm publish workflows.
- b4a77d7: Validate the npm beta and release publishing pipeline.
