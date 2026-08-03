import { createCompiledModuleArtifact } from './compiled-module';
import {
  transformModuleWithWasm,
  type WasmInitInput,
  type WasmTransformResult,
} from './wasm';

export interface CompileGarfishModuleOptions {
  wasm?: WasmInitInput;
}

const getDefaultCompilerWasm = async (): Promise<WasmInitInput> => {
  const wasmUrl = new URL(
    '../pkg/garfish_wasm_esm_plugin_bg.wasm',
    import.meta.url,
  );

  if (wasmUrl.protocol !== 'file:') return wasmUrl;

  // Keep the Node-only loader lazy so importing the root/runtime entry in a
  // browser does not resolve or bundle a Node builtin.
  const nodeFsPromises = 'node:fs/promises';
  const { readFile } = await import(/* @vite-ignore */ nodeFsPromises);
  return (await readFile(wasmUrl)) as unknown as WasmInitInput;
};

export async function compileGarfishModule(
  source: string,
  filename: string,
  options: CompileGarfishModuleOptions = {},
) {
  const wasm = options.wasm ?? (await getDefaultCompilerWasm());
  const output = await transformModuleWithWasm(
    source,
    filename,
    wasm,
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
