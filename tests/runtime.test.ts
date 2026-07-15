import { describe, expect, it, vi } from 'vitest';
import { evalWithEnv } from '@garfish/utils';
import {
  Runtime,
  type ModuleResource,
  type RuntimeCompileCache,
  type RuntimeCompileMetric,
} from '../src/runtime';
import { getWasmBytes, trimSource } from './wasm';

describe('Runtime', () => {
  it('executes transformed modules with external live bindings', async () => {
    const dep = {
      count: 1,
      inc() {
        dep.count += 1;
        return dep.count;
      },
    };
    const runtime = new Runtime({
      scope: 'test',
      wasm: getWasmBytes(),
      garfishExternals: {
        dep,
      },
    });

    const module = await runtime.importByCode(
      trimSource(`
        import { count, inc } from 'dep';

        export const before = count;
        inc();
        export const after = count;
        export { count };
      `),
      'https://example.test/app.js',
    );

    expect(module.before).toBe(1);
    expect(module.after).toBe(2);
    expect(module.count).toBe(2);

    dep.count = 7;
    expect(module.count).toBe(7);
  });

  it('provides default imports, namespace imports, and import.meta', async () => {
    const externalModule = {
      default: 'primary',
      named: 'value',
    };
    const runtime = new Runtime({
      scope: 'test',
      wasm: getWasmBytes(),
      garfishExternals: {
        external: externalModule,
      },
    });

    const module = await runtime.importByCode(
      trimSource(`
        import externalDefault, * as externalNamespace from 'external';

        export const defaultValue = externalDefault;
        export const namedValue = externalNamespace.named;
        export const namespaceTag = Object.prototype.toString.call(externalNamespace);
        export const moduleUrl = import.meta.url;
      `),
      'https://example.test/app.js',
      'https://cdn.example.test/app.js',
    );

    expect(module.defaultValue).toBe('primary');
    expect(module.namedValue).toBe('value');
    expect(module.namespaceTag).toBe('[object Module]');
    expect(module.moduleUrl).toBe('https://cdn.example.test/app.js');
  });

  it('matches external prefixes only when the key uses import-map-style trailing slash', async () => {
    const exactModule = { value: 'exact' };
    const prefixModule = { value: 'prefix' };
    const runtime = new Runtime({
      scope: 'test',
      wasm: getWasmBytes(),
      garfishExternals: {
        '@abc/def': exactModule,
        '@abc/def/': prefixModule,
      },
    });

    expect(runtime.isExternalModule('@abc/def')).toBe(true);
    expect(runtime.isExternalModule('@abc/def/test.js')).toBe(true);
    expect(runtime.isExternalModule('@abc/defx/test.js')).toBe(false);

    const exactOnlyRuntime = new Runtime({
      scope: 'test',
      garfishExternals: {
        'exact-only': exactModule,
      },
    });

    expect(exactOnlyRuntime.isExternalModule('exact-only')).toBe(true);
    expect(exactOnlyRuntime.isExternalModule('exact-only/subpath.js')).toBe(
      false,
    );

    const module = await runtime.importByCode(
      trimSource(`
        import { value as exactValue } from '@abc/def';
        import { value as prefixValue } from '@abc/def/test.js';

        export { exactValue, prefixValue };
      `),
      'https://example.test/app.js',
    );

    expect(module.exactValue).toBe('exact');
    expect(module.prefixValue).toBe('prefix');
  });

  it('executes named and default live bindings through a circular static graph', async () => {
    const runtime = new Runtime({
      scope: 'test',
      wasm: getWasmBytes(),
      compileCache: false,
    });
    const load = vi.fn(async ({ url }: { url: string }) => ({
      resourceManager: {
        url,
        scriptCode: trimSource(`
          import defaultValue, { named } from './a.js';

          export function readEntry() {
            return defaultValue + ':' + named;
          }
        `),
      },
    }));
    runtime.loader = { load } as any;

    const module = await runtime.importByCode(
      trimSource(`
        import { readEntry } from './b.js';

        export const named = 'named';
        const defaultValue = 'default';
        export default defaultValue;
        export const result = readEntry();
      `),
      'https://example.test/a.js',
    );

    expect(load).toHaveBeenCalledTimes(1);
    expect(module.named).toBe('named');
    expect(module.default).toBe('default');
    expect(module.result).toBe('default:named');
  });

  it('rebuilds dependency resources when transformed code is shared across runtimes', async () => {
    const cacheValues = new Map<
      string,
      ModuleResource | Promise<ModuleResource>
    >();
    const compileCache: RuntimeCompileCache = {
      get: (key) => cacheValues.get(key),
      set: (key, value) => cacheValues.set(key, value),
      delete: (key) => cacheValues.delete(key),
    };
    const entryCode = trimSource(`
      import { value } from './dep.js';
      export const result = value + 1;
    `);
    const dependencyCode = 'export const value = 41;';

    const createRuntime = (metrics: RuntimeCompileMetric[]) => {
      const runtime = new Runtime({
        scope: 'test',
        wasm: getWasmBytes(),
        compileCache,
        metrics: (metric) => metrics.push(metric),
      });
      const load = vi.fn(async ({ url }: { url: string }) => ({
        resourceManager: {
          url,
          scriptCode: dependencyCode,
        },
      }));
      runtime.loader = { load } as any;
      return { load, runtime };
    };

    const firstMetrics: RuntimeCompileMetric[] = [];
    const first = createRuntime(firstMetrics);
    const firstModule = await first.runtime.importByCode(
      entryCode,
      'https://example.test/app.js',
    );

    const secondMetrics: RuntimeCompileMetric[] = [];
    const second = createRuntime(secondMetrics);
    const secondModule = await second.runtime.importByCode(
      entryCode,
      'https://example.test/app.js',
    );

    expect(firstModule.result).toBe(42);
    expect(secondModule.result).toBe(42);
    expect(first.load).toHaveBeenCalledTimes(1);
    expect(second.load).toHaveBeenCalledTimes(1);
    expect(secondMetrics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          storeId: 'https://example.test/app.js',
          cacheHit: true,
        }),
        expect.objectContaining({
          storeId: 'https://example.test/dep.js',
          cacheHit: true,
        }),
      ]),
    );
  });

  it('retries a failed dependency before executing its circular graph', async () => {
    const runtime = new Runtime({
      scope: 'test',
      wasm: getWasmBytes(),
      compileCache: false,
    });
    let attempts = 0;
    const load = vi.fn(async ({ url }: { url: string }) => {
      attempts += 1;
      return {
        resourceManager: {
          url,
          scriptCode:
            attempts === 1
              ? 'export const broken = }'
              : trimSource(`
                  import { value } from './a.js';
                  export function readEntry() {
                    return value;
                  }
                `),
        },
      };
    });
    runtime.loader = { load } as any;
    const entryCode = trimSource(`
      import { readEntry } from './b.js';
      export const value = 42;
      export const result = readEntry();
    `);

    await expect(
      runtime.importByCode(entryCode, 'https://example.test/a.js'),
    ).rejects.toThrow('https://example.test/b.js');

    const module = await runtime.importByCode(
      entryCode,
      'https://example.test/a.js',
    );

    expect(load).toHaveBeenCalledTimes(2);
    expect(module.result).toBe(42);
  });

  it('does not poison a store id when importByCode compilation fails', async () => {
    const storeId = 'https://example.test/retry.js';
    const runtime = new Runtime({
      scope: 'test',
      wasm: getWasmBytes(),
    });

    await expect(
      runtime.importByCode('export const broken = }', storeId),
    ).rejects.toThrow(storeId);
    await expect(
      runtime.importByCode('export const broken = }', storeId),
    ).rejects.toThrow(storeId);

    const module = await runtime.importByCode(
      'export const ok = 1;',
      storeId,
    );

    expect(module.ok).toBe(1);
  });

  it('deduplicates concurrent importByCode execution for the same store id', async () => {
    let executions = 0;
    const storeId = 'https://example.test/inline-singleton.js';
    const runtime = new Runtime({
      scope: 'test',
      wasm: getWasmBytes(),
      execCode(_output, provider) {
        executions += 1;
        (provider as any).__GARFISH_EXPORT__({
          value: () => executions,
        });
      },
    });

    const [first, second] = await Promise.all([
      runtime.importByCode('export const value = 1;', storeId),
      runtime.importByCode('export const value = 1;', storeId),
    ]);

    expect(executions).toBe(1);
    expect(first).toBe(second);
    expect(first.value).toBe(1);
    expect(second.value).toBe(1);
  });

  it('deduplicates concurrent importByUrl execution for the same store id', async () => {
    let executions = 0;
    const storeId = 'https://example.test/lazy.js';
    const runtime = new Runtime({
      scope: 'test',
      wasm: getWasmBytes(),
      execCode(_output, provider) {
        executions += 1;
        (provider as any).__GARFISH_EXPORT__({
          value: () => executions,
        });
      },
    });
    const load = vi.fn(async ({ url }: { url: string }) => ({
      resourceManager: {
        url,
        scriptCode: 'export const value = 1;',
      },
    }));
    runtime.loader = { load } as any;

    const [first, second] = await Promise.all([
      runtime.importByUrl(storeId, storeId),
      runtime.importByUrl(storeId, storeId),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(executions).toBe(1);
    expect(first).toBe(second);
    expect(first.value).toBe(1);
    expect(second.value).toBe(1);
  });

  it('propagates per-call executors to static and dynamic dependencies', async () => {
    const executedStoreIds: string[] = [];
    const runtime = new Runtime({
      scope: 'test',
      wasm: getWasmBytes(),
      compileCache: false,
    });
    const load = vi.fn(async ({ url }: { url: string }) => ({
      resourceManager: {
        url,
        scriptCode: url.endsWith('/dynamic.js')
          ? 'export const dynamicValue = 1;'
          : 'export const staticValue = 41;',
      },
    }));
    runtime.loader = { load } as any;

    const module = await runtime.importByCode(
      trimSource(`
        import { staticValue } from './static.js';

        export const value = staticValue + 1;
        export const loadDynamic = () => import('./dynamic.js');
      `),
      'https://example.test/app.js',
      'https://example.test/app.js',
      (output, provider) => {
        evalWithEnv(`\n${output.code}\n//${output.storeId}\n`, provider, undefined, true);
        executedStoreIds.push(output.storeId);
      },
    );
    const dynamicModule = await module.loadDynamic();

    expect(module.value).toBe(42);
    expect(dynamicModule.dynamicValue).toBe(1);
    expect(executedStoreIds).toEqual([
      'https://example.test/static.js',
      'https://example.test/app.js',
      'https://example.test/dynamic.js',
    ]);
  });
});
