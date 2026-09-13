import { describe, expect, it } from 'vitest';
import { evalWithEnv } from '@garfish/utils';
import type { DependencyScheduling, RuntimeLoadEvent } from '../src/runtime';
import { createGraph, moduleUrl, nextTurn } from './runtime-graph';

describe('dependency discovery', () => {
  it.each([undefined, 'batch', 'streaming'] as const)(
    '%s scheduling controls whether a slow sibling blocks descendant discovery',
    async (dependencyScheduling) => {
      const executions: string[] = [];
      const graph = await createGraph(
        {
          'entry.js':
            "import { value } from './fast.js'; import './slow.js'; export { value };",
          'fast.js': "export { value } from './child.js';",
          'slow.js': 'export const slow = true;',
          'child.js': 'export const value = 42;',
        },
        {
          dependencyScheduling,
          execCode(output, provider) {
            evalWithEnv(output.code, provider, undefined, true);
            executions.push(output.storeId);
          },
        },
      );
      const imported = graph.runtime.importByUrl(moduleUrl('entry.js'));
      graph.complete('entry.js');
      await nextTurn();
      expect(graph.requested()).toEqual(['entry.js', 'fast.js', 'slow.js']);
      graph.complete('fast.js');
      await nextTurn();
      expect(graph.pending.has('child.js')).toBe(
        dependencyScheduling === 'streaming',
      );
      if (dependencyScheduling === 'streaming') {
        graph.complete('child.js');
        await nextTurn();
      }
      expect(graph.runtime.resources).toEqual({});
      expect(executions).toEqual([]);
      graph.complete('slow.js');
      expect((await graph.drain(imported))!.value).toBe(42);
      expect(executions).toEqual(
        ['child.js', 'fast.js', 'slow.js', 'entry.js'].map(moduleUrl),
      );
    },
  );
});

