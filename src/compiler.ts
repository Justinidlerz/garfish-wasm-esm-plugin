import { createCompiledModuleArtifact } from './compiled-module';
import {
  transformModuleWithWasm,
  type WasmInitInput,
  type WasmTransformResult,
} from './wasm';

export interface CompileGarfishModuleOptions {
  wasm?: WasmInitInput;
}

export async function compileGarfishModule(
  source: string,
  filename: string,
  options: CompileGarfishModuleOptions = {},
) {
  const output = await transformModuleWithWasm(
    source,
    filename,
    options.wasm,
  );
  return createCompiledModuleArtifact(output);
}

export {
  initGarfishEsModuleWasm,
  transformModuleWithWasm,
} from './wasm';
export type {
  WasmImportInfo,
  WasmInitInput,
  WasmTransformResult,
} from './wasm';
export type { CompiledModule, ModuleImportInfo } from './compiled-module';

export type GarfishModuleTransformResult = WasmTransformResult;
