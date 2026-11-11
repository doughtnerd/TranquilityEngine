# S4 run 2026-11-11T17-51-31-551Z (SMOKE: 1 run x 2 s, plumbing only, not timing)

RUNS=1 SECONDS=2 WARMUP=1 PACE=0; quantum = 128 frames at 48 kHz = 2667 us. Medians over runs. Times in us per quantum.

## Correctness checks
- native: gain_ramp PASS; clock_120bpm (worst error 0 frames over 107 beats); clock_130bpm (worst error 0 frames over 116 beats); clock_tempo_change (worst error 0 frames over 34 beats); all PASS
- wasm: gain_ramp PASS; clock_120bpm (worst error 0 frames over 107 beats); clock_130bpm (worst error 0 frames over 116 beats); clock_tempo_change (worst error 0 frames over 34 beats); all PASS

## Micro: gain_ramp (ns per call; one call = one voice (gain_ramp) or one clock-quantum set (music_clock) per 128-frame quantum; median over runs of each run's p50 / p99)

| case | native p50 | native p99 | wasm p50 | wasm p99 |
|---|---:|---:|---:|---:|
| core_settled (g=gain.next()*fade.next()) | 45.6 | 416.9 | 58.9 | 100.7 |
| copy_only (the two 128-frame copies) | 12.1 | 12.6 | 22.7 | 25.6 |
| linear_full (fade ramp running, 128 frames) | 291.7 | 320.7 | 393.3 | 473.3 |
| linear_from_sample_37 (two ranges: settled, then ramp) | 106.5 | 115.4 | 263.6 | 279.6 |
| sin (equal-power, libm sinf per sample), full, per-sample | 1,864.8 | 2,028.6 | 1,445.2 | 1,858.8 |
| sin (equal-power, libm sinf per sample), from_37, per-sample | 1,305.7 | 1,346.7 | 1,263.9 | 1,524.9 |
| sin (equal-power, libm sinf per sample), full, block (curve array then multiply) | 493.4 | 522.3 | 1,648.3 | 1,917.9 |
| sqrt (equal-power law g=sqrt(t)), full, per-sample | 287.2 | 315.3 | 1,916.5 | 2,011.7 |
| sqrt (equal-power law g=sqrt(t)), from_37, per-sample | 237.7 | 276.3 | 1,485.1 | 1,503.5 |
| sqrt (equal-power law g=sqrt(t)), full, block (curve array then multiply) | 314.1 | 332.8 | 1,056.0 | 1,197.6 |
| smoothstep (S-curve, polynomial), full, per-sample | 280.9 | 301.5 | 436.5 | 449.8 |
| smoothstep (S-curve, polynomial), from_37, per-sample | 230.8 | 297.8 | 358.4 | 426.2 |
| smoothstep (S-curve, polynomial), full, block (curve array then multiply) | 350.9 | 373.3 | 491.8 | 523.2 |
| lut1024 (equal-power table, lerp), full, per-sample | 556.0 | 846.1 | 670.4 | 750.0 |
| lut1024 (equal-power table, lerp), from_37, per-sample | 416.6 | 449.6 | 518.4 | 553.9 |
| lut1024 (equal-power table, lerp), full, block (curve array then multiply) | 542.6 | 595.1 | 647.4 | 692.8 |

## Micro: music_clock (ns per call; one call = one voice (gain_ramp) or one clock-quantum set (music_clock) per 128-frame quantum; median over runs of each run's p50 / p99)

| case | native p50 | native p99 | wasm p50 | wasm p99 |
|---|---:|---:|---:|---:|
| 1 instance(s), 1 tempo segment(s), cached segment | 5.0 | 5.4 | 8.2 | 8.9 |
| 8 instance(s), 1 tempo segment(s), cached segment | 32.6 | 32.9 | 55.2 | 63.3 |
| 1 instance(s), 8 tempo segment(s), cached segment | 5.2 | 5.3 | 8.2 | 8.4 |
| 8 instance(s), 8 tempo segment(s), cached segment | 36.3 | 41.5 | 55.1 | 55.3 |
| 1 instance(s), 64 tempo segment(s), cached segment | 5.2 | 5.3 | 8.2 | 8.8 |
| 8 instance(s), 64 tempo segment(s), cached segment | 35.8 | 36.7 | 55.2 | 55.2 |
| 1 instance(s), 8 tempo segment(s), binary search every quantum | 7.9 | 8.1 | 11.5 | 11.8 |
| 8 instance(s), 8 tempo segment(s), binary search every quantum | 60.4 | 60.5 | 81.8 | 110.1 |
| 1 instance(s), 64 tempo segment(s), binary search every quantum | 12.7 | 12.8 | 15.6 | 16.3 |
| 8 instance(s), 64 tempo segment(s), binary search every quantum | 99.3 | 122.6 | 118.4 | 126.1 |

## Scenes, native (median over 1 runs of each run's statistic, us per quantum)

