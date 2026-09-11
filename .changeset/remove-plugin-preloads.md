---
"garfish-wasm-esm-plugin": minor
---

Remove plugin-owned preload, prefetch, and modulepreload handling so resource hints remain under Garfish's control. Remove Runtime.preloadByUrl, Runtime.preloadScript, GARFISH_ES_MODULE_PRELOADS_SYMBOL, and the GarfishEsModulePreload types. Consumers of these APIs should use Garfish's resource loading facilities instead.
