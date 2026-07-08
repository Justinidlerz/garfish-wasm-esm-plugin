import { describe, expect, it } from 'vitest';
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
});