| scene | p50 | p99 | p99.9 | max | mean | mixed | peak | starved |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| mus-typ-base | 1,649 | 2,607 | 2,669 | 3,181 | 1,679 | 250.4 | 0.299 | 0 |
| mus-typ | 1,702 | 2,691 | 3,517 | 3,808 | 1,773 | 254.4 | 0.326 | 0 |
| mus-trans-base | 1,637 | 2,495 | 2,803 | 3,054 | 1,730 | 240.5 | 0.268 | 0 |
| mus-trans | 1,691 | 2,567 | 2,745 | 2,943 | 1,720 | 254.4 | 0.298 | 0 |
| mus-worst-base | 1,906 | 3,077 | 3,174 | 3,212 | 2,017 | 234.5 | 0.144 | 0 |
| mus-worst | 1,981 | 2,949 | 3,730 | 4,218 | 2,036 | 254.5 | 0.206 | 0 |
| mus-worst-split | 2,548 | 4,030 | 4,437 | 5,115 | 2,633 | 254.5 | 0.202 | 0 |
| iso-empty | 2 | 2 | 13 | 20 | 2 | 0.0 | 0.000 | 0 |
| iso-clip48 | 36 | 61 | 69 | 92 | 38 | 16.0 | 0.086 | 0 |
| iso-clip441 | 36 | 57 | 65 | 107 | 37 | 16.0 | 0.081 | 0 |
| iso-clip48-sp | 36 | 63 | 98 | 141 | 38 | 16.0 | 0.084 | 0 |
| iso-clip441-sp | 36 | 59 | 84 | 100 | 38 | 16.0 | 0.077 | 0 |
| iso-stream48 | 45 | 73 | 86 | 87 | 47 | 16.0 | 0.108 | 0 |
| iso-stream441 | 45 | 75 | 97 | 739 | 49 | 16.0 | 0.129 | 0 |
| iso-clip48-64 | 143 | 187 | 203 | 268 | 147 | 64.0 | 0.194 | 0 |
| iso-clip441-64 | 145 | 202 | 215 | 732 | 154 | 64.0 | 0.170 | 0 |

### Music delta, native (scene minus its twin without the music voices; us per quantum; % of the 2667 us quantum)

| scene | d p50 | d p99 | d p99.9 | d mean | d mean % of quantum |
|---|---:|---:|---:|---:|---:|
| mus-typ (vs mus-typ-base) | 53 | 84 | 848 | 94 | 3.53 |
| mus-trans (vs mus-trans-base) | 54 | 72 | -58 | -10 | -0.38 |
| mus-worst (vs mus-worst-base) | 74 | -128 | 555 | 19 | 0.71 |
| mus-worst-split (vs mus-worst-base) | 641 | 953 | 1,262 | 616 | 23.11 |

### Q4 per-voice cost, native ((scene mean - iso-empty mean) / voices; ns per voice per quantum; mean, not p50)

| scene | voices | source | ns / voice / quantum |
|---|---:|---|---:|
| iso-clip48 | 16 | decoded, 48 kHz, non-spatial | 2,263 |
| iso-clip441 | 16 | decoded, 44.1 kHz, non-spatial | 2,243 |
| iso-clip48-sp | 16 | decoded, 48 kHz, spatial (equal-power) | 2,294 |
| iso-clip441-sp | 16 | decoded, 44.1 kHz, spatial (equal-power) | 2,273 |
| iso-stream48 | 16 | stream ring, 48 kHz, non-spatial | 2,869 |
| iso-stream441 | 16 | stream ring, 44.1 kHz, non-spatial | 2,936 |
| iso-clip48-64 | 64 | decoded, 48 kHz, non-spatial | 2,276 |
| iso-clip441-64 | 64 | decoded, 44.1 kHz, non-spatial | 2,382 |

## Scenes, wasm (median over 1 runs of each run's statistic, us per quantum)

