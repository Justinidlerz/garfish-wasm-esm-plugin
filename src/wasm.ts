import initWasm, {
  transform as transformWithOxc,
} from '../pkg/garfish_wasm_esm_plugin.js';

export type WasmInitInput = Parameters<typeof initWasm>[0];

export interface WasmImportInfo {
  moduleId: string;
}

export interface WasmTransformResult {
  code: string;
  imports: WasmImportInfo[];
  exports: string[];
}

let initPromise: Promise<void> | undefined;

export function initGarfishEsModuleWasm(input?: WasmInitInput) {
  if (!initPromise) {
    initPromise = Promise.resolve(initWasm(input)).then(() => undefined);
  }
  return initPromise;
}

export async function transformModuleWithWasm(
  code: string,
  filename: string,
  input?: WasmInitInput,
) {
  await initGarfishEsModuleWasm(input);
  return transformWithOxc(code, filename) as WasmTransformResult;
}
