# S1 run 2026-11-12T18-43-39-839Z

RUNS=5 QUANTA=20000; quantum = 128 frames at 48 kHz = 2667 us. Times are us per quantum for ALL k buses together; medians over runs of each run's statistic; "max" is the max over runs.

## Correctness checks
- native: 189/189 checks pass
- wasm: 189/189 checks pass

## Cost per quantum, native (us; % of the 2,667 us quantum is p50/2667)

| case | signal | k | p50 | p99 | p99.9 | max | tp ran | allocs/run |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| floor | music | 1 | 0.03 | 0.04 | 0.06 | 20.3 | 0.00 | 0 |
| peak | music | 1 | 0.13 | 0.16 | 0.29 | 175.2 | 0.00 | 0 |
| peak | music | 8 | 0.78 | 0.92 | 30.05 | 88.2 | 0.00 | 0 |
| kw | music | 1 | 0.74 | 0.81 | 11.82 | 371.8 | 0.00 | 0 |
| kw | music | 4 | 2.86 | 3.12 | 24.73 | 262.6 | 0.00 | 0 |
| kw | music | 8 | 6.48 | 16.46 | 40.17 | 666.2 | 0.00 | 0 |
| kw | burst | 1 | 0.82 | 0.89 | 13.42 | 1,487.4 | 0.00 | 0 |
| tp | music | 1 | 0.89 | 1.08 | 12.55 | 58.6 | 1.00 | 0 |
| tp | music | 4 | 3.49 | 8.40 | 36.56 | 4,505.6 | 1.00 | 0 |
| tp | music | 8 | 6.74 | 19.96 | 39.48 | 388.8 | 1.00 | 0 |
| both | music | 1 | 1.70 | 2.01 | 21.60 | 165.9 | 1.00 | 0 |
| both | music | 4 | 5.56 | 12.14 | 32.23 | 3,477.0 | 1.00 | 0 |
| both | music | 8 | 11.15 | 26.05 | 41.08 | 2,042.2 | 1.00 | 0 |
| both_gated | music | 1 | 0.96 | 1.03 | 14.49 | 4,437.8 | 0.00 | 0 |
| both_gated | music | 4 | 3.29 | 4.06 | 26.27 | 606.1 | 0.00 | 0 |
| both_gated | music | 8 | 6.55 | 15.77 | 31.84 | 640.6 | 0.00 | 0 |
| both_gated | hot | 1 | 0.93 | 1.75 | 12.68 | 45.3 | 0.23 | 0 |
| both_gated | hot | 8 | 8.00 | 24.05 | 56.20 | 2,524.9 | 0.21 | 0 |
| ebur_add | music | 1 | 3.24 | 23.23 | 184.99 | 476.2 | -0.00 | 0 |
| ebur_add | music | 4 | 12.77 | 100.86 | 758.16 | 1,684.6 | -0.00 | 0 |
| ebur_add | music | 8 | 29.78 | 249.08 | 1,934.62 | 4,711.1 | -0.00 | 0 |
| ebur_full | music | 1 | 3.13 | 39.67 | 208.07 | 724.5 | -0.00 | 0 |
| ebur_full | music | 4 | 12.48 | 149.78 | 861.09 | 3,161.3 | -0.00 | 0 |
| ebur_full | music | 8 | 27.93 | 305.16 | 1,792.26 | 2,859.9 | -0.00 | 0 |
| ebur_i | music | 1 | 0.84 | 19.11 | 29.66 | 161.6 | -0.00 | 0 |
| ebur_tp | music | 1 | 2.28 | 2.90 | 18.90 | 165.7 | -0.00 | 0 |

## Cost per quantum, wasm (us; % of the 2,667 us quantum is p50/2667)

