import {
  assert,
  deepMerge,
  evalWithEnv,
  isPlainObject,
  transformUrl,
  warn,
} from '@garfish/utils';
import {
  CacheValue,
  JavaScriptManager,
  Loader,
  LoaderOptions,
} from '@garfish/loader';
import { ImportMap } from '@jspm/import-map';
import {
  type WasmInitInput,
} from './wasm';
import {
  readCompiledModuleArtifact,
  type ModuleImportInfo,
} from './compiled-module';
import { createImportMeta, createModule, MemoryModule, Module } from './module';
import type { GarfishEsModulePreloadCrossOrigin } from './preloads';

const PACKAGE_VERSION = '__PACKAGE_VERSION__';
const TRANSFORMER_VERSION = `garfish-wasm-esm-plugin@${PACKAGE_VERSION}:yuku-zig-wasm`;
const MAX_CONCURRENT_LOADS = 24;

const GARFISH_IMPORT = '__GARFISH_IMPORT__';
const GARFISH_EXPORT = '__GARFISH_EXPORT__';
const GARFISH_NAMESPACE = '__GARFISH_NAMESPACE__';
const GARFISH_IMPORT_META = '__GARFISH_IMPORT_META__';
const GARFISH_DYNAMIC_IMPORT = '__GARFISH_DYNAMIC_IMPORT__';
const GARFISH_DEFAULT_IMPORT = '__GARFISH_DEFAULT_IMPORT__';
const GARFISH_EXPORT_STAR = '__GARFISH_EXPORT_STAR__';

const hasOwn = (target: object, key: string) =>
  Object.prototype.hasOwnProperty.call(target, key);

const now = () =>
  typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now();

const getCodeBytes = (code: string) => {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(code).length;
  }
  return code.length;
};

