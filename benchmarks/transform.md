<!-- benchmark-results:start -->

| Fixture | Source bytes | Mean | p75 | p99 | Throughput | Samples |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `small-live-bindings` | 255 | 0.011 ms | 0.011 ms | 0.014 ms | 90,876 ops/sec | 90,215 |
| `medium-dashboard` | 1,247 | 0.064 ms | 0.063 ms | 0.078 ms | 15,850 ops/sec | 15,707 |
| `large-re-export` | 5,314 | 0.250 ms | 0.250 ms | 0.348 ms | 4,010 ops/sec | 3,993 |

Measured on Node v22.23.1 with `BENCH_TIME_MS=1000` and `BENCH_WARMUP_MS=250`.

<!-- benchmark-results:end -->
