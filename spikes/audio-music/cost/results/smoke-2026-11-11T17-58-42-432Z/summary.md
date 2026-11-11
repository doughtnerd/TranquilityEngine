# S4 run 2026-11-11T17-58-42-432Z (SMOKE: 1 run x 2 s, plumbing only, not timing)

RUNS=1 SECONDS=2 WARMUP=1 PACE=0; quantum = 128 frames at 48 kHz = 2667 us. Medians over runs. Times in us per quantum.

## Correctness checks
- native: gain_ramp PASS; clock_120bpm (worst error 0 frames over 107 beats); clock_130bpm (worst error 0 frames over 116 beats); clock_tempo_change (worst error 0 frames over 34 beats); all PASS
- wasm: gain_ramp PASS; clock_120bpm (worst error 0 frames over 107 beats); clock_130bpm (worst error 0 frames over 116 beats); clock_tempo_change (worst error 0 frames over 34 beats); all PASS

## Micro: gain_ramp (ns per call; one call = one voice (gain_ramp) or one clock-quantum set (music_clock) per 128-frame quantum; median over runs of each run's p50 / p99)

| case | native p50 | native p99 | wasm p50 | wasm p99 |
|---|---:|---:|---:|---:|
| core_settled (g=gain.next()*fade.next()) | 36.5 | 37.4 | 48.0 | 86.7 |
| copy_only (the two 128-frame copies) | 12.1 | 12.3 | 16.0 | 16.8 |
| linear_full (fade ramp running, 128 frames) | 154.6 | 160.2 | 194.1 | 401.6 |
| linear_from_sample_37 (two ranges: settled, then ramp) | 133.5 | 162.4 | 244.0 | 413.3 |
| sin (equal-power, libm sinf per sample), full, per-sample | 1,860.8 | 1,974.9 | 972.0 | 1,131.1 |
| sin (equal-power, libm sinf per sample), from_37, per-sample | 1,294.7 | 1,420.5 | 703.3 | 789.1 |
| sin (equal-power, libm sinf per sample), full, block (curve array then multiply) | 539.5 | 563.3 | 1,096.0 | 1,983.2 |
| sqrt (equal-power law g=sqrt(t)), full, per-sample | 236.4 | 251.4 | 1,927.2 | 2,064.8 |
| sqrt (equal-power law g=sqrt(t)), from_37, per-sample | 161.8 | 184.3 | 1,466.7 | 1,533.3 |
| sqrt (equal-power law g=sqrt(t)), full, block (curve array then multiply) | 257.3 | 283.5 | 1,756.8 | 1,819.6 |
| smoothstep (S-curve, polynomial), full, per-sample | 281.4 | 304.6 | 808.5 | 839.9 |
| smoothstep (S-curve, polynomial), from_37, per-sample | 233.7 | 272.4 | 646.7 | 674.2 |
| smoothstep (S-curve, polynomial), full, block (curve array then multiply) | 258.7 | 259.2 | 691.6 | 816.6 |
| lut1024 (equal-power table, lerp), full, per-sample | 519.7 | 548.4 | 1,358.4 | 1,421.8 |
| lut1024 (equal-power table, lerp), from_37, per-sample | 406.2 | 454.3 | 1,108.3 | 1,117.0 |
| lut1024 (equal-power table, lerp), full, block (curve array then multiply) | 505.4 | 534.9 | 1,247.1 | 1,286.4 |

## Micro: music_clock (ns per call; one call = one voice (gain_ramp) or one clock-quantum set (music_clock) per 128-frame quantum; median over runs of each run's p50 / p99)

| case | native p50 | native p99 | wasm p50 | wasm p99 |
|---|---:|---:|---:|---:|
| 1 instance(s), 1 tempo segment(s), cached segment | 4.7 | 5.0 | 16.0 | 20.6 |
| 8 instance(s), 1 tempo segment(s), cached segment | 34.2 | 34.6 | 112.5 | 160.7 |
| 1 instance(s), 8 tempo segment(s), cached segment | 5.1 | 5.2 | 17.5 | 18.9 |
| 8 instance(s), 8 tempo segment(s), cached segment | 35.9 | 43.2 | 106.8 | 117.2 |
| 1 instance(s), 64 tempo segment(s), cached segment | 5.1 | 5.1 | 17.2 | 17.9 |
| 8 instance(s), 64 tempo segment(s), cached segment | 35.8 | 35.9 | 104.6 | 108.4 |
| 1 instance(s), 8 tempo segment(s), binary search every quantum | 7.9 | 8.1 | 25.6 | 28.4 |
| 8 instance(s), 8 tempo segment(s), binary search every quantum | 60.4 | 60.7 | 164.6 | 190.6 |
| 1 instance(s), 64 tempo segment(s), binary search every quantum | 12.6 | 12.8 | 28.7 | 30.0 |
| 8 instance(s), 64 tempo segment(s), binary search every quantum | 99.2 | 121.5 | 209.0 | 240.2 |

