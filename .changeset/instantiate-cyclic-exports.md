---
"garfish-wasm-esm-plugin": patch
---

Register explicit ESM export bindings before evaluating static dependencies so circular imports observe live exports.