| scene | p50 | p99 | p99.9 | max | mean | mixed | peak | starved |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| mus-typ-base | 2,185 | 3,068 | 3,301 | 3,327 | 2,224 | 250.4 | 0.299 | 0 |
| mus-typ | 2,230 | 3,199 | 4,204 | 4,231 | 2,279 | 254.4 | 0.326 | 0 |
| mus-trans-base | 2,162 | 3,276 | 6,129 | 6,294 | 2,295 | 240.5 | 0.268 | 0 |
| mus-trans | 2,208 | 4,539 | 5,151 | 6,966 | 2,355 | 254.4 | 0.298 | 0 |
| mus-worst-base | 2,285 | 3,348 | 3,526 | 3,720 | 2,334 | 234.5 | 0.144 | 0 |
| mus-worst | 2,395 | 3,468 | 3,778 | 7,311 | 2,436 | 254.5 | 0.206 | 0 |
| mus-worst-split | 3,148 | 5,022 | 11,161 | 13,334 | 3,290 | 254.5 | 0.202 | 0 |
| iso-empty | 3 | 4 | 15 | 21 | 3 | 0.0 | 0.000 | 0 |
| iso-clip48 | 50 | 80 | 160 | 189 | 53 | 16.0 | 0.086 | 0 |
| iso-clip441 | 50 | 77 | 154 | 188 | 52 | 16.0 | 0.081 | 0 |
| iso-clip48-sp | 50 | 77 | 159 | 160 | 52 | 16.0 | 0.084 | 0 |
| iso-clip441-sp | 64 | 115 | 215 | 216 | 68 | 16.0 | 0.077 | 0 |
| iso-stream48 | 39 | 80 | 128 | 142 | 41 | 16.0 | 0.108 | 0 |
| iso-stream441 | 40 | 72 | 149 | 207 | 42 | 16.0 | 0.129 | 0 |
| iso-clip48-64 | 190 | 261 | 315 | 343 | 195 | 64.0 | 0.194 | 0 |
| iso-clip441-64 | 193 | 259 | 437 | 564 | 198 | 64.0 | 0.170 | 0 |

### Music delta, wasm (scene minus its twin without the music voices; us per quantum; % of the 2667 us quantum)

| scene | d p50 | d p99 | d p99.9 | d mean | d mean % of quantum |
|---|---:|---:|---:|---:|---:|
| mus-typ (vs mus-typ-base) | 45 | 131 | 903 | 54 | 2.04 |
| mus-trans (vs mus-trans-base) | 46 | 1,263 | -978 | 61 | 2.27 |
| mus-worst (vs mus-worst-base) | 110 | 120 | 251 | 102 | 3.82 |
| mus-worst-split (vs mus-worst-base) | 863 | 1,674 | 7,635 | 956 | 35.85 |

### Q4 per-voice cost, wasm ((scene mean - iso-empty mean) / voices; ns per voice per quantum; mean, not p50)

| scene | voices | source | ns / voice / quantum |
|---|---:|---|---:|
| iso-clip48 | 16 | decoded, 48 kHz, non-spatial | 3,101 |
| iso-clip441 | 16 | decoded, 44.1 kHz, non-spatial | 3,082 |
| iso-clip48-sp | 16 | decoded, 48 kHz, spatial (equal-power) | 3,085 |
| iso-clip441-sp | 16 | decoded, 44.1 kHz, spatial (equal-power) | 4,039 |
| iso-stream48 | 16 | stream ring, 48 kHz, non-spatial | 2,396 |
| iso-stream441 | 16 | stream ring, 44.1 kHz, non-spatial | 2,470 |
| iso-clip48-64 | 64 | decoded, 48 kHz, non-spatial | 3,002 |
| iso-clip441-64 | 64 | decoded, 44.1 kHz, non-spatial | 3,044 |

## Metered wasm (wasm instructions per quantum: deterministic, identical on every machine and load; 4 s run, seed 1)

| scene | instr/quantum | p99 | max |
|---|---:|---:|---:|
| mus-typ-base | 33,415,462 | 34,592,808 | 34,682,376 |
| mus-typ | 33,867,083 | 35,048,992 | 35,142,956 |
| mus-trans-base | 32,744,801 | 33,919,476 | 34,030,944 |
| mus-trans | 33,733,585 | 34,928,552 | 35,007,024 |
| mus-worst-base | 35,230,547 | 37,245,840 | 37,334,112 |
| mus-worst | 36,546,584 | 38,575,248 | 38,655,856 |
| mus-worst-split | 48,465,905 | 50,523,668 | 50,607,164 |
| iso-empty | 54,695 | 55,326 | 55,368 |
| iso-clip48 | 699,023 | 699,654 | 699,696 |
| iso-clip441 | 699,023 | 699,654 | 699,981 |
| iso-clip48-sp | 699,023 | 699,654 | 699,696 |
| iso-clip441-sp | 699,023 | 699,654 | 699,981 |
| iso-stream48 | 857,404 | 870,017 | 870,019 |
| iso-stream441 | 859,452 | 870,017 | 870,775 |
| iso-clip48-64 | 2,634,904 | 2,635,526 | 2,635,853 |
| iso-clip441-64 | 2,634,904 | 2,635,526 | 2,635,959 |

| scene (vs twin) | d instr/quantum | ratio | note |
|---|---:|---:|---|
| mus-typ (vs mus-typ-base) | 451,621 | 1.0135 | multiply the ratio by the twin's timed wasm mean for a load-free estimate |
| mus-trans (vs mus-trans-base) | 988,785 | 1.0302 | multiply the ratio by the twin's timed wasm mean for a load-free estimate |
| mus-worst (vs mus-worst-base) | 1,316,037 | 1.0374 | multiply the ratio by the twin's timed wasm mean for a load-free estimate |
| mus-worst-split (vs mus-worst-base) | 13,235,358 | 1.3757 | multiply the ratio by the twin's timed wasm mean for a load-free estimate |