## Scenes, native (median over 1 runs of each run's statistic, us per quantum)

| scene | p50 | p99 | p99.9 | max | mean | mixed | peak | starved |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| mus-typ-base | 1,686 | 2,922 | 4,855 | 6,668 | 1,814 | 250.4 | 0.299 | 0 |
| mus-typ | 1,692 | 2,775 | 2,840 | 3,683 | 1,745 | 254.4 | 0.326 | 0 |
| mus-trans-base | 1,647 | 2,517 | 2,571 | 2,944 | 1,722 | 240.5 | 0.268 | 0 |
| mus-trans | 1,732 | 2,598 | 2,927 | 3,857 | 1,806 | 254.4 | 0.298 | 0 |
| mus-worst-base | 1,855 | 2,843 | 3,243 | 4,395 | 1,934 | 234.5 | 0.144 | 0 |
| mus-worst | 1,981 | 3,060 | 3,434 | 4,005 | 2,030 | 254.5 | 0.206 | 0 |
| mus-worst-split | 2,432 | 4,490 | 4,581 | 5,071 | 2,494 | 254.5 | 0.202 | 0 |
| mus-trans-nofade | 1,683 | 3,065 | 3,286 | 4,353 | 1,837 | 254.4 | 0.310 | 0 |
| mus-worst-nofade | 1,957 | 2,966 | 3,503 | 4,643 | 2,004 | 254.5 | 0.250 | 0 |
| mus-typ-nofade | 1,721 | 2,788 | 3,239 | 3,568 | 1,856 | 254.4 | 0.326 | 0 |
| mus-typ-fades4 | 1,712 | 2,896 | 3,042 | 4,705 | 1,888 | 254.4 | 0.326 | 0 |
| mus-typ-ramp | 1,863 | 2,934 | 3,374 | 3,649 | 2,026 | 254.4 | 0.324 | 0 |
| iso-empty | 1 | 1 | 14 | 41 | 1 | 0.0 | 0.000 | 0 |
| iso-clip48 | 49 | 83 | 91 | 733 | 52 | 16.0 | 0.086 | 0 |
| iso-clip441 | 36 | 60 | 175 | 180 | 38 | 16.0 | 0.081 | 0 |
| iso-clip48-sp | 36 | 51 | 58 | 65 | 37 | 16.0 | 0.084 | 0 |
| iso-clip441-sp | 36 | 59 | 124 | 218 | 38 | 16.0 | 0.077 | 0 |
| iso-stream48 | 45 | 72 | 81 | 89 | 47 | 16.0 | 0.108 | 0 |
| iso-stream441 | 45 | 90 | 172 | 399 | 49 | 16.0 | 0.129 | 0 |
| iso-clip48-64 | 143 | 195 | 314 | 1,341 | 149 | 64.0 | 0.194 | 0 |
| iso-clip441-64 | 147 | 211 | 270 | 354 | 154 | 64.0 | 0.170 | 0 |

### Music delta, native (scene minus its twin without the music voices; us per quantum; % of the 2667 us quantum)

| scene | d p50 | d p99 | d p99.9 | d mean | d mean % of quantum |
|---|---:|---:|---:|---:|---:|
| mus-typ (vs mus-typ-base) | 6 | -147 | -2,016 | -70 | -2.62 |
| mus-trans (vs mus-trans-base) | 85 | 81 | 355 | 85 | 3.18 |
| mus-worst (vs mus-worst-base) | 127 | 217 | 191 | 96 | 3.60 |
| mus-worst-split (vs mus-worst-base) | 578 | 1,647 | 1,338 | 560 | 21.00 |
| mus-trans-nofade (vs mus-trans-base) | 36 | 548 | 715 | 115 | 4.31 |
| mus-worst-nofade (vs mus-worst-base) | 102 | 122 | 260 | 70 | 2.61 |
| mus-typ-nofade (vs mus-typ-base) | 35 | -134 | -1,617 | 42 | 1.56 |
| mus-typ-fades4 (vs mus-typ-base) | 26 | -26 | -1,813 | 73 | 2.75 |
| mus-typ-ramp (vs mus-typ-base) | 177 | 12 | -1,482 | 211 | 7.92 |

### Q4 per-voice cost, native ((scene mean - iso-empty mean) / voices; ns per voice per quantum; mean, not p50)

