import { describe, expect, it } from 'vitest';
import { createImportMeta, createModule } from '../src/module';

describe('module namespace helpers', () => {
  it('exposes live read-only namespace properties', () => {
    const memoryModule = { value: 1, default: 'fallback' };
    const module = createModule(memoryModule);

    expect(Object.getPrototypeOf(module)).toBeNull();
    expect(Object.prototype.toString.call(module)).toBe('[object Module]');
    expect(module.value).toBe(1);

    memoryModule.value = 2;
    expect(module.value).toBe(2);
    expect(Object.keys(module)).toEqual(['value', 'default']);
    expect(Object.getOwnPropertyDescriptor(module, 'value')?.enumerable).toBe(
      true,
    );
    expect(() => {
      module.value = 3;
    }).toThrow("Cannot assign to read only property 'value'");
    expect(() => {
      delete module.value;
    }).toThrow();
  });

  it('creates import.meta objects with stable url metadata', () => {
    const meta = createImportMeta('https://example.test/subapp.js');

    expect(meta.meta.url).toBe('https://example.test/subapp.js');
    expect(meta.meta.__garfishPolyfill__).toBe(true);
    expect(Object.keys(meta.meta)).toEqual(['url', '__garfishPolyfill__']);
  });
});