const hashText = (text: string) => {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const isRelativeModuleId = (moduleId: string) =>
  moduleId.startsWith('./') ||
  moduleId.startsWith('../') ||
  (moduleId.startsWith('/') && !moduleId.startsWith('//'));

const isExternalPrefixMatch = (moduleId: string, externalKey: string) => {
  return externalKey.endsWith('/') && moduleId.startsWith(externalKey);
};

const isObjectLike = (value: unknown): value is MemoryModule =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

const toMemoryModule = (value: unknown): MemoryModule => {
  if (isObjectLike(value)) return value as MemoryModule;
  return { default: value };
};

const preserveOpaqueOption = <Key extends keyof RuntimeOptions>(
  target: RuntimeOptions,
  source: RuntimeOptions,
  key: Key,
) => {
  if (source[key] !== undefined) {
    Object.assign(target, { [key]: source[key] });
  }
};

export interface RuntimeCompileMetric {
  storeId: string;
  realUrl: string;
  codeBytes: number;
  cacheHit: boolean;
  fetchMs?: number;
  dependencyMs?: number;
  transformMs?: number;
  evalMs?: number;
  totalMs?: number;
}

export type RuntimeMetricsReporter = (metric: RuntimeCompileMetric) => void;

export interface RuntimeCompileCache {
  get(key: string): ModuleResource | Promise<ModuleResource> | undefined;
  set(key: string, value: ModuleResource | Promise<ModuleResource>): void;
  delete(key: string): void;
  clear?(): void;
}

export interface ModuleResource {
  code: string;
  imports?: ModuleImportInfo[];
  storeId: string;
  realUrl: string;
  exports: string[];
}

interface CompiledModuleResource extends ModuleResource {
  imports: ModuleImportInfo[];
}

const hasImportMetadata = (
  output: ModuleResource,
): output is CompiledModuleResource => Array.isArray(output.imports);

export type RuntimeExecCode = (
  output: ModuleResource,
  provider: Record<string, unknown>,
) => void;

interface ModuleLoadRecord {
  storeId: string;
  requestUrl: string;
  crossOrigin?: GarfishEsModulePreloadCrossOrigin;
  promise?: Promise<CompiledModuleResource>;
  resource?: CompiledModuleResource;
}

export interface RuntimeImportMap {
  imports?: Record<string, string>;
  scopes?: Record<string, Record<string, string>>;
  integrity?: Record<string, string>;
}

export type RuntimeExternalMatcher =
  | Array<string>
  | Set<string>
  | ((moduleId: string) => boolean);

export interface RuntimeOptions {
  scope: string;
  loaderOptions?: LoaderOptions;
  compileCache?: boolean | RuntimeCompileCache;
  runtimeCompile?: boolean;
  metrics?: RuntimeMetricsReporter;
  importMaps?: Array<RuntimeImportMap>;
  importMapUrl?: string | URL;
  wasm?: WasmInitInput;
  garfishExternals?: Record<string, unknown>;
  garfishExternalMatcher?: RuntimeExternalMatcher;
  execCode?: RuntimeExecCode;
}

class MapRuntimeCompileCache implements RuntimeCompileCache {
  private values = new Map<string, ModuleResource | Promise<ModuleResource>>();

  constructor(private readonly maxEntries = 500) {}

  get(key: string) {
    const value = this.values.get(key);
    if (value) {
      this.values.delete(key);
      this.values.set(key, value);
    }
    return value;
  }

  set(key: string, value: ModuleResource | Promise<ModuleResource>) {
    if (!this.values.has(key) && this.values.size >= this.maxEntries) {
      const firstKey = this.values.keys().next().value;
      if (firstKey) this.values.delete(firstKey);
    }
    this.values.set(key, value);
  }

  delete(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

const defaultRuntimeCompileCache = new MapRuntimeCompileCache();

export const clearRuntimeCompileCache = () => {
  defaultRuntimeCompileCache.clear();
};

export class Runtime {
  private modules = new WeakMap<MemoryModule, Module>();
  private importMap?: ImportMap;
  private memoryModules: Record<string, MemoryModule> = {};
  private codeImportRegistry: Record<string, Promise<MemoryModule>> = {};
  private loadRegistry: Record<string, ModuleLoadRecord> = {};
  private activeLoads = 0;
  private loadQueue: Array<() => void> = [];
  public loader: Loader;
  public options: RuntimeOptions;
  public resources: Record<string, ModuleResource> = {};

  constructor(options?: RuntimeOptions) {
    const defaultOptions = {
      scope: 'default',
      loaderOptions: {},
      compileCache: true,
      runtimeCompile: true,
    };
    this.options = isPlainObject(options)
      ? deepMerge(defaultOptions, options)
      : defaultOptions;
    if (isPlainObject(options)) {
      preserveOpaqueOption(this.options, options, 'compileCache');
      preserveOpaqueOption(this.options, options, 'runtimeCompile');
      preserveOpaqueOption(this.options, options, 'execCode');
      preserveOpaqueOption(this.options, options, 'garfishExternalMatcher');
      preserveOpaqueOption(this.options, options, 'garfishExternals');
      preserveOpaqueOption(this.options, options, 'importMaps');
      preserveOpaqueOption(this.options, options, 'importMapUrl');
      preserveOpaqueOption(this.options, options, 'metrics');
      preserveOpaqueOption(this.options, options, 'wasm');
    }
    this.loader = new Loader(this.options.loaderOptions);
  }

  private getImportMapUrl() {
    return this.options.importMapUrl || location.href;
  }

  private ensureImportMap() {
    if (this.importMap) return;
    const importMap = new ImportMap({
      map: {},
      mapUrl: this.getImportMapUrl(),
    });
    this.options.importMaps?.forEach((map) => importMap.extend(map));
    this.importMap = importMap;
  }

  private ensureImportMapForModule(moduleId: string) {
    if (!isRelativeModuleId(moduleId) && !this.isExternalModule(moduleId)) {
      this.ensureImportMap();
    }
  }

  public resolveModuleUrl(baseUrl: string, moduleId: string) {
    if (isRelativeModuleId(moduleId)) {
      return transformUrl(baseUrl, moduleId);
    }
    this.ensureImportMap();
    return this.importMap!.resolve(moduleId, baseUrl);
  }

  private getCompileCache() {
    if (this.options.compileCache === false) return;
    if (this.options.compileCache && this.options.compileCache !== true) {
      return this.options.compileCache;
    }
    return defaultRuntimeCompileCache;
  }

  private getCompileCacheKey(code: string, storeId: string, realUrl: string) {
    return [TRANSFORMER_VERSION, realUrl, storeId, hashText(code)].join('\n');
  }

  private execCode(
    output: ModuleResource,
    memoryModule: MemoryModule,
    execCode?: RuntimeExecCode,
  ) {
    const provider = this.generateProvider(output, memoryModule, execCode);
    const executor = execCode || this.options.execCode;

    if (executor) {
      executor(output, provider);
    } else {
      const evalStart = now();
      evalWithEnv(`\n${output.code}\n//${output.storeId}\n`, provider, undefined, true);
      this.options.metrics?.({
        storeId: output.storeId,
        realUrl: output.realUrl,
        codeBytes: output.code.length,
        cacheHit: false,
        evalMs: now() - evalStart,
      });
    }
  }

  private importModule(
    storeId: string,
    requestUrl?: string,
    execCode?: RuntimeExecCode,
  ): MemoryModule | Promise<MemoryModule> {
    let memoryModule = this.memoryModules[storeId];
    if (!memoryModule) {
      const get = () => {
        memoryModule = this.memoryModules[storeId];
        if (memoryModule) return memoryModule;

        const output = this.resources[storeId];
        if (!output) {
          throw new Error(`Module '${storeId}' not found`);
        }
        memoryModule = this.memoryModules[storeId] = {};
        try {
          this.execCode(output, memoryModule, execCode);
        } catch (error) {
          delete this.memoryModules[storeId];
          delete this.resources[storeId];
          delete this.loadRegistry[storeId];
          throw error;
        }
        return memoryModule;
      };
      if (requestUrl) {
        const res = this.compileAndFetchCode(storeId, requestUrl);
        if (res) return res.then(() => get());
      }
      return get();
    }
    return memoryModule;
  }

  private getModule(memoryModule: MemoryModule) {
    if (!this.modules.has(memoryModule)) {
      this.modules.set(memoryModule, createModule(memoryModule));
    }
    return this.modules.get(memoryModule);
  }

  private generateProvider(
    output: ModuleResource,
    memoryModule: MemoryModule,
    execCode?: RuntimeExecCode,
  ) {
    return {
      [GARFISH_IMPORT_META]: createImportMeta(output.realUrl),

      [GARFISH_NAMESPACE]: (memoryModule: MemoryModule) => {
        return this.getModule(memoryModule);
      },

      [GARFISH_DEFAULT_IMPORT]: (memoryModule: MemoryModule) => {
        const module = this.getModule(memoryModule)!;
        return 'default' in module ? module.default : module;
      },

      [GARFISH_IMPORT]: (moduleId: string) => {
        if (this.isExternalModule(moduleId)) {
          return this.getExternalModule(moduleId);
        }
        const storeId = this.resolveModuleUrl(output.storeId, moduleId);
        return this.importModule(storeId, undefined, execCode);
      },

      [GARFISH_DYNAMIC_IMPORT]: (moduleId: string) => {
        if (this.isExternalModule(moduleId)) {
          return Promise.resolve(this.getModule(this.getExternalModule(moduleId)));
        }
        this.ensureImportMapForModule(moduleId);
        const storeId = this.resolveModuleUrl(output.storeId, moduleId);
        const requestUrl = this.resolveModuleUrl(output.realUrl, moduleId);
        return this.importByUrl(storeId, requestUrl, execCode);
      },

      [GARFISH_EXPORT]: (exportObject: Record<string, () => any>) => {
        Object.keys(exportObject).forEach((key) => {
          Object.defineProperty(memoryModule, key, {
            enumerable: true,
            get: exportObject[key],
            set: () => {
              throw new TypeError('Assignment to constant variable.');
            },
          });
        });
      },

      [GARFISH_EXPORT_STAR]: (
        sourceModule: MemoryModule,
        excludes: Array<string> = [],
      ) => {
        const module = this.getModule(sourceModule)!;
        const excludedNames = new Set(['default', ...excludes]);

        Reflect.ownKeys(module).forEach((key) => {
          if (typeof key !== 'string') return;
          if (excludedNames.has(key) || hasOwn(memoryModule, key)) return;

          Object.defineProperty(memoryModule, key, {
            enumerable: true,
            get: () => module[key],
            set: () => {
              throw new TypeError('Assignment to constant variable.');
            },
          });
        });
      },
    };
  }

  private getExternalKeys() {
    return Object.keys(this.options.garfishExternals || {});
  }

  private resolveExternalModuleKey(moduleId: string) {
    const externals = this.options.garfishExternals;
    if (!externals) return;
    if (hasOwn(externals, moduleId)) return moduleId;

    return this.getExternalKeys()
      .filter((key) => isExternalPrefixMatch(moduleId, key))
      .sort((a, b) => b.length - a.length)[0];
  }

  private matchesExternalOption(moduleId: string) {
    const matcher = this.options.garfishExternalMatcher;
    if (!matcher) return false;
    if (Array.isArray(matcher)) {
      return matcher.some(
        (item) => item === moduleId || isExternalPrefixMatch(moduleId, item),
      );
    }
    if (matcher instanceof Set) {
      if (matcher.has(moduleId)) return true;
      return [...matcher].some((item) =>
        isExternalPrefixMatch(moduleId, item),
      );
    }
    return matcher(moduleId);
  }

  public isExternalModule(moduleId: string) {
    return Boolean(
      this.resolveExternalModuleKey(moduleId) ||
        this.matchesExternalOption(moduleId),
    );
  }

  private getExternalModule(moduleId: string) {
    const externals = this.options.garfishExternals;
    const externalKey = this.resolveExternalModuleKey(moduleId);

    if (!externals || !externalKey) {
      throw new Error(
        `External module '${moduleId}' is not found in Garfish externals`,
      );
    }

    return toMemoryModule(externals[externalKey]);
  }

  private async analysisModule(
    code: string,
    storeId: string,
    baseRealUrl: string,
    baseMetric: Partial<RuntimeCompileMetric> = {},
  ) {
    const metric: RuntimeCompileMetric = {
      storeId,
      realUrl: baseRealUrl,
      codeBytes: getCodeBytes(code),
      cacheHit: false,
      ...baseMetric,
    };
    const metricStart = now();
    const compileCache = this.getCompileCache();
    const cacheKey = this.getCompileCacheKey(code, storeId, baseRealUrl);

    try {
      const precompiledOutput = readCompiledModuleArtifact(code);
      if (precompiledOutput) {
        return {
          ...precompiledOutput,
          storeId,
          realUrl: baseRealUrl,
        };
      }

      if (this.options.runtimeCompile === false) {
        throw new Error(
          `Module '${storeId}' is not precompiled and runtime compilation is disabled`,
        );
      }

      let output: CompiledModuleResource | undefined;

      if (compileCache) {
        const cached = compileCache.get(cacheKey);
        if (cached) {
          const cachedOutput = await cached;
          if (hasImportMetadata(cachedOutput)) {
            metric.cacheHit = true;
            output = cachedOutput;
          } else {
            compileCache.delete(cacheKey);
          }
        }

        if (!output) {
          const compilePromise = this.compileModule(
            code,
            storeId,
            baseRealUrl,
            metric,
          ).catch((error) => {
            compileCache.delete(cacheKey);
            throw error;
          });
          compileCache.set(cacheKey, compilePromise);
          output = await compilePromise;
          compileCache.set(cacheKey, output);
        }
      } else {
        output = await this.compileModule(code, storeId, baseRealUrl, metric);
      }

      const runtimeOutput = { ...output, storeId, realUrl: baseRealUrl };
      return runtimeOutput;
    } finally {
      metric.totalMs = now() - metricStart;
      this.options.metrics?.({ ...metric });
    }
  }

  private async compileModule(
    code: string,
    storeId: string,
    baseRealUrl: string,
    metric: RuntimeCompileMetric,
  ) {
    const transformStart = now();
    const { transformModuleWithWasm } = await import('./wasm');
    const output = await transformModuleWithWasm(
      code,
      storeId,
      this.options.wasm,
    );
    metric.transformMs = now() - transformStart;

    return {
      code: output.code,
      imports: output.imports,
      exports: output.exports,
      storeId,
      realUrl: baseRealUrl,
    };
  }

  private toDependencyRequests(
    output: Pick<CompiledModuleResource, 'imports'>,
    storeId: string,
    baseRealUrl: string,
  ) {
    return output.imports
      .map(({ moduleId }) => {
        if (this.isExternalModule(moduleId)) return;
        this.ensureImportMapForModule(moduleId);
        return {
          storeId: this.resolveModuleUrl(storeId, moduleId),
          requestUrl: this.resolveModuleUrl(baseRealUrl, moduleId),
        };
      })
      .filter(Boolean) as Array<{ storeId: string; requestUrl: string }>;
  }

  private loadJavaScript(
    url: string,
    crossOrigin?: GarfishEsModulePreloadCrossOrigin,
    defaultContentType?: string,
  ) {
    return new Promise<CacheValue<JavaScriptManager>>((resolve, reject) => {
      const run = () => {
        this.activeLoads++;
        this.loader
          .load<JavaScriptManager>({
            scope: this.options.scope,
            url,
            crossOrigin,
            defaultContentType,
          })
          .then(resolve, reject)
          .finally(() => {
            this.activeLoads--;
            this.loadQueue.shift()?.();
          });
      };

      if (this.activeLoads < MAX_CONCURRENT_LOADS) {
        run();
      } else {
        this.loadQueue.push(run);
      }
    });
  }

  private getOrCreateLoad(
    storeId: string,
    requestUrl: string,
    crossOrigin?: GarfishEsModulePreloadCrossOrigin,
  ) {
    const existing = this.loadRegistry[storeId];
    if (existing) return existing;

    if (this.resources[storeId]) {
      return {
        storeId,
        requestUrl,
        resource: this.resources[storeId] as CompiledModuleResource,
      };
    }

    const load: ModuleLoadRecord = (this.loadRegistry[storeId] = {
      storeId,
      requestUrl,
      crossOrigin,
    });

    load.promise = this.fetchAndCompileLoad(load).catch((error) => {
      if (this.loadRegistry[storeId] === load) {
        delete this.loadRegistry[storeId];
        delete this.resources[storeId];
      }
      throw error;
    });

    return load;
  }

  private async fetchAndCompileLoad(load: ModuleLoadRecord) {
    const fetchStart = now();
    const { resourceManager } = await this.loadJavaScript(
      load.requestUrl,
      load.crossOrigin,
    );
    const fetchMs = now() - fetchStart;

    if (!resourceManager) {
      const error = new Error(`Module '${load.storeId}' not found`);
      warn(error.message);
      throw error;
    }

    const { url, scriptCode } = resourceManager;
    if (!scriptCode) {
      throw new Error(`Module '${load.storeId}' has no script code`);
    }

    assert(url, 'url is required');
    const output = await this.analysisModule(scriptCode, load.storeId, url, {
      fetchMs,
    });
    load.resource = output;
    return output;
  }

  private getCompiledLoad(load: ModuleLoadRecord) {
    if (load.resource) return Promise.resolve(load.resource);
    if (load.promise) return load.promise;
    return Promise.reject(new Error(`Module '${load.storeId}' not found`));
  }

  private async loadModuleGraph(entryLoad: ModuleLoadRecord) {
    const visited = new Map<string, ModuleLoadRecord>();
    const queue: ModuleLoadRecord[] = [];
    let graphError: unknown;
    let hasGraphError = false;

    const enqueue = (load: ModuleLoadRecord) => {
      if (visited.has(load.storeId)) return;
      visited.set(load.storeId, load);
      queue.push(load);
    };

    enqueue(entryLoad);

    while (queue.length > 0) {
      const batch = queue.splice(0);
      const results = await Promise.allSettled(
        batch.map((load) => this.getCompiledLoad(load)),
      );

      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          if (!hasGraphError) {
            graphError = result.reason;
            hasGraphError = true;
          }
          return;
        }

        const load = batch[index];
        load.resource = result.value;
        try {
          this.toDependencyRequests(
            result.value,
            load.storeId,
            result.value.realUrl,
          ).forEach(({ storeId, requestUrl }) => {
            enqueue(
              this.getOrCreateLoad(storeId, requestUrl, load.crossOrigin),
            );
          });
        } catch (error) {
          if (!hasGraphError) {
            graphError = error;
            hasGraphError = true;
          }
        }
      });
    }

    if (hasGraphError) throw graphError;

    visited.forEach((load, storeId) => {
      this.resources[storeId] = load.resource!;
    });
    return entryLoad.resource!;
  }

  private compileAndFetchCode(
    storeId: string,
    url?: string,
    crossOrigin?: GarfishEsModulePreloadCrossOrigin,
  ): void | Promise<ModuleResource> {
    if (this.resources[storeId]) return;
    if (!url) url = storeId;
    const load = this.getOrCreateLoad(storeId, url, crossOrigin);
    return this.loadModuleGraph(load);
  }

  async preloadByUrl(
    storeId: string,
    requestUrl?: string,
    crossOrigin?: GarfishEsModulePreloadCrossOrigin,
  ) {
    await this.compileAndFetchCode(
      storeId,
      requestUrl || storeId,
      crossOrigin,
    );
  }

  async preloadScript(
    url: string,
    crossOrigin?: GarfishEsModulePreloadCrossOrigin,
  ) {
    await this.loadJavaScript(url, crossOrigin, 'text/javascript');
  }

  import(storeId: string) {
    return this.importModule(storeId) as MemoryModule;
  }

  importByUrl(
    storeId: string,
    requestUrl?: string,
    execCode?: RuntimeExecCode,
  ) {
    const result = this.importModule(storeId, requestUrl || storeId, execCode);
    return Promise.resolve(result).then((memoryModule) => {
      return this.getModule(memoryModule);
    });
  }

  async importByCode(
    code: string,
    storeId: string,
    metaUrl?: string,
    execCode?: RuntimeExecCode,
  ) {
    const existingModule = this.memoryModules[storeId];
    if (existingModule) {
      return this.getModule(existingModule);
    }
    const inFlightModule = this.codeImportRegistry[storeId];
    if (inFlightModule) {
      const memoryModule = await inFlightModule;
      return this.getModule(memoryModule);
    }

    if (!metaUrl) metaUrl = storeId;
    const modulePromise = (async () => {
      const output = await this.analysisModule(code, storeId, metaUrl);
      const loadedModule = this.memoryModules[storeId];
      if (loadedModule) return loadedModule;

      const entryLoad: ModuleLoadRecord = {
        storeId,
        requestUrl: metaUrl,
        resource: output,
      };
      const previousLoad = this.loadRegistry[storeId];
      const previousResource = this.resources[storeId];
      this.loadRegistry[storeId] = entryLoad;
      try {
        await this.loadModuleGraph(entryLoad);
      } catch (error) {
        if (this.loadRegistry[storeId] === entryLoad) {
          if (previousLoad) {
            this.loadRegistry[storeId] = previousLoad;
          } else {
            delete this.loadRegistry[storeId];
          }
        }
        if (previousResource) {
          this.resources[storeId] = previousResource;
        } else {
          delete this.resources[storeId];
        }
        throw error;
      }
      if (this.loadRegistry[storeId] === entryLoad) {
        delete this.loadRegistry[storeId];
      }

      const graphLoadedModule = this.memoryModules[storeId];
      if (graphLoadedModule) return graphLoadedModule;

      const memoryModule = {};
      this.memoryModules[storeId] = memoryModule;

      try {
        this.execCode(output, memoryModule, execCode);
      } catch (error) {
        delete this.memoryModules[storeId];
        delete this.resources[storeId];
        delete this.loadRegistry[storeId];
        throw error;
      }

      return memoryModule;
    })();

    this.codeImportRegistry[storeId] = modulePromise;
    const memoryModule = await modulePromise.finally(() => {
      if (this.codeImportRegistry[storeId] === modulePromise) {
        delete this.codeImportRegistry[storeId];
      }
    });
    return this.getModule(memoryModule);
  }
}
