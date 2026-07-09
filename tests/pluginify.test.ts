import { describe, expect, it, vi } from 'vitest';
import { GarfishEsModule } from '../src/pluginify';
import { getWasmBytes } from './wasm';

function createSandbox() {
  return {
    hooks: {
      lifecycle: {
        beforeInvoke: { emit: vi.fn() },
        afterInvoke: { emit: vi.fn() },
      },
    },
    createExecParams: vi.fn(() => ({})),
    execScript: vi.fn(),
    processExecError: vi.fn(),
  };
}

function createApp(overrides: Record<string, unknown> = {}) {
  const sandbox = createSandbox();
  const tasks: Array<(next: () => void) => void | Promise<void>> = [];
  const queue = {
    add: vi.fn((task) => {
      tasks.push(task);
    }),
    awaitCompletion: vi.fn(() => Promise.resolve()),
  };
  const app = {
    appId: 1,
    name: 'subapp',
    entryManager: {
      url: 'https://example.test/subapp.html',
      findAllJsNodes: vi.fn(() => []),
      findAttributeValue: vi.fn(),
    },
    esmQueue: queue,
    getExecScriptEnv: vi.fn(() => ({ fromApp: true })),
    runCode: vi.fn(),
    vmSandbox: sandbox,
    ...overrides,
  };

  return { app, queue, sandbox, tasks };
}

function runQueuedTask(task: (next: () => void) => void | Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    try {
      const result = task(resolve);
      if (result && typeof result.then === 'function') {
        result.then(resolve, reject);
      }
    } catch (error) {
      reject(error);
    }
  });
}

describe('GarfishEsModule plugin', () => {
  it('skips excluded apps without replacing runCode', () => {
    const plugin = GarfishEsModule({ excludes: ['subapp'] })({
      externals: {},
      loader: {},
    } as any);
    const { app } = createApp();
    const originalRunCode = app.runCode;

    plugin.afterLoad?.({ name: 'subapp', entry: 'https://example.test' } as any, app as any);

    expect(app.runCode).toBe(originalRunCode);
  });

  it('patches module execution and delegates classic scripts to the sandbox', () => {
    const plugin = GarfishEsModule()({
      externals: { react: { default: {} } },
      loader: {},
    } as any);
    const { app, sandbox, tasks } = createApp();
    const env: Record<string, unknown> = {};

    plugin.afterLoad?.({ name: 'subapp', entry: 'https://example.test' } as any, app as any);

    expect(app.runCode).not.toBeTypeOf('undefined');
    app.runCode('window.answer = 42;', env, 'https://example.test/classic.js', {
      isModule: false,
    });

    expect(env.fromApp).toBe(true);
    expect(sandbox.execScript).toHaveBeenCalledWith(
      'window.answer = 42;',
      env,
      'https://example.test/classic.js',
      { isModule: false },
    );

    app.runCode('export const answer = 42;', env, 'https://example.test/module.js', {
      isInline: true,
      isModule: true,
    });

    expect(tasks).toHaveLength(1);
  });

  it('propagates async queue errors through awaitCompletion', async () => {
    const plugin = GarfishEsModule()({
      externals: {},
      loader: {},
    } as any);
    const error = new Error('module failed');
    const queue = {
      add: vi.fn((task) => {
        task(() => undefined);
      }),
      awaitCompletion: vi.fn(() => Promise.resolve()),
    };
    const { app } = createApp({ esmQueue: queue });

    plugin.afterLoad?.({ name: 'subapp', entry: 'https://example.test' } as any, app as any);

    app.esmQueue.add(async () => {
      throw error;
    });

    await expect(app.esmQueue.awaitCompletion()).rejects.toBe(error);
  });

  it('throws for malformed HTML import maps', () => {
    const plugin = GarfishEsModule()({
      externals: {},
      loader: {},
    } as any);
    const { app } = createApp({
      entryManager: {
        url: 'https://example.test/subapp.html',
        findAllJsNodes: vi.fn(() => [
          {
            children: [{ content: '{broken json}' }],
          },
        ]),
        findAttributeValue: vi.fn(() => 'importmap'),
      },
    });

    expect(() =>
      plugin.afterLoad?.({ name: 'subapp', entry: 'https://example.test' } as any, app as any),
    ).toThrow('[subapp] Invalid importmap in https://example.test/subapp.html');
  });

  it('keeps queued module scripts bound to their own execution context', async () => {
    const plugin = GarfishEsModule({ wasm: getWasmBytes() })({
      externals: {},
      loader: {},
    } as any);
    const sandbox = createSandbox();
    sandbox.createExecParams.mockImplementation(
      (_codeRef: unknown, env: Record<string, unknown>) => env,
    );
    const { app, tasks } = createApp({ vmSandbox: sandbox });
    const firstEnv: Record<string, unknown> = {};
    const secondEnv: Record<string, unknown> = {};

    plugin.afterLoad?.({ name: 'subapp', entry: 'https://example.test' } as any, app as any);

    app.runCode('export const first = 1;', firstEnv, 'https://example.test/first.js', {
      isInline: true,
      isModule: true,
    });
    app.runCode('export const second = 2;', secondEnv, 'https://example.test/second.js', {
      isInline: true,
      isModule: true,
    });

    expect(tasks).toHaveLength(2);

    await runQueuedTask(tasks[0]);
    await runQueuedTask(tasks[1]);

    expect(sandbox.hooks.lifecycle.beforeInvoke.emit.mock.calls[0][1]).toBe(
      'https://example.test/first.js',
    );
    expect(sandbox.hooks.lifecycle.beforeInvoke.emit.mock.calls[1][1]).toBe(
      'https://example.test/second.js',
    );
    expect(sandbox.createExecParams.mock.calls[0][1]).toBe(firstEnv);
    expect(sandbox.createExecParams.mock.calls[1][1]).toBe(secondEnv);
  });
});
