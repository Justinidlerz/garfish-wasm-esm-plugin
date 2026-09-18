---
"garfish-wasm-esm-plugin": patch
---

Preserve original module evaluation failures across repeated and concurrent imports instead of reporting missing modules after cleanup. Invalidate failed static importers, including cycles, while retaining independent dependencies and keeping failure state local to each Runtime. Preserve falsy thrown values and the first failure through the Garfish execution queue.
