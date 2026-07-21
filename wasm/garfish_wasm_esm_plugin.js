let wasm;
let wasmModule;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function start() {}

export function transform(source, filename) {
    if (!wasm) {
        throw new Error('garfish-wasm-esm-plugin is not initialized');
    }

    const sourceBuffer = passString(source);
    const filenameBuffer = passString(filename);
    let outputPointer = 0;

    try {
        outputPointer = wasm.transform(
            sourceBuffer.pointer,
            sourceBuffer.length,
            filenameBuffer.pointer,
            filenameBuffer.length,
        );
        if (outputPointer === 0) {
            throw new Error(`Failed to transform ${filename}`);
        }
        return decodeResult(outputPointer);
    } finally {
        wasm.free(sourceBuffer.pointer, sourceBuffer.capacity);
        wasm.free(filenameBuffer.pointer, filenameBuffer.capacity);
        if (outputPointer !== 0) {
            const payloadLength = new DataView(wasm.memory.buffer).getUint32(
                outputPointer,
                true,
            );
            wasm.free(outputPointer, payloadLength + 4);
        }
    }
}

function passString(value) {
    const capacity = Math.max(value.length * 3, 1);
    const pointer = wasm.alloc(capacity);
    const target = new Uint8Array(wasm.memory.buffer, pointer, capacity);
    if (typeof encoder.encodeInto === 'function') {
        const { written } = encoder.encodeInto(value, target);
        return { pointer, length: written, capacity };
    }
    const bytes = encoder.encode(value);
    target.set(bytes);
    return { pointer, length: bytes.length, capacity };
}

function decodeResult(pointer) {
    const memory = wasm.memory.buffer;
    const view = new DataView(memory);
    const payloadLength = view.getUint32(pointer, true);
    const end = pointer + payloadLength + 4;
    let offset = pointer + 4;

    const readU32 = () => {
        const value = view.getUint32(offset, true);
        offset += 4;
        return value;
    };
    const readString = () => {
        const length = readU32();
        const value = decoder.decode(new Uint8Array(memory, offset, length));
        offset += length;
        return value;
    };

    const status = readU32();
    if (status === 1) {
        throw new Error(readString());
    }
    if (status !== 0) {
        throw new Error('Invalid Zig transformer result status');
    }

    const code = readString();
    const importCount = readU32();
    const imports = Array.from({ length: importCount }, () => ({ moduleId: readString() }));
    const exportCount = readU32();
    const exports = Array.from({ length: exportCount }, readString);
    if (offset !== end) {
        throw new Error('Invalid Zig transformer result length');
    }
    return { code, imports, exports };
}

function normalizeInitInput(input) {
    if (
        input &&
        typeof input === 'object' &&
        Object.prototype.hasOwnProperty.call(input, 'module_or_path')
    ) {
        return input.module_or_path;
    }
    return input;
}

async function instantiate(input) {
    const resolved = await input;
    if (typeof Response === 'function' && resolved instanceof Response) {
        const fallbackResponse = resolved.clone();
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(resolved, {});
            } catch {}
        }
        return WebAssembly.instantiate(await fallbackResponse.arrayBuffer(), {});
    }

    if (resolved instanceof WebAssembly.Module) {
        return {
            instance: await WebAssembly.instantiate(resolved, {}),
            module: resolved,
        };
    }

    return WebAssembly.instantiate(resolved, {});
}

async function defaultWasmInput() {
    const url = new URL('./garfish_wasm_esm_plugin_bg.wasm', import.meta.url);
    if (url.protocol === 'file:') {
        const filesystem = globalThis.process?.getBuiltinModule?.('node:fs');
        if (!filesystem) {
            throw new Error('Pass wasm bytes when loading this package from a file URL');
        }
        return filesystem.promises.readFile(url);
    }
    return fetch(url);
}

function finalizeInit(result) {
    wasm = result.instance.exports;
    wasmModule = result.module;
    return wasm;
}

export function initSync(input) {
    if (wasm) return wasm;
    const normalized =
        input &&
        typeof input === 'object' &&
        Object.prototype.hasOwnProperty.call(input, 'module')
            ? input.module
            : input;
    const module = normalized instanceof WebAssembly.Module
        ? normalized
        : new WebAssembly.Module(normalized);
    return finalizeInit({
        instance: new WebAssembly.Instance(module, {}),
        module,
    });
}

export default async function init(input) {
    if (wasm) return wasm;
    const normalized = normalizeInitInput(input);
    return finalizeInit(
        await instantiate(normalized === undefined ? defaultWasmInput() : normalized),
    );
}

export { wasmModule };