| case | signal | k | p50 | p99 | p99.9 | max | tp ran | allocs/run |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| floor | music | 1 | 0.05 | 0.06 | 0.11 | 221.9 | 0.00 | 0 |
| peak | music | 1 | 0.48 | 0.59 | 4.81 | 159.1 | 0.00 | 0 |
| peak | music | 8 | 4.08 | 11.25 | 34.24 | 661.5 | 0.00 | 0 |
| kw | music | 1 | 0.73 | 0.99 | 14.41 | 830.0 | 0.00 | 0 |
| kw | music | 4 | 2.76 | 3.62 | 30.55 | 1,327.0 | 0.00 | 0 |
| kw | music | 8 | 5.86 | 15.00 | 43.46 | 3,101.7 | 0.00 | 0 |
| kw | burst | 1 | 0.77 | 1.00 | 20.26 | 2,230.5 | 0.00 | 0 |
| tp | music | 1 | 1.61 | 1.87 | 16.30 | 619.8 | 1.00 | 0 |
| tp | music | 4 | 6.40 | 12.74 | 28.24 | 194.8 | 1.00 | 0 |
| tp | music | 8 | 12.55 | 26.58 | 47.90 | 941.6 | 1.00 | 0 |
| both | music | 1 | 2.20 | 3.11 | 18.41 | 1,675.1 | 1.00 | 0 |
| both | music | 4 | 8.64 | 18.88 | 35.04 | 1,052.4 | 1.00 | 0 |
| both | music | 8 | 20.71 | 45.03 | 80.73 | 3,795.3 | 1.00 | 0 |
| both_gated | music | 1 | 1.31 | 1.71 | 14.60 | 578.0 | 0.00 | 0 |
| both_gated | music | 4 | 5.37 | 11.38 | 30.91 | 265.0 | 0.00 | 0 |
| both_gated | music | 8 | 10.27 | 24.69 | 38.42 | 1,888.9 | 0.00 | 0 |
| both_gated | hot | 1 | 1.78 | 4.26 | 42.33 | 383.4 | 0.23 | 0 |
| both_gated | hot | 8 | 13.76 | 36.26 | 109.57 | 2,115.1 | 0.21 | 0 |
| ebur_add | music | 1 | 4.65 | 28.08 | 218.31 | 1,983.0 | -0.00 | 0 |
| ebur_add | music | 4 | 18.39 | 118.89 | 925.69 | 2,488.3 | -0.00 | 0 |
| ebur_add | music | 8 | 38.46 | 267.93 | 2,070.00 | 6,234.3 | -0.00 | 0 |
| ebur_full | music | 1 | 4.65 | 43.31 | 233.83 | 1,496.5 | -0.00 | 0 |
| ebur_full | music | 4 | 18.33 | 163.85 | 942.94 | 5,135.5 | -0.00 | 0 |
| ebur_full | music | 8 | 38.32 | 356.86 | 2,317.04 | 5,066.7 | -0.00 | 0 |
| ebur_i | music | 1 | 0.98 | 22.05 | 34.71 | 342.7 | -0.00 | 0 |
| ebur_tp | music | 1 | 3.48 | 4.70 | 23.91 | 1,126.8 | -0.00 | 0 |

## Metered wasm: instructions per quantum (deterministic; every wasm instruction weighs 1, so it is a work measure, not time)

| case | signal | k | instr p50 | instr p99 | instr max |
|---|---|---:|---:|---:|---:|
| peak | music | 1 | 7,071 | 7,093 | 7,093 |
| kw | music | 1 | 16,924 | 17,083 | 17,083 |
| tp | music | 1 | 25,775 | 25,797 | 25,797 |
| both | music | 1 | 42,557 | 42,716 | 42,716 |
| both | music | 8 | 340,267 | 341,539 | 341,539 |
| both_gated | music | 1 | 23,857 | 24,016 | 24,016 |
| both_gated | hot | 1 | 23,857 | 49,444 | 49,581 |
| ebur_add | music | 1 | 133,660 | 475,656 | 4,207,252 |
| ebur_full | music | 1 | 133,669 | 672,612 | 4,548,589 |

## wasm size (release, +simd128, opt-level 3 + LTO, no wasm-opt on this machine; the core is 318,306 B)

| variant | bytes | delta vs base | gzip |
|---|---:|---:|---:|
| base | 385 | 0 | 330 |
| own | 21,216 | 20,831 | 9,648 |
| ebur128 crate | 86,171 | 85,786 | 41,117 |

