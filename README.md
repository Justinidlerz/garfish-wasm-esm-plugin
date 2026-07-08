# garfish-wasm-esm-plugin

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

## Build

```sh
pnpm install
pnpm build
```

`pnpm build` first runs `wasm-pack build --target web --out-dir pkg`, then builds
the TypeScript Garfish wrapper into `dist`.

## Vite Example

```sh
pnpm example:dev
```

The example starts a Garfish host page that loads `subapp.html` as an HTML entry
with a `<script type="module">` sub application. It imports this package through
the local source alias so changes in `src/` can be exercised without publishing.
