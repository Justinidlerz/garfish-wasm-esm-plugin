import { describe, expect, it } from 'vitest';
import { transformFixture } from './wasm';

describe('wasm transform', () => {
  it('rewrites imported reads through live module getters', async () => {
    const result = await transformFixture(`
      import def, { count, inc as plus } from './dep.js';

      const snapshot = count;
      const bag = { count, plus };

      export { count as liveCount };
      export default function read() {
        return plus() + def + snapshot + bag.count;
      }
    `);

    expect(result.imports).toEqual([{ moduleId: './dep.js' }]);
    expect(result.exports).toEqual(['default', 'liveCount']);
    expect(result.code).toContain(
      'const __m0__ = __GARFISH_IMPORT__("./dep.js");',
    );
    expect(result.code).not.toContain('const def =');
    expect(result.code).not.toContain('const count =');
    expect(result.code).not.toContain('const plus =');
    expect(result.code).toContain('const snapshot = (0, __m0__.count);');
    expect(result.code).toContain(
      'const bag = { count: (0, __m0__.count), plus: (0, __m0__.inc) };',
    );
    expect(result.code).toContain('"liveCount": () => (0, __m0__.count)');
    expect(result.code).toContain('"default": () => read');
    expect(result.code).toContain(
      'return (0, __m0__.inc)() + (0, __GARFISH_DEFAULT_IMPORT__(__m0__))',
    );
  });

  it('preserves namespace and side-effect import evaluation', async () => {
    const result = await transformFixture(`
      import './setup.js';
      import * as dep from './dep.js';

      export const value = dep.value;
    `);

    expect(result.imports).toEqual([
      { moduleId: './setup.js' },
      { moduleId: './dep.js' },
    ]);
    expect(result.code).toContain('__GARFISH_IMPORT__("./setup.js");');
    expect(result.code).toContain(
      'const __m1__ = __GARFISH_IMPORT__("./dep.js");',
    );
    expect(result.code).toContain(
      'const dep = __GARFISH_NAMESPACE__(__m1__);',
    );
    expect(result.code).toContain('const value = dep.value;');
  });

  it('registers export getters after directives and before static imports', async () => {
    const result = await transformFixture(`
      'use strict';
      import { read } from './dep.js';

      export const value = read();
    `);

    const directiveIndex = result.code.indexOf("'use strict';");
    const exportIndex = result.code.indexOf('__GARFISH_EXPORT__({');
    const importIndex = result.code.indexOf(
      'const __m0__ = __GARFISH_IMPORT__("./dep.js");',
    );

    expect(directiveIndex).toBeGreaterThanOrEqual(0);
    expect(exportIndex).toBeGreaterThan(directiveIndex);
    expect(importIndex).toBeGreaterThan(exportIndex);
  });

  it('keeps shadowed locals separate from imported bindings', async () => {
    const result = await transformFixture(`
      import { count } from './dep.js';

      const outer = count;
      function read(count) {
        return count;
      }

      export const value = read(outer);
    `);

    expect(result.code).toContain('const outer = (0, __m0__.count);');
    expect(result.code).toContain('function read(count) {');
    expect(result.code).toContain('return count;');
    expect(result.code).not.toContain('export const');
    expect(result.code).not.toContain('return (0, __m0__.count);');
  });

  it('rewrites re-exports, import.meta, and dynamic import helpers', async () => {
    const result = await transformFixture(`
      export * from './all.js';
      export * as all from './all.js';

      export const currentUrl = import.meta.url;
      export const lazy = () => import('./lazy.js');
    `);

    expect(result.imports).toEqual([{ moduleId: './all.js' }]);
    expect(result.code).toContain(
      'const __m0__ = __GARFISH_IMPORT__("./all.js");',
    );
    expect(result.code).toContain(
      'const __m1__ = __GARFISH_IMPORT__("./all.js");',
    );
    expect(result.code).toContain(
      '"all": () => __GARFISH_NAMESPACE__(__m1__)',
    );
    expect(result.code).toContain('__GARFISH_IMPORT_META__.meta.url');
    expect(result.code).toContain('__GARFISH_DYNAMIC_IMPORT__');
    expect(result.code).toContain(
      '__GARFISH_EXPORT_STAR__(__m0__, ["all","currentUrl","default","lazy"]);',
    );
  });

  it('reports parser errors with the source filename', async () => {
    await expect(
      transformFixture('export const broken = }', '/broken.js'),
    ).rejects.toThrow('/broken.js');
  });
});
