# garfish-wasm-esm-plugin

[![codecov](https://codecov.io/gh/Justinidlerz/garfish-wasm-esm-plugin/branch/master/graph/badge.svg)](https://app.codecov.io/gh/Justinidlerz/garfish-wasm-esm-plugin)

Garfish plugin for running `<script type="module">` resources through a browser
WebAssembly transformer. The wasm core uses OXC to parse ESM syntax and rewrites
imports/exports into the Garfish runtime helpers.

## Usage

```ts
import Garfish from 'garfish';
import { GarfishEsModule } from 'garfish-wasm-esm-plugin';

Garfish.run({
  plugins: [
    GarfishEsModule(),
  ],
});
```

The plugin only handles scripts that Garfish already marks as module scripts.
For Vite-style sub applications, keep using an HTML entry with
`<script type="module">`.

## Build-time compilation

The compiler entry can turn an emitted ESM module into a JavaScript artifact
that the runtime consumes without loading the wasm transformer:

```ts
import { compileGarfishModule } from 'garfish-wasm-esm-plugin/compiler';

const artifact = await compileGarfishModule(
  emittedChunk.code,
  emittedChunk.fileName,
);

// Emit `artifact` into the Garfish build using the same relative file name.
```

The artifact is a JavaScript file whose leading comment carries the static
import and export metadata produced by OXC. The transformed module body still
runs through the existing Garfish sandbox execution path, so no separate
manifest is required.

For dual output, keep matching directory structures so relative module
specifiers resolve without a runtime URL convention:

```text
dist/esm/assets/main.js
dist/esm/assets/dependency.js
dist/garfish/assets/main.js
dist/garfish/assets/dependency.js
```

Import the browser runtime from the runtime-only entry and disable fallback
compilation after the Garfish tree is complete:

```ts
import Garfish from 'garfish';
import { GarfishEsModule } from 'garfish-wasm-esm-plugin/runtime';

Garfish.run({
  plugins: [
    GarfishEsModule({
      runtimeCompile: false,
    }),
  ],
});
```

`runtimeCompile` defaults to `true` for compatibility. Precompiled artifacts
always bypass wasm transformation. When the option is `true`, a plain ESM
module can still fall back to browser compilation; when it is `false`, loading
a plain ESM module fails with an explicit error.

### Vite plugin

The Vite entry keeps the original ESM output and emits a precompiled Garfish
mirror during the same build:

```ts
import { defineConfig } from 'vite';
import { garfishPrecompile } from 'garfish-wasm-esm-plugin/vite';

export default defineConfig({
  plugins: [
    garfishPrecompile({
      outDir: 'garfish',
      htmlEntries: ['subapp.html'],
    }),
  ],
});
```

For every JavaScript chunk, the plugin emits a compiled asset under the same
relative path below `garfish/`. Non-HTML assets are mirrored by default so
relative asset URLs keep working. Listed HTML entries are also mirrored and
their absolute Vite asset URLs are redirected to the Garfish tree. Original
ESM chunks and HTML remain unchanged.

```text
dist/assets/main.js
dist/subapp.html
dist/garfish/assets/main.js
dist/garfish/subapp.html
```

The generated Garfish HTML keeps its module script tags, so load it with
`GarfishEsModule({ runtimeCompile: false })`. Generated sourcemaps are not
supported yet because the precompiled code needs a new mapping rather than a
copy of Vite's ESM map.

## Supported Resolution

This version supports both HTML import maps and Garfish externals at runtime.

HTML import maps are read from the sub application's HTML entry:

```html
<script type="importmap">
{
  "imports": {
    "@scope/shared": "https://cdn.example.com/shared/index.js"
  }
}
</script>
```

Bare imports that are not provided by Garfish externals are resolved with
`@jspm/import-map` against the current module URL.

Garfish externals are read from `Garfish.externals`. The matching rule follows
import map semantics:

- keys without a trailing slash match only the exact module id;
- keys with a trailing slash match that full prefix, so `@abc/def/` externalizes
  imports such as `@abc/def/test.js`;
- the longest matching external prefix wins when multiple prefix keys match.
  Every matching subpath reads from the external module value registered under
  that prefix key.

```ts
import React from 'react';
import * as sharedWidgets from '@abc/def';
import Garfish from 'garfish';
import { GarfishEsModule } from 'garfish-wasm-esm-plugin';

Garfish.externals = {
  react: React,
  '@abc/def/': sharedWidgets,
};

Garfish.run({
  plugins: [
    GarfishEsModule({
      garfishExternals: ['react', '@abc/def/'],
    }),
  ],
});
```

With the config above, `import React from 'react'` is exact-matched, while
`import { Button } from '@abc/def/button.js'` is treated as external because it
matches the `@abc/def/` prefix. `@abc/defx/button.js` does not match that prefix.

Runtime-generated namespace modules stay live: exported getters read the current
value from the backing module object instead of capturing an initial snapshot.

## Wasm Size

The generated transformer artifact is
`pkg/garfish_wasm_esm_plugin_bg.wasm`.

| Artifact | Size |
| --- | ---: |
| Raw wasm | 857,617 bytes (837.5 KiB) |
| Gzip | 326,597 bytes (318.9 KiB) |

The size comes from bundling OXC parser and semantic analysis into the browser
runtime. The semantic pass is intentional because imported bindings need symbol
aware rewriting to preserve ESM live binding behavior after the code is lowered
to Garfish runtime helpers.

## Why This Plugin Exists

Garfish already knows when an HTML entry contains `<script type="module">`, but
the module graph still needs browser-runtime compilation before it can run
inside Garfish's sandboxed execution model. A build-time transform is not enough
for dynamically loaded sub applications because the host may only see the module
source after Garfish has fetched the HTML entry and its scripts.

This package keeps that work in a Garfish plugin boundary:

- wasm runs in the browser and parses the fetched module source on demand;
- OXC AST and semantic data are used instead of regex or text-only rewriting;
- imports, exports, `import.meta`, dynamic `import()`, import maps, and Garfish
  externals are handled by the same runtime;
- live bindings survive the CommonJS-like helper lowering used by the plugin.

## Build

```sh
pnpm install
pnpm build
```

`pnpm build` first runs `wasm-pack build --target web --out-dir pkg`, then builds
the TypeScript Garfish wrapper into `dist`.

## Test

```sh
pnpm test
pnpm test:coverage
```

`pnpm test` runs the Rust unit tests, builds the wasm transformer, and runs
Vitest in Node.
`pnpm test:coverage` writes `coverage/coverage-summary.json` and
`coverage/lcov.info`; CI uploads that report to Codecov.

On pull requests, GitHub Actions uploads the coverage report with
`codecov/codecov-action`; Codecov owns the coverage PR comment and status checks.
The workflow also updates a repository PR comment with Codecov report links and
the latest benchmark table.

## Benchmark

```sh
pnpm benchmark
pnpm benchmark:update
```

`pnpm benchmark` measures the wasm transform path against fixed ESM fixtures.
`pnpm benchmark:update` refreshes both `benchmarks/transform.md` and the table
below.

<!-- benchmark-results:start -->

| Fixture | Source bytes | Mean | p75 | p99 | Throughput | Samples |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `small-live-bindings` | 255 | 0.011 ms | 0.011 ms | 0.014 ms | 90,876 ops/sec | 90,215 |
| `medium-dashboard` | 1,247 | 0.064 ms | 0.063 ms | 0.078 ms | 15,850 ops/sec | 15,707 |
| `large-re-export` | 5,314 | 0.250 ms | 0.250 ms | 0.348 ms | 4,010 ops/sec | 3,993 |

Measured on Node v22.23.1 with `BENCH_TIME_MS=1000` and `BENCH_WARMUP_MS=250`.

<!-- benchmark-results:end -->


## Vite Example

```sh
pnpm example:dev
```

The example starts a Garfish host page that loads `subapp.html` as an HTML entry
with a `<script type="module">` sub application. It imports this package through
the local source alias so changes in `src/` can be exercised without publishing.

## Release

This package uses Changesets. Add a changeset for user-facing package changes:

```sh
pnpm changeset
```

GitHub Actions expects an `NPM_TOKEN` repository secret with permission to publish
`garfish-wasm-esm-plugin` to npm.

When a same-repository PR includes a releasable changeset, CI consumes that
changeset in the runner workspace and publishes a beta package with the npm
`beta` dist tag. The beta version format is:

```text
<next-version>-pr-<pr-number>-<utc-YYYYMMDDHHMMSS>
```

When the PR is merged into `master`, CI consumes the changeset, commits the
version/changelog metadata, publishes the formal npm package with the default
dist tag, then pushes the release commit and tags back to `master`.
