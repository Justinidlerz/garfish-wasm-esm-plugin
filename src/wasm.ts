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

function normalizeWasmInitInput(input?: WasmInitInput): WasmInitInput | undefined {
  if (
    input === undefined ||
    (typeof input === 'object' &&
      input !== null &&
      Object.prototype.hasOwnProperty.call(input, 'module_or_path'))
  ) {
    return input;
  }

  return { module_or_path: input } as WasmInitInput;
}

export function initGarfishEsModuleWasm(input?: WasmInitInput) {
  if (!initPromise) {
    initPromise = Promise.resolve(initWasm(normalizeWasmInitInput(input))).then(
      () => undefined,
    );
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
