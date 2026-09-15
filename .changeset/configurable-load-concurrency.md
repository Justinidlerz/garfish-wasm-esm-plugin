---
"garfish-wasm-esm-plugin": minor
---

Add a limitConcurrency option to disable the per-Runtime module load concurrency
limit through the plugin or Runtime options. Preserve the default limit of 24
concurrent loads when the option is omitted or true.
