<!-- benchmark-results:start -->

| Fixture | Source bytes | Mean | p75 | p99 | Throughput | Samples |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `small-live-bindings` | 255 | 0.007 ms | 0.007 ms | 0.009 ms | 139,392 ops/sec | 411,049 |
| `medium-dashboard` | 1,247 | 0.039 ms | 0.037 ms | 0.102 ms | 26,977 ops/sec | 77,551 |
| `large-re-export` | 5,314 | 0.130 ms | 0.130 ms | 0.212 ms | 7,806 ops/sec | 23,159 |

Measured on Node v22.23.1 with `BENCH_TIME_MS=3000` and `BENCH_WARMUP_MS=500`.

<!-- benchmark-results:end -->
