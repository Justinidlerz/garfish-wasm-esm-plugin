---
"garfish-wasm-esm-plugin": patch
---

Replace the Rust/OXC transformer with a smaller Zig/Yuku WebAssembly transformer using a speed-first production profile, a single semantic traversal, and direct binary output while preserving the existing runtime API and ESM live-binding behavior.
