import type {
  CompileGarfishModuleOptions,
  GarfishModuleTransformResult,
} from './compiler';
import type {
  WasmImportInfo,
  WasmInitInput,
  WasmTransformResult,
} from './wasm';

export * from './runtime-entry';
export { default } from './runtime-entry';
export type {
  CompileGarfishModuleOptions,
  GarfishModuleTransformResult,
};
export type {
  WasmImportInfo,
  WasmInitInput,
  WasmTransformResult,
};
export { GARFISH_ES_MODULE_PRELOADS_SYMBOL } from './preloads';
export type {
  GarfishEsModulePreloadCrossOrigin,
  GarfishEsModulePreloadDescriptor,
  GarfishEsModulePreloadRel,
} from './preloads';

export async function compileGarfishModule(
  source: string,
  filename: string,
  options: CompileGarfishModuleOptions = {},
) {
  const compiler = await import('./compiler');
  return compiler.compileGarfishModule(source, filename, options);
}

export async function initGarfishEsModuleWasm(input?: WasmInitInput) {
  const wasm = await import('./wasm');
  return wasm.initGarfishEsModuleWasm(input);
}

export async function transformModuleWithWasm(
  code: string,
  filename: string,
  input?: WasmInitInput,
): Promise<WasmTransformResult> {
  const wasm = await import('./wasm');
  return wasm.transformModuleWithWasm(code, filename, input);
}
