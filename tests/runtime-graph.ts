import { setImmediate } from 'node:timers/promises';
import { vi } from 'vitest';
import { compileGarfishModule } from '../src/compiler';
import { Runtime, type RuntimeOptions } from '../src/runtime';
import { getWasmBytes } from './wasm';

export const moduleUrl = (name: string) => `https://example.test/${name}`;
// Advance the event loop so promise continuations drain, without timed sleeps.
export const nextTurn = () => setImmediate();

export async function createGraph(
  sources: Record<string, string>,
  options: Partial<RuntimeOptions> = {},
) {
  const artifacts = new Map(
    await Promise.all(
      Object.entries(sources).map(
        async ([name, source]) =>
          [
            name,
            await compileGarfishModule(source, moduleUrl(name), {
              wasm: getWasmBytes(),
            }),
          ] as const,
      ),
    ),
  );
  const pending = new Map<
    string,
    {
      resolve: (value: {
        resourceManager: { url: string; scriptCode: string };
      }) => void;
      reject: (error: unknown) => void;
    }
  >();
  const load = vi.fn(
    ({ url }: { url: string }) =>
      new Promise((resolve, reject) => {
        const name = new URL(url).pathname.slice(1);
        if (pending.has(name))
          throw new Error(`Duplicate in-flight request: ${name}`);
        pending.set(name, { resolve, reject });
      }),
  );
  const runtime = new Runtime({
    scope: 'graph-test',
    runtimeCompile: false,
    compileCache: false,
    ...options,
  });
  runtime.loader = { load } as unknown as Runtime['loader'];

  function complete(name: string, error?: Error) {
    const request = pending.get(name);
    if (!request) throw new Error(`No pending request: ${name}`);
    pending.delete(name);
    if (error) request.reject(error);
    else {
      const scriptCode = artifacts.get(name);
      if (!scriptCode) throw new Error(`No fixture: ${name}`);
      request.resolve({
        resourceManager: { url: moduleUrl(name), scriptCode },
      });
    }
  }

  async function drain<T>(promise: Promise<T>): Promise<T> {
    let done = false;
    const outcome = promise.then(
      (value) => {
        done = true;
        return { value };
      },
      (error: unknown) => {
        done = true;
        return { error };
      },
    );
    for (let turn = 0; !done && turn < 100; turn++) {
      for (const name of [...pending.keys()]) complete(name);
      await nextTurn();
    }
    if (!done) throw new Error('Module graph did not settle');
    const result = await outcome;
    if ('error' in result) throw result.error;
    return result.value;
  }

  return {
    runtime,
    load,
    pending,
    complete,
    drain,
    artifacts,
    requested: () =>
      load.mock.calls.map(([{ url }]) => new URL(url).pathname.slice(1)),
  };
}
