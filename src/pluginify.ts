import { evalWithEnv, warn } from '@garfish/utils';
import type { Text } from '@garfish/utils';
import type { interfaces } from '@garfish/core';
import { Runtime } from './runtime';
import type {
  RuntimeExecCode,
  RuntimeCompileCache,
  RuntimeExternalMatcher,
  RuntimeImportMap,
  RuntimeMetricsReporter,
} from './runtime';
import type { WasmInitInput } from './wasm';
import {
  GARFISH_ES_MODULE_PRELOADS_SYMBOL,
  type GarfishEsModulePreloadDescriptor,
} from './preloads';

export interface Options {
  excludes?: Array<string> | ((name: string) => boolean);
  compileCache?: boolean | RuntimeCompileCache;
  runtimeCompile?: boolean;
  metrics?: RuntimeMetricsReporter;
  garfishExternals?: RuntimeExternalMatcher;
  wasm?: WasmInitInput;
}

type QueueTask = (next: () => void) => void | Promise<void>;

interface QueueLike {
  add(task: QueueTask): void;
  awaitCompletion?: () => Promise<void>;
  [key: string]: unknown;
}

const QUEUE_PATCHED_KEY = '__garfishEsModuleYukuWasmPromiseAware';

const now = () =>
  typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();

const isPromiseLike = (value: unknown): value is Promise<unknown> => {
  return Boolean(value && typeof (value as Promise<unknown>).then === 'function');
};

const isImportMapType = (type?: string) =>
  type?.trim().toLowerCase() === 'importmap';

const getImportMaps = (
  appInfo: interfaces.AppInfo,
  appInstance: interfaces.App,
) => {
  const entryManager = appInstance.entryManager;
  const importMaps: Array<RuntimeImportMap> = [];
  const importMapUrl = entryManager?.url || appInfo.entry || location.href;
  const jsNodes = entryManager?.findAllJsNodes?.() || [];

  jsNodes.forEach((node) => {
    if (!isImportMapType(entryManager.findAttributeValue(node, 'type'))) {
      return;
    }

    const content = ((node.children?.[0] as Text)?.content || '').trim();
    if (!content) return;

    try {
      importMaps.push(JSON.parse(content) as RuntimeImportMap);
    } catch (e) {
      throw new Error(
        `[${appInfo.name}] Invalid importmap in ${importMapUrl}: ${
          (e as Error).message
        }`,
      );
    }
  });

  return { importMaps, importMapUrl };
};

type PreloadEntryManager = interfaces.TemplateManager & {
  [GARFISH_ES_MODULE_PRELOADS_SYMBOL]?: GarfishEsModulePreloadDescriptor[];
};

