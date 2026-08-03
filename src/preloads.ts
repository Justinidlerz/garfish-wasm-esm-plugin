export const GARFISH_ES_MODULE_PRELOADS_SYMBOL = Symbol.for(
  'garfish.es-module.preloads.v1',
);

export type GarfishEsModulePreloadRel =
  | 'preload'
  | 'prefetch'
  | 'modulepreload';

export type GarfishEsModulePreloadCrossOrigin =
  | 'anonymous'
  | 'use-credentials';

export interface GarfishEsModulePreloadDescriptor {
  rel: GarfishEsModulePreloadRel;
  href: string;
  crossOrigin?: GarfishEsModulePreloadCrossOrigin;
}
