import { describe, expect, it } from 'vitest';
import { createScenario } from '../examples/vite/performance/fixtures';
import { transformFixture } from './wasm';

describe('performance graph fixtures', () => {
  it('describes the actual OXC-parsed imports for every generated module', async () => {
    const { sources, manifest } = createScenario();
    expect(manifest.staticModules).toBe(117);
    expect(manifest.totalModules).toBe(124);
    expect(new Set(manifest.expectedOrder).size).toBe(manifest.staticModules);
    expect(manifest.expectedOrder.at(-1)).toBe('entry.js');
    expect(manifest.expectedOrder).not.toContain('lazy.js');
    expect(
      Object.values(manifest.edges).reduce(
        (count, deps) => count + deps.length,
        0,
      ),
    ).toBe(295);
    for (const [id, source] of sources) {
      const output = await transformFixture(
        source,
        `https://example.test/${id}`,
      );
      const imported = output.imports.map(({ moduleId }) =>
        new URL(moduleId, `https://example.test/${id}`).pathname.slice(1),
      );
      expect(imported, id).toEqual(manifest.edges[id]);
      for (const dependency of imported)
        expect(sources.has(dependency), dependency).toBe(true);
    }
  });
});
