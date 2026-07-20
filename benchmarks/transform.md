<!-- benchmark-results:start -->

| Fixture | Source bytes | Mean | p75 | p99 | Throughput | Samples |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `small-live-bindings` | 255 | 0.005 ms | 0.005 ms | 0.005 ms | 212,806 ops/sec | 1,060,091 |
| `medium-dashboard` | 1,247 | 0.025 ms | 0.024 ms | 0.033 ms | 40,850 ops/sec | 197,797 |
| `large-re-export` | 5,314 | 0.083 ms | 0.083 ms | 0.090 ms | 12,052 ops/sec | 60,174 |

Measured on Node v22.23.1 with `BENCH_TIME_MS=5000` and `BENCH_WARMUP_MS=1000`.

<!-- benchmark-results:end -->
