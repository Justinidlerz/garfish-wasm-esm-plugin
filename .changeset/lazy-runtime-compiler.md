---
"garfish-wasm-esm-plugin": patch
---

Keep the wasm compiler behind a lazy package-root boundary so fully precompiled
applications only load it when runtime compilation or a compiler API is used.
