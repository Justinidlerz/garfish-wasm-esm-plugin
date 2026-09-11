import { describe, expect, it, vi } from 'vitest';
import {
  Runtime,
  type RuntimeLoadEvent,
  type RuntimeLoadObserver,
} from '../src/runtime';
import { createGraph, moduleUrl } from './runtime-graph';

const failingObservers: Array<[string, () => unknown]> = [
  [
    'throws synchronously',
    () => {
      throw new Error('observer');
    },
  ],
  ['returns a rejected Promise', () => Promise.reject(new Error('observer'))],
  [
    'returns a rejecting thenable',
    () => ({
      then(_resolve: unknown, reject: (error: Error) => void) {
        reject(new Error('observer'));
      },
    }),
  ],
  [
    'has a throwing then getter',
    () => ({
      get then(): never {
        throw new Error('observer');
      },
    }),
  ],
  ['never settles', () => new Promise(() => undefined)],
];

describe('load diagnostics', () => {
  it('reports ordered load and graph events with distinct graph ids and published resources', async () => {
    const events: RuntimeLoadEvent[] = [];
    const publishedAtReady: boolean[] = [];
    const graph = await createGraph(
      {
        'entry.js':
          "import './dep.js'; export const lazy = () => import('./lazy.js');",
        'dep.js': 'export const ok = true;',
        'lazy.js': 'export const answer = 42;',
      },
      {
        dependencyScheduling: 'streaming',
        loadObserver(event) {
          events.push(event);
          if (event.type === 'graph-ready') {
            publishedAtReady.push(
              Boolean(graph.runtime.resources[event.storeId]),
            );
          }
        },
      },
    );
    const entry = await graph.drain(
      graph.runtime.importByUrl(moduleUrl('entry.js')),
    );
    expect((await graph.drain<{ answer: number }>(entry!.lazy())).answer).toBe(
      42,
    );
    expect(publishedAtReady).toEqual([true, true]);
    for (const name of ['entry.js', 'dep.js', 'lazy.js']) {
      const own = events.filter((event) => event.storeId === moduleUrl(name));
      expect(
        own
          .filter((event) => event.type.startsWith('load-'))
          .map((event) => event.type),
      ).toEqual(['load-queued', 'load-start', 'load-end']);
      const ready = own.find((event) => event.type === 'module-ready')!;
      const expanded = own.find((event) => event.type === 'dependency-expand')!;
      expect(expanded.timestamp).toBeGreaterThanOrEqual(ready.timestamp);
      expect(expanded.readyAt).toBeLessThanOrEqual(expanded.timestamp);
      expect(own.map((event) => event.timestamp)).toEqual(
        own.map((event) => event.timestamp).sort((a, b) => a - b),
      );
    }
    const starts = events.filter((event) => event.type === 'graph-start');
    const ends = events.filter((event) => event.type === 'graph-ready');
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((event) => event.graphId)).size).toBe(2);
    expect(ends.map((event) => event.graphId)).toEqual(
      starts.map((event) => event.graphId),
    );
    expect(events.some((event) => event.type === 'graph-error')).toBe(false);
  });

  it('reports one graph-error and no graph-ready when loading fails', async () => {
    const events: RuntimeLoadEvent[] = [];
    const graph = await createGraph(
      { 'entry.js': 'export const ok = true;' },
      {
        dependencyScheduling: 'streaming',
        loadObserver: (event) => {
          events.push(event);
        },
      },
    );
    const failure = new Error('load failed');
    const result = graph.runtime
      .importByUrl(moduleUrl('entry.js'))
      .catch((error) => error);
    graph.complete('entry.js', failure);
    expect(await result).toBe(failure);
    expect(events.filter((event) => event.type === 'load-end')).toHaveLength(1);
    expect(
      events
        .filter((event) => event.type.startsWith('graph-'))
        .map((event) => event.type),
    ).toEqual(['graph-start', 'graph-error']);
    const terminal = events.at(-1)!;
    expect(terminal.graphId).toBe(
      events.find((event) => event.type === 'graph-start')!.graphId,
    );
  });

  it.each(failingObservers)(
    'does not change graph completion when the observer %s',
    async (_label, callback) => {
      const observer = vi.fn(callback) as RuntimeLoadObserver;
      const graph = await createGraph(
        { 'entry.js': 'export const answer = 42;' },
        {
          dependencyScheduling: 'streaming',
          loadObserver: observer,
        },
      );
      expect(
        (await graph.drain(graph.runtime.importByUrl(moduleUrl('entry.js'))))!
          .answer,
      ).toBe(42);
      expect(observer).toHaveBeenCalled();
      // Vitest also fails this test file if a rejected diagnostic escapes as an
      // unhandled rejection after the import finishes.
    },
  );

  it('uses module identity in diagnostics when request URLs are different', async () => {
    const events: RuntimeLoadEvent[] = [];
    const graph = await createGraph(
      {
        'entry.js': "export { url } from './dep.js';",
        'dep.js': 'export const url = import.meta.url;',
      },
      {
        dependencyScheduling: 'streaming',
        loadObserver: (event) => {
          events.push(event);
        },
      },
    );
    const storeId = 'https://registry.test/alias.js';
    const entry = await graph.drain(
      graph.runtime.importByUrl(storeId, moduleUrl('entry.js')),
    );
    expect(entry!.url).toBe(moduleUrl('dep.js'));
    expect(graph.load.mock.calls.map(([{ url }]) => url)).toEqual(
      ['entry.js', 'dep.js'].map(moduleUrl),
    );
    expect(new Set(events.map((event) => event.storeId))).toEqual(
      new Set([storeId, 'https://registry.test/dep.js']),
    );
  });

  it('preserves callback and other opaque option identities', () => {
    const loadObserver = vi.fn();
    const wasm = new Uint8Array([1, 2]);
    const compileCache = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
    const externals = { shared: { value: 1 } };
    const runtime = new Runtime({
      scope: 'test',
      loadObserver,
      wasm,
      compileCache,
      garfishExternals: externals,
    });
    expect(runtime.options.loadObserver).toBe(loadObserver);
    expect(runtime.options.wasm).toBe(wasm);
    expect(runtime.options.compileCache).toBe(compileCache);
    expect(runtime.options.garfishExternals).toBe(externals);
  });
});
