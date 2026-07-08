export type MemoryModule = Record<string, any>;

export type MetaObject = { url: string; __garfishPolyfill__: boolean };

export type Module = {
  [key: string]: any;
  [Symbol.toStringTag]: 'Module';
};

export function createModule(memoryModule: MemoryModule) {
  return new Proxy(Object.create(null), {
    getPrototypeOf() {
      return null;
    },

    setPrototypeOf() {
      return false;
    },

    get(_, key) {
      if (key === Symbol.toStringTag) return 'Module';
      return memoryModule[key as string];
    },

    set(_, key) {
      throw TypeError(
        `Cannot assign to read only property '${String(
          key,
        )}' of object '[object Module]'`,
      );
    },

    has(_, key) {
      return key === Symbol.toStringTag || key in memoryModule;
    },

    ownKeys() {
      return [...Reflect.ownKeys(memoryModule), Symbol.toStringTag];
    },

    getOwnPropertyDescriptor(_, key) {
      if (key === Symbol.toStringTag) {
        return {
          value: 'Module',
          writable: false,
          enumerable: false,
          configurable: true,
        };
      }

      const descriptor = Object.getOwnPropertyDescriptor(memoryModule, key);
      if (!descriptor) return undefined;

      return {
        enumerable: descriptor.enumerable,
        configurable: true,
        get: () => memoryModule[key as string],
        set: () => {
          throw TypeError(
            `Cannot assign to read only property '${String(
              key,
            )}' of object '[object Module]'`,
          );
        },
      };
    },

    defineProperty() {
      return false;
    },

    deleteProperty() {
      return false;
    },
  }) as Module;
}

export function createImportMeta(url: string) {
  const metaObject: MetaObject = Object.create(null);
  const set = (key: string, value: unknown) => {
    Object.defineProperty(metaObject, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  };

  set('url', url);
  set('__garfishPolyfill__', true);
  return { meta: metaObject };
}
