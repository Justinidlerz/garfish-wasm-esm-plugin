import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WasmInitInput, WasmTransformResult } from '../src/wasm';
import { transformModuleWithWasm } from '../src/wasm';

let wasmBytes: WasmInitInput | undefined;

export function getWasmBytes() {
  if (!wasmBytes) {
    wasmBytes = readFileSync(
      resolve('pkg/garfish_wasm_esm_plugin_bg.wasm'),
    );
  }
  return wasmBytes;
}

export function transformFixture(
  code: string,
  filename = 'https://example.test/entry.js',
) {
  return transformModuleWithWasm(
    trimSource(code),
    filename,
    getWasmBytes(),
  ) as Promise<WasmTransformResult>;
}

export function trimSource(code: string) {
  return `${code.trim()}\n`;
}
