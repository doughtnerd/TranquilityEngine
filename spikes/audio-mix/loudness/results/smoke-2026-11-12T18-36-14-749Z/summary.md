# S1 run 2026-11-12T18-36-14-749Z (SMOKE: 1 run x 2000 quanta, plumbing only, not timing)

RUNS=1 QUANTA=2000; quantum = 128 frames at 48 kHz = 2667 us. Times are us per quantum for ALL k buses together; medians over runs of each run's statistic; "max" is the max over runs.

## Correctness checks
- native: 189/189 checks pass
- wasm: 189/189 checks pass

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

