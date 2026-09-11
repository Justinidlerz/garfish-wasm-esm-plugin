import { describe, expect, it } from 'vitest';
import * as root from '../src/index';
import * as runtime from '../src/runtime-entry';

describe('resource hint ownership', () => {
  it.each([
    ['root', root],
    ['runtime', runtime],
  ] as const)(
    '%s entry exposes normal imports without plugin preload APIs',
    (_name, entry) => {
      expect(entry.Runtime).toBe(runtime.Runtime);
      expect(entry.GarfishEsModule).toBeTypeOf('function');
      expect('GARFISH_ES_MODULE_PRELOADS_SYMBOL' in entry).toBe(false);
      expect('preloadByUrl' in entry.Runtime.prototype).toBe(false);
      expect('preloadScript' in entry.Runtime.prototype).toBe(false);
      expect(entry.Runtime.prototype.importByUrl).toBeTypeOf('function');
      expect(entry.Runtime.prototype.importByCode).toBeTypeOf('function');
    },
  );
});
