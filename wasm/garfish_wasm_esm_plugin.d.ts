export interface TransformImportInfo {
    moduleId: string;
}

export interface TransformResult {
    code: string;
    imports: TransformImportInfo[];
    exports: string[];
}

export function start(): void;
export function transform(source: string, filename: string): TransformResult;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly alloc: (length: number) => number;
    readonly free: (pointer: number, length: number) => void;
    readonly transform: (
        sourcePointer: number,
        sourceLength: number,
        filenamePointer: number,
        filenameLength: number,
    ) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

export function initSync(
    input: { module: SyncInitInput } | SyncInitInput,
): InitOutput;

export default function init(
    input?:
        | { module_or_path: InitInput | Promise<InitInput> }
        | InitInput
        | Promise<InitInput>,
): Promise<InitOutput>;

export const wasmModule: WebAssembly.Module | undefined;
