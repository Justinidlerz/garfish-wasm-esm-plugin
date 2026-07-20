import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const packageDirectory = resolve('pkg');
mkdirSync(packageDirectory, { recursive: true });

for (const filename of [
  'garfish_wasm_esm_plugin.js',
  'garfish_wasm_esm_plugin.d.ts',
  'garfish_wasm_esm_plugin_bg.wasm.d.ts',
]) {
  copyFileSync(resolve('wasm', filename), resolve(packageDirectory, filename));
}

copyFileSync(
  resolve('zig-out/bin/garfish_wasm_esm_plugin_bg.wasm'),
  resolve(packageDirectory, 'garfish_wasm_esm_plugin_bg.wasm'),
);
chmodSync(resolve(packageDirectory, 'garfish_wasm_esm_plugin_bg.wasm'), 0o644);
