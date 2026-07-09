import { describe, expect, it, vi } from 'vitest';
import { evalWithEnv } from '@garfish/utils';
import { Runtime } from '../src/runtime';
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
