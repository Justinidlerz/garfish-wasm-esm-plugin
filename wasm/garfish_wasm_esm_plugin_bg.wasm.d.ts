export const memory: WebAssembly.Memory;
export const alloc: (length: number) => number;
export const free: (pointer: number, length: number) => void;
export const transform: (
    sourcePointer: number,
    sourceLength: number,
    filenamePointer: number,
    filenameLength: number,
) => number;