| scene | voices | source | ns / voice / quantum |
|---|---:|---|---:|
| iso-clip48 | 16 | decoded, 48 kHz, non-spatial | 3,142 |
| iso-clip441 | 16 | decoded, 44.1 kHz, non-spatial | 2,282 |
| iso-clip48-sp | 16 | decoded, 48 kHz, spatial (equal-power) | 2,233 |
| iso-clip441-sp | 16 | decoded, 44.1 kHz, spatial (equal-power) | 2,286 |
| iso-stream48 | 16 | stream ring, 48 kHz, non-spatial | 2,848 |
| iso-stream441 | 16 | stream ring, 44.1 kHz, non-spatial | 2,988 |
| iso-clip48-64 | 64 | decoded, 48 kHz, non-spatial | 2,314 |
| iso-clip441-64 | 64 | decoded, 44.1 kHz, non-spatial | 2,384 |

## Scenes, wasm (median over 1 runs of each run's statistic, us per quantum)

| scene | p50 | p99 | p99.9 | max | mean | mixed | peak | starved |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| mus-typ-base | 2,147 | 2,667 | 2,843 | 3,077 | 2,164 | 250.4 | 0.299 | 0 |
| mus-typ | 2,303 | 3,702 | 7,159 | 12,707 | 2,458 | 254.4 | 0.326 | 0 |
| mus-trans-base | 2,133 | 2,646 | 3,019 | 4,118 | 2,158 | 240.5 | 0.268 | 0 |
| mus-trans | 2,245 | 3,469 | 4,395 | 9,588 | 2,416 | 254.4 | 0.298 | 0 |
| mus-worst-base | 2,560 | 4,327 | 6,017 | 6,479 | 2,677 | 234.5 | 0.144 | 0 |
| mus-worst | 2,459 | 3,751 | 5,119 | 5,673 | 2,595 | 254.5 | 0.206 | 0 |
| mus-worst-split | 3,190 | 4,762 | 5,994 | 6,167 | 3,344 | 254.5 | 0.202 | 0 |
| mus-trans-nofade | 2,169 | 3,271 | 4,312 | 5,917 | 2,253 | 254.4 | 0.310 | 0 |
| mus-worst-nofade | 2,354 | 3,949 | 6,695 | 7,579 | 2,459 | 254.5 | 0.250 | 0 |
| mus-typ-nofade | 2,178 | 3,225 | 4,881 | 7,012 | 2,240 | 254.4 | 0.326 | 0 |
| mus-typ-fades4 | 2,185 | 3,242 | 3,450 | 3,464 | 2,212 | 254.4 | 0.326 | 0 |
| mus-typ-ramp | 2,195 | 3,378 | 4,160 | 5,319 | 2,257 | 254.4 | 0.324 | 0 |
| iso-empty | 2 | 3 | 6 | 55 | 2 | 0.0 | 0.000 | 0 |
| iso-clip48 | 49 | 68 | 77 | 78 | 50 | 16.0 | 0.086 | 0 |
| iso-clip441 | 49 | 69 | 78 | 118 | 50 | 16.0 | 0.081 | 0 |
| iso-clip48-sp | 49 | 73 | 76 | 89 | 51 | 16.0 | 0.084 | 0 |
| iso-clip441-sp | 49 | 69 | 105 | 176 | 51 | 16.0 | 0.077 | 0 |
| iso-stream48 | 38 | 68 | 78 | 85 | 41 | 16.0 | 0.108 | 0 |
| iso-stream441 | 39 | 61 | 67 | 68 | 40 | 16.0 | 0.129 | 0 |
| iso-clip48-64 | 190 | 218 | 223 | 229 | 193 | 64.0 | 0.194 | 0 |
| iso-clip441-64 | 190 | 217 | 242 | 246 | 193 | 64.0 | 0.170 | 0 |

### Music delta, wasm (scene minus its twin without the music voices; us per quantum; % of the 2667 us quantum)

| scene | d p50 | d p99 | d p99.9 | d mean | d mean % of quantum |
|---|---:|---:|---:|---:|---:|
| mus-typ (vs mus-typ-base) | 156 | 1,035 | 4,316 | 294 | 11.02 |
| mus-trans (vs mus-trans-base) | 111 | 823 | 1,376 | 258 | 9.67 |
| mus-worst (vs mus-worst-base) | -101 | -575 | -898 | -82 | -3.08 |
| mus-worst-split (vs mus-worst-base) | 630 | 436 | -23 | 667 | 24.99 |
| mus-trans-nofade (vs mus-trans-base) | 36 | 625 | 1,293 | 95 | 3.56 |
| mus-worst-nofade (vs mus-worst-base) | -205 | -378 | 679 | -218 | -8.18 |
| mus-typ-nofade (vs mus-typ-base) | 31 | 559 | 2,038 | 76 | 2.87 |
| mus-typ-fades4 (vs mus-typ-base) | 38 | 576 | 608 | 48 | 1.79 |
| mus-typ-ramp (vs mus-typ-base) | 48 | 711 | 1,318 | 93 | 3.48 |