describe.each<DependencyScheduling>(['batch', 'streaming'])(
  '%s module graphs',
  (dependencyScheduling) => {
    it('deduplicates diamonds and concurrent entries, preserves cycles and lazy live bindings', async () => {
      const executions: string[] = [];
      const graph = await createGraph(
        {
          'entry.js':
            "import { value as left } from './left.js'; import { value as right } from './right.js'; export const sum = left + right; export { count, bump, readCycle } from './cycle-a.js'; export const lazy = () => import('./lazy.js');",
          'other.js': "export { value } from './shared.js';",
          'left.js': "export { value } from './shared.js';",
          'right.js': "export { value } from './shared.js';",
          'shared.js': 'export const value = 21;',
          'cycle-a.js':
            "import { read } from './cycle-b.js'; export let count = 1; export function bump() { count++; } export function readCycle() { return count + read(); }",
          'cycle-b.js':
            "import { count } from './cycle-a.js'; export function read() { return count + 2; }",
          'lazy.js':
            "export { count, readCycle } from './cycle-a.js'; export { value } from './shared.js';",
        },
        {
          dependencyScheduling,
          execCode(output, provider) {
            evalWithEnv(output.code, provider, undefined, true);
            executions.push(output.storeId);
          },
        },
      );
      const first = graph.runtime.importByUrl(moduleUrl('entry.js'));
      const duplicate = graph.runtime.importByUrl(moduleUrl('entry.js'));
      const other = graph.runtime.importByUrl(moduleUrl('other.js'));
      const [entry, again, sibling] = await graph.drain(
        Promise.all([first, duplicate, other]),
      );
      expect(entry).toBe(again);
      expect(entry!.sum).toBe(42);
      expect(sibling!.value).toBe(21);
      expect(entry!.readCycle()).toBe(4);
      expect(graph.requested()).not.toContain('lazy.js');
      const [lazy, sameLazy] = await graph.drain(
        Promise.all([entry!.lazy(), entry!.lazy()]),
      );
      expect(lazy).toBe(sameLazy);
      entry!.bump();
      expect(entry!.count).toBe(2);
      expect(lazy.count).toBe(2);
      expect(lazy.readCycle()).toBe(6);
      expect(new Set(graph.requested()).size).toBe(graph.requested().length);
      expect(new Set(executions).size).toBe(executions.length);
      expect(executions).toHaveLength(8);
      const cached = graph.runtime.importByUrl(moduleUrl('entry.js'));
      expect(cached).toBeInstanceOf(Promise);
      expect(await cached).toBe(entry);
      expect(graph.load).toHaveBeenCalledTimes(8);
    });

    it.each(['url', 'inline'] as const)(
      'blocks failed importers, retains independent resources, and allows a later %s import retry',
      async (entryKind) => {
        const graph = await createGraph(
          {
            'entry.js':
              "import { value as left } from './left.js'; import { value as right } from './right.js'; import { safe } from './good.js'; export const value = left + right + safe;",
            'left.js': "export { value } from './broken.js';",
            'right.js': "export { value } from './broken.js';",
            'broken.js': 'export const value = 20;',
            'good.js': 'export const safe = 2;',
          },
          { dependencyScheduling },
        );
        const start = () =>
          entryKind === 'inline'
            ? graph.runtime.importByCode(
                graph.artifacts.get('entry.js')!,
                moduleUrl('entry.js'),
              )
            : graph.runtime.importByUrl(moduleUrl('entry.js'));
        const failure = new Error('temporary loader failure');
        const first = start().catch((error) => error);
        if (entryKind === 'url') graph.complete('entry.js');
        await nextTurn();
        graph.complete('left.js');
        if (dependencyScheduling === 'streaming') {
          await nextTurn();
          graph.complete('broken.js', failure);
          await nextTurn();
        }
        graph.complete('right.js');
        graph.complete('good.js');
        await nextTurn();
        if (dependencyScheduling === 'batch')
          graph.complete('broken.js', failure);
        expect(await first).toBe(failure);
        expect(Object.keys(graph.runtime.resources)).toEqual([
          moduleUrl('good.js'),
        ]);
        expect(
          graph.requested().filter((id) => id === 'broken.js'),
        ).toHaveLength(1);
        expect((await graph.drain(start()))!.value).toBe(42);
        expect(
          graph.requested().filter((id) => id === 'broken.js'),
        ).toHaveLength(2);
        expect(graph.requested().filter((id) => id === 'good.js')).toHaveLength(
          1,
        );
        // This verifies Runtime retry with a retry-capable Loader stub, not a
        // network retry guarantee for Garfish Loader's rejected-promise cache.
      },
    );

    it('selects same-depth failures by declaration order, not completion order', async () => {
      const graph = await createGraph(
        {
          'entry.js': "import './first.js'; import './second.js';",
          'first.js': '',
          'second.js': '',
        },
        { dependencyScheduling },
      );
      const firstError = new Error('first import failed');
      const secondError = new Error('second import failed sooner');
      let settled = false;
      const result = graph.runtime
        .importByUrl(moduleUrl('entry.js'))
        .catch((error) => {
          settled = true;
          return error;
        });
      graph.complete('entry.js');
      await nextTurn();
      graph.complete('second.js', secondError);
      await nextTurn();
      expect(settled).toBe(false);
      graph.complete('first.js', firstError);
      expect(await result).toBe(firstError);
      expect(graph.runtime.resources).toEqual({});
    });

    it('selects shallower failures before earlier-discovered descendant failures', async () => {
      const graph = await createGraph(
        {
          'entry.js': "import './branch.js'; import './shallow.js';",
          'branch.js': "import './deep.js';",
          'deep.js': '',
          'shallow.js': '',
        },
        { dependencyScheduling },
      );
      const shallowError = new Error('shallow');
      const result = graph.runtime
        .importByUrl(moduleUrl('entry.js'))
        .catch((error) => error);
      graph.complete('entry.js');
      await nextTurn();
      graph.complete('branch.js');
      if (dependencyScheduling === 'streaming') {
        await nextTurn();
        graph.complete('deep.js', new Error('deep'));
        await nextTurn();
      }
      graph.complete('shallow.js', shallowError);
      await nextTurn();
      if (dependencyScheduling === 'batch')
        graph.complete('deep.js', new Error('deep'));
      expect(await result).toBe(shallowError);
    });

    it('drains a wide graph through 24 request slots, including after a rejection', async () => {
      const events: RuntimeLoadEvent[] = [];
      const children = Array.from({ length: 30 }, (_, i) => `child-${i}.js`);
      const graph = await createGraph(
        {
          'entry.js': children.map((id) => `import './${id}';`).join('\n'),
          ...Object.fromEntries(
            children.map((id) => [id, 'export const ok = true;']),
          ),
        },
        {
          dependencyScheduling,
          loadObserver: (event) => {
            events.push(event);
          },
        },
      );
      const failure = new Error('one child failed');
      const result = graph.runtime
        .importByUrl(moduleUrl('entry.js'))
        .catch((error) => error);
      graph.complete('entry.js');
      await nextTurn();
      expect(graph.pending.size).toBe(24);
      expect(graph.requested()).toHaveLength(25);
      graph.complete(children[0], failure);
      await nextTurn();
      expect(graph.pending.has(children[24])).toBe(true);
      expect(graph.pending.size).toBe(24);
      expect(await graph.drain(result)).toBe(failure);
      expect(graph.requested()).toHaveLength(31);
      expect(graph.pending.size).toBe(0);
      expect(Object.keys(graph.runtime.resources)).toHaveLength(29);
      expect(Math.max(...events.map((event) => event.activeLoads || 0))).toBe(
        24,
      );
      expect(
        (await graph.drain(graph.runtime.importByUrl(moduleUrl(children[0]))))!
          .ok,
      ).toBe(true);
    });

    it('propagates import-map resolution failure while preserving a healthy branch', async () => {
      const graph = await createGraph(
        {
          'entry.js': "import './bad.js'; import './good.js';",
          'bad.js': "import 'unmapped-package';",
          'good.js': 'export const ok = 1;',
        },
        { dependencyScheduling },
      );
      await expect(
        graph.drain(graph.runtime.importByUrl(moduleUrl('entry.js'))),
      ).rejects.toThrow('unmapped-package');
      expect(Object.keys(graph.runtime.resources)).toEqual([
        moduleUrl('good.js'),
      ]);
    });

    it('returns Promise rejections for cached execution failures and dynamic external failures', async () => {
      const graph = await createGraph(
        {
          'entry.js':
            "import './cached.js'; export const lazy = () => import('missing-external');",
          'cached.js': 'export const ok = true;',
          'failed-parent.js': "import './throws.js'; import './missing.js';",
          'missing.js': '',
          'throws.js': "throw new Error('execution failed');",
        },
        { dependencyScheduling, garfishExternalMatcher: ['missing-external'] },
      );
      const entry = await graph.drain(
        graph.runtime.importByUrl(moduleUrl('entry.js')),
      );
      const dynamic = entry!.lazy();
      expect(dynamic).toBeInstanceOf(Promise);
      await expect(dynamic).rejects.toThrow(
        "External module 'missing-external'",
      );
      // A failed parent leaves this successful resource cached but unevaluated.
      const failedParent = graph.runtime
        .importByUrl(moduleUrl('failed-parent.js'))
        .catch((error) => error);
      graph.complete('failed-parent.js');
      await nextTurn();
      graph.complete('throws.js');
      graph.complete('missing.js', new Error('missing sibling'));
      await failedParent;
      expect(graph.runtime.resources[moduleUrl('throws.js')]).toBeDefined();
      let imported: ReturnType<typeof graph.runtime.importByUrl> | undefined;
      expect(() => {
        imported = graph.runtime.importByUrl(moduleUrl('throws.js'));
      }).not.toThrow();
      await expect(imported).rejects.toThrow('execution failed');
      expect(graph.runtime.resources[moduleUrl('throws.js')]).toBeUndefined();
    });
  },
);
