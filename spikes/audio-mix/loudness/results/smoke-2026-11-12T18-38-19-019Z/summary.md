# S1 run 2026-11-12T18-38-19-019Z (SMOKE: 1 run x 2000 quanta, plumbing only, not timing)

RUNS=1 QUANTA=2000; quantum = 128 frames at 48 kHz = 2667 us. Times are us per quantum for ALL k buses together; medians over runs of each run's statistic; "max" is the max over runs.

## Correctness checks
- native: 189/189 checks pass
- wasm: 189/189 checks pass

## Cost per quantum, native (us; % of the 2,667 us quantum is p50/2667)

| case | signal | k | p50 | p99 | p99.9 | max | tp ran | allocs/run |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| floor | music | 1 | 0.05 | 0.05 | 0.07 | 15.2 | 0.00 | 0 |
| peak | music | 1 | 0.19 | 0.32 | 0.44 | 0.5 | 0.00 | 0 |
| peak | music | 8 | 1.11 | 1.77 | 40.57 | 47.5 | 0.00 | 0 |
| kw | music | 1 | 0.85 | 0.87 | 7.29 | 14.1 | 0.00 | 0 |
| kw | music | 4 | 3.27 | 3.65 | 28.91 | 75.3 | 0.00 | 0 |
| kw | music | 8 | 5.42 | 11.40 | 35.45 | 44.3 | 0.00 | 0 |
| kw | burst | 1 | 0.85 | 0.98 | 15.67 | 35.2 | 0.00 | 0 |
| tp | music | 1 | 0.89 | 1.24 | 5.70 | 16.7 | 1.00 | 0 |
| tp | music | 4 | 3.07 | 4.31 | 23.42 | 24.5 | 1.00 | 0 |
| tp | music | 8 | 7.37 | 13.77 | 32.15 | 42.6 | 1.00 | 0 |
| both | music | 1 | 1.70 | 1.94 | 16.73 | 75.6 | 1.00 | 0 |
| both | music | 4 | 6.67 | 18.19 | 38.49 | 41.9 | 1.00 | 0 |
| both | music | 8 | 11.19 | 23.85 | 49.39 | 186.7 | 1.00 | 0 |
| both_gated | music | 1 | 0.82 | 0.83 | 0.85 | 13.7 | 0.00 | 0 |
| both_gated | music | 4 | 3.14 | 4.00 | 23.11 | 32.5 | 0.00 | 0 |
| both_gated | music | 8 | 6.24 | 13.28 | 31.22 | 33.5 | 0.00 | 0 |
| both_gated | hot | 1 | 0.96 | 1.90 | 14.65 | 17.4 | 0.21 | 0 |
| both_gated | hot | 8 | 8.33 | 23.11 | 36.41 | 41.8 | 0.19 | 0 |
| ebur_add | music | 1 | 3.70 | 27.12 | 236.73 | 292.6 | -0.00 | 0 |
| ebur_add | music | 4 | 15.36 | 142.72 | 1,032.27 | 1,454.0 | -0.00 | 0 |
| ebur_add | music | 8 | 29.65 | 307.07 | 1,656.21 | 2,398.3 | -0.00 | 0 |
| ebur_full | music | 1 | 4.96 | 47.29 | 262.90 | 326.8 | -0.00 | 0 |
| ebur_full | music | 4 | 15.22 | 159.61 | 1,039.22 | 1,265.4 | -0.00 | 0 |
| ebur_full | music | 8 | 27.34 | 254.42 | 1,528.17 | 1,731.4 | -0.00 | 0 |
| ebur_i | music | 1 | 0.95 | 21.71 | 33.94 | 51.7 | -0.00 | 0 |
| ebur_tp | music | 1 | 2.66 | 3.37 | 21.22 | 27.9 | -0.00 | 0 |

## Cost per quantum, wasm (us; % of the 2,667 us quantum is p50/2667)

| case | signal | k | p50 | p99 | p99.9 | max | tp ran | allocs/run |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| floor | music | 1 | 0.18 | 0.61 | 8.22 | 427.5 | 0.00 | 0 |
| peak | music | 1 | 0.84 | 1.29 | 19.90 | 23.7 | 0.00 | 0 |
| peak | music | 8 | 4.68 | 10.52 | 27.32 | 42.3 | 0.00 | 0 |
| kw | music | 1 | 0.76 | 1.11 | 9.02 | 27.7 | 0.00 | 0 |
| kw | music | 4 | 2.55 | 3.59 | 21.16 | 30.6 | 0.00 | 0 |
| kw | music | 8 | 4.99 | 12.80 | 28.64 | 33.1 | 0.00 | 0 |
| kw | burst | 1 | 0.65 | 0.78 | 8.20 | 39.0 | 0.00 | 0 |
| tp | music | 1 | 1.61 | 1.96 | 12.36 | 19.7 | 1.00 | 0 |
| tp | music | 4 | 6.35 | 14.97 | 26.48 | 54.6 | 1.00 | 0 |
| tp | music | 8 | 12.77 | 25.42 | 57.34 | 120.9 | 1.00 | 0 |
| both | music | 1 | 2.20 | 4.01 | 17.32 | 29.2 | 1.00 | 0 |
| both | music | 4 | 8.71 | 19.20 | 32.89 | 3,249.6 | 1.00 | 0 |
| both | music | 8 | 17.37 | 29.42 | 40.56 | 82.7 | 1.00 | 0 |
| both_gated | music | 1 | 1.09 | 1.34 | 13.74 | 23.8 | 0.00 | 0 |
| both_gated | music | 4 | 6.14 | 16.09 | 39.00 | 72.7 | 0.00 | 0 |
| both_gated | music | 8 | 10.24 | 23.41 | 35.80 | 44.3 | 0.00 | 0 |
| both_gated | hot | 1 | 1.39 | 3.89 | 40.59 | 88.9 | 0.21 | 0 |
| both_gated | hot | 8 | 12.46 | 28.74 | 47.30 | 112.9 | 0.19 | 0 |
| ebur_add | music | 1 | 4.70 | 27.09 | 230.52 | 264.3 | -0.00 | 0 |
| ebur_add | music | 4 | 19.29 | 131.22 | 1,034.08 | 1,345.2 | -0.00 | 0 |
| ebur_add | music | 8 | 38.18 | 309.93 | 2,034.17 | 2,485.1 | -0.00 | 0 |
| ebur_full | music | 1 | 4.71 | 47.49 | 256.34 | 268.9 | -0.00 | 0 |
| ebur_full | music | 4 | 19.55 | 149.41 | 1,237.03 | 1,444.9 | -0.00 | 0 |
| ebur_full | music | 8 | 40.82 | 351.39 | 2,234.30 | 2,480.0 | -0.00 | 0 |
| ebur_i | music | 1 | 1.03 | 23.07 | 23.16 | 23.2 | -0.00 | 0 |
| ebur_tp | music | 1 | 3.59 | 7.15 | 20.27 | 29.6 | -0.00 | 0 |

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
| ebur_add | music | 1 | 133,660 | 475,652 | 475,660 |
| ebur_full | music | 1 | 133,669 | 550,308 | 816,187 |

## wasm size (release, +simd128, opt-level 3 + LTO, no wasm-opt on this machine; the core is 318,306 B)

| variant | bytes | delta vs base | gzip |
|---|---:|---:|---:|
| base | 385 | 0 | 330 |
| own | 21,216 | 20,831 | 9,648 |
| ebur128 crate | 86,171 | 85,786 | 41,117 |

