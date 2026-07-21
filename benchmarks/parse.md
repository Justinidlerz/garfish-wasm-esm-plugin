# Parser benchmark

The migration baseline compares parser-only WebAssembly entry points on the
same 4,319-byte ESM fixture. Both paths encode and copy the source and filename
into Wasm memory on every iteration. The Rust/OXC entry point was instrumented
before the Rust sources were removed; the Zig/Yuku entry point is built with
`zig build parse-benchmark -Doptimize=ReleaseFast`.

| Parser | Mean | p75 | p99 | Throughput | Samples |
| --- | ---: | ---: | ---: | ---: | ---: |
| Rust/OXC Wasm | 0.0458 ms | 0.0445 ms | 0.0924 ms | 22,488 ops/sec | 65,566 |
| Zig/Yuku Wasm | 0.0163 ms | 0.0165 ms | 0.0192 ms | 61,488 ops/sec | 306,704 |

The Zig/Yuku parser lowers mean latency by 64.4% and increases throughput by
173.4% in this same-process A/B run.

Measured on Node v22.23.1 with `BENCH_TIME_MS=5000` and
`BENCH_WARMUP_MS=1000`.