const startPreloads = (
  appInfo: interfaces.AppInfo,
  appInstance: interfaces.App,
  runtime: Runtime,
) => {
  const entryManager = appInstance.entryManager as PreloadEntryManager;
  const preloads = entryManager[GARFISH_ES_MODULE_PRELOADS_SYMBOL];
  if (!Array.isArray(preloads) || preloads.length === 0) return;

  const pageUrl = location.href;
  let entryUrl: URL;

  try {
    entryUrl = new URL(entryManager.url || appInfo.entry || pageUrl, pageUrl);
  } catch (error) {
    warn(
      `[${appInfo.name}] Failed to resolve ESM preload base URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  preloads.forEach((preload) => {
    let resolvedUrl: string | undefined;

    try {
      resolvedUrl = new URL(preload.href, entryUrl).href;
      let task: Promise<void>;

      switch (preload.rel) {
        case 'modulepreload':
          task = runtime.preloadByUrl(
            resolvedUrl,
            resolvedUrl,
            preload.crossOrigin,
          );
          break;
        case 'preload':
        case 'prefetch':
          task = runtime.preloadScript(resolvedUrl, preload.crossOrigin);
          break;
        default:
          warn(`[${appInfo.name}] Unsupported ESM preload rel.`);
          return;
      }

      void task.catch((error) => {
        warn(
          `[${appInfo.name}] Failed to ${preload.rel} "${resolvedUrl}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    } catch (error) {
      warn(
        `[${appInfo.name}] Failed to ${preload.rel} "${
          resolvedUrl || preload.href
        }": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
};

const patchPromiseAwareQueue = (queue?: QueueLike) => {
  if (!queue || queue[QUEUE_PATCHED_KEY]) return;

  const originalAdd = queue.add.bind(queue);
  const originalAwaitCompletion = queue.awaitCompletion?.bind(queue);
  let queueError: unknown;

  queue.add = (task: QueueTask) => {
    originalAdd((next) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        next();
      };

      try {
        const result = task(release);
        if (isPromiseLike(result)) {
          result
            .catch((error) => {
              queueError = error;
            })
            .finally(release);
        }
      } catch (error) {
        queueError = error;
        release();
      }
    });
  };

  if (originalAwaitCompletion) {
    queue.awaitCompletion = async () => {
      await originalAwaitCompletion();
      if (queueError) {
        const error = queueError;
        queueError = undefined;
        throw error;
      }
    };
  }

  queue[QUEUE_PATCHED_KEY] = true;
};

export function GarfishEsModule(options: Options = {}) {
  return function (Garfish: interfaces.Garfish): interfaces.Plugin {
    const appModules: Record<number, Runtime | null> = {};
    const { excludes } = options;

    const disable = (
      appId: number,
      appName: string,
      appInfo: interfaces.AppInfo,
    ) => {
      if (appModules[appId]) return true;
      if (Array.isArray(excludes)) return excludes.includes(appName);
      if (typeof excludes === 'function') return excludes(appName);
      if (appInfo.sandbox === false || appInfo?.sandbox?.open === false) {
        return true;
      }
      return false;
    };

    return {
      name: 'es-module-yuku-zig-wasm',

      afterLoad(appInfo, appInstance) {
        if (!appInstance) return;
        const { appId, name } = appInstance;
        if (!disable(appId, name, appInfo)) {
          // @ts-expect-error vmSandbox is an internal Garfish runtime field.
          const sandbox = appInstance.vmSandbox;
          patchPromiseAwareQueue(appInstance.esmQueue as unknown as QueueLike);
          const runtime = new Runtime({
            scope: name,
            compileCache: options.compileCache,
            runtimeCompile: options.runtimeCompile,
            metrics: options.metrics,
            wasm: options.wasm,
            garfishExternals: Garfish.externals,
            garfishExternalMatcher: options.garfishExternals,
            ...getImportMaps(appInfo, appInstance),
          });

          appModules[appId] = runtime;
          runtime.loader = Garfish.loader;

          appInstance.runCode = function (
            code: string,
            env: Record<string, any>,
            url?: string,
            execOptions?: interfaces.ExecScriptOptions,
          ) {
            const appEnv = appInstance.getExecScriptEnv(execOptions?.noEntry);
            Object.assign(env, appEnv);

            if (execOptions?.isModule) {
              const codeRef = { code };

              const execCode: RuntimeExecCode = (output, provider) => {
                Object.assign(env, provider);
                codeRef.code = `(() => {'use strict';\n${output.code}\n})()`;

                sandbox?.hooks.lifecycle.beforeInvoke.emit(
                  codeRef,
                  url,
                  env,
                  execOptions,
                );

                const evalStart = now();
                let execError: unknown;
                try {
                  const params = sandbox?.createExecParams(codeRef, env);
                  const evalCode = `${codeRef.code}\n//${output.storeId}`;
                  evalWithEnv(evalCode, params || {}, undefined, false);
                } catch (e) {
                  execError = e;
                  sandbox?.processExecError(e, url, env, execOptions);
                } finally {
                  runtime.options.metrics?.({
                    storeId: output.storeId,
                    realUrl: output.realUrl,
                    codeBytes: output.code.length,
                    cacheHit: false,
                    evalMs: now() - evalStart,
                  });
                }

                sandbox?.hooks.lifecycle.afterInvoke.emit(
                  codeRef,
                  url,
                  env,
                  execOptions,
                );

                if (execError) {
                  throw execError;
                }
              };

              if (url) {
                appInstance.esmQueue.add(async () => {
                  execOptions.isInline
                    ? await runtime.importByCode(codeRef.code, url, url, execCode)
                    : await runtime.importByUrl(url, url, execCode);
                });
              }
            } else {
              sandbox?.execScript(code, env, url, execOptions);
            }
          };

          startPreloads(appInfo, appInstance, runtime);
        }
      },

      afterUnmount(_appInfo, appInstance, isCacheMode) {
        if (!isCacheMode && appInstance) {
          appModules[appInstance.appId] = null;
        }
      },
    };
  };
}