### Q4 per-voice cost, wasm ((scene mean - iso-empty mean) / voices; ns per voice per quantum; mean, not p50)

| scene | voices | source | ns / voice / quantum |
|---|---:|---|---:|
| iso-clip48 | 16 | decoded, 48 kHz, non-spatial | 2,983 |
| iso-clip441 | 16 | decoded, 44.1 kHz, non-spatial | 2,998 |
| iso-clip48-sp | 16 | decoded, 48 kHz, spatial (equal-power) | 3,006 |
| iso-clip441-sp | 16 | decoded, 44.1 kHz, spatial (equal-power) | 3,019 |
| iso-stream48 | 16 | stream ring, 48 kHz, non-spatial | 2,387 |
| iso-stream441 | 16 | stream ring, 44.1 kHz, non-spatial | 2,369 |
| iso-clip48-64 | 64 | decoded, 48 kHz, non-spatial | 2,979 |
| iso-clip441-64 | 64 | decoded, 44.1 kHz, non-spatial | 2,970 |

## Metered wasm (wasm instructions per quantum: deterministic, identical on every machine and load; 4 s run, seed 1)

| scene | instr/quantum | p99 | max |
|---|---:|---:|---:|
| mus-typ-base | 33,408,892 | 34,586,236 | 34,675,808 |
| mus-typ | 33,860,513 | 35,042,420 | 35,136,384 |
| mus-trans-base | 32,738,231 | 33,912,908 | 34,024,372 |
| mus-trans | 33,727,015 | 34,921,980 | 35,000,452 |
| mus-worst-base | 35,223,977 | 37,239,272 | 37,327,540 |
| mus-worst | 36,540,014 | 38,568,680 | 38,649,288 |
| mus-worst-split | 48,459,335 | 50,517,096 | 50,600,592 |
| mus-trans-nofade | 33,445,562 | 34,623,608 | 34,697,904 |
| mus-worst-nofade | 36,249,259 | 38,268,588 | 38,321,592 |
| mus-typ-nofade | 33,615,286 | 34,797,664 | 34,889,288 |
| mus-typ-fades4 | 33,864,360 | 35,050,488 | 35,142,348 |
| mus-typ-ramp | 33,621,694 | 34,804,844 | 34,898,160 |
| iso-empty | 48,125 | 48,756 | 48,798 |
| iso-clip48 | 692,453 | 693,084 | 693,126 |
| iso-clip441 | 692,453 | 693,084 | 693,411 |
| iso-clip48-sp | 692,453 | 693,084 | 693,126 |
| iso-clip441-sp | 692,453 | 693,084 | 693,411 |
| iso-stream48 | 850,834 | 863,447 | 863,449 |
| iso-stream441 | 852,882 | 863,447 | 864,205 |
| iso-clip48-64 | 2,628,334 | 2,628,956 | 2,629,283 |
| iso-clip441-64 | 2,628,334 | 2,628,956 | 2,629,389 |

| scene (vs twin) | d instr/quantum | ratio | note |
|---|---:|---:|---|
| mus-typ (vs mus-typ-base) | 451,621 | 1.0135 | multiply the ratio by the twin's timed wasm mean for a load-free estimate |
| mus-trans (vs mus-trans-base) | 988,785 | 1.0302 | multiply the ratio by the twin's timed wasm mean for a load-free estimate |
| mus-worst (vs mus-worst-base) | 1,316,037 | 1.0374 | multiply the ratio by the twin's timed wasm mean for a load-free estimate |
| mus-worst-split (vs mus-worst-base) | 13,235,358 | 1.3757 | multiply the ratio by the twin's timed wasm mean for a load-free estimate |
| mus-trans-nofade (vs mus-trans-base) | 707,332 | 1.0216 | multiply the ratio by the twin's timed wasm mean for a load-free estimate |
| mus-worst-nofade (vs mus-worst-base) | 1,025,282 | 1.0291 | multiply the ratio by the twin's timed wasm mean for a load-free estimate |
| mus-typ-nofade (vs mus-typ-base) | 206,394 | 1.0062 | multiply the ratio by the twin's timed wasm mean for a load-free estimate |
| mus-typ-fades4 (vs mus-typ-base) | 455,468 | 1.0136 | multiply the ratio by the twin's timed wasm mean for a load-free estimate |
| mus-typ-ramp (vs mus-typ-base) | 212,803 | 1.0064 | multiply the ratio by the twin's timed wasm mean for a load-free estimate |

