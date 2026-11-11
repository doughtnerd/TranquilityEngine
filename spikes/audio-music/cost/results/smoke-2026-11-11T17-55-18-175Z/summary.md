# S4 run 2026-11-11T17-55-18-175Z (SMOKE: 1 run x 2 s, plumbing only, not timing)

RUNS=1 SECONDS=2 WARMUP=1 PACE=0; quantum = 128 frames at 48 kHz = 2667 us. Medians over runs. Times in us per quantum.

## Correctness checks
- native: gain_ramp PASS; clock_120bpm (worst error 0 frames over 107 beats); clock_130bpm (worst error 0 frames over 116 beats); clock_tempo_change (worst error 0 frames over 34 beats); all PASS
- wasm: gain_ramp PASS; clock_120bpm (worst error 0 frames over 107 beats); clock_130bpm (worst error 0 frames over 116 beats); clock_tempo_change (worst error 0 frames over 34 beats); all PASS

## Micro: gain_ramp (ns per call; one call = one voice (gain_ramp) or one clock-quantum set (music_clock) per 128-frame quantum; median over runs of each run's p50 / p99)

| case | native p50 | native p99 | wasm p50 | wasm p99 |
|---|---:|---:|---:|---:|
| core_settled (g=gain.next()*fade.next()) | 36.4 | 37.9 | 40.5 | 66.2 |
| copy_only (the two 128-frame copies) | 12.1 | 12.9 | 16.3 | 117.1 |
| linear_full (fade ramp running, 128 frames) | 279.0 | 301.0 | 202.6 | 242.0 |
| linear_from_sample_37 (two ranges: settled, then ramp) | 104.7 | 105.3 | 175.3 | 232.5 |
| sin (equal-power, libm sinf per sample), full, per-sample | 1,828.8 | 1,893.4 | 897.9 | 1,077.5 |
| sin (equal-power, libm sinf per sample), from_37, per-sample | 1,284.5 | 1,356.9 | 665.2 | 707.2 |
| sin (equal-power, libm sinf per sample), full, block (curve array then multiply) | 655.2 | 681.6 | 915.1 | 1,243.9 |
| sqrt (equal-power law g=sqrt(t)), full, per-sample | 236.4 | 237.1 | 1,064.6 | 1,069.2 |
| sqrt (equal-power law g=sqrt(t)), from_37, per-sample | 195.4 | 247.9 | 794.8 | 814.7 |
| sqrt (equal-power law g=sqrt(t)), full, block (curve array then multiply) | 308.8 | 378.1 | 1,060.7 | 1,193.8 |
| smoothstep (S-curve, polynomial), full, per-sample | 324.2 | 350.6 | 456.9 | 503.2 |
| smoothstep (S-curve, polynomial), from_37, per-sample | 194.6 | 201.7 | 353.7 | 383.0 |
| smoothstep (S-curve, polynomial), full, block (curve array then multiply) | 347.5 | 377.2 | 490.4 | 518.7 |
| lut1024 (equal-power table, lerp), full, per-sample | 513.8 | 548.4 | 670.3 | 779.9 |
| lut1024 (equal-power table, lerp), from_37, per-sample | 397.9 | 430.0 | 530.2 | 558.8 |
| lut1024 (equal-power table, lerp), full, block (curve array then multiply) | 496.5 | 529.1 | 678.7 | 733.4 |

## Micro: music_clock (ns per call; one call = one voice (gain_ramp) or one clock-quantum set (music_clock) per 128-frame quantum; median over runs of each run's p50 / p99)

| case | native p50 | native p99 | wasm p50 | wasm p99 |
|---|---:|---:|---:|---:|
| 1 instance(s), 1 tempo segment(s), cached segment | 4.7 | 4.9 | 8.8 | 9.2 |
| 8 instance(s), 1 tempo segment(s), cached segment | 37.2 | 43.3 | 60.4 | 60.7 |
| 1 instance(s), 8 tempo segment(s), cached segment | 5.1 | 5.3 | 8.8 | 9.0 |
| 8 instance(s), 8 tempo segment(s), cached segment | 35.9 | 36.1 | 61.0 | 95.0 |
| 1 instance(s), 64 tempo segment(s), cached segment | 5.1 | 5.3 | 8.9 | 9.2 |
| 8 instance(s), 64 tempo segment(s), cached segment | 36.6 | 36.8 | 60.5 | 71.8 |
| 1 instance(s), 8 tempo segment(s), binary search every quantum | 7.9 | 8.1 | 11.6 | 11.8 |
| 8 instance(s), 8 tempo segment(s), binary search every quantum | 60.5 | 83.4 | 82.0 | 82.3 |
| 1 instance(s), 64 tempo segment(s), binary search every quantum | 12.6 | 12.9 | 15.9 | 16.3 |
| 8 instance(s), 64 tempo segment(s), binary search every quantum | 98.7 | 99.5 | 118.3 | 127.2 |

## Scenes, native (median over 1 runs of each run's statistic, us per quantum)

| scene | p50 | p99 | p99.9 | max | mean | mixed | peak | starved |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| mus-typ-base | 1,655 | 2,120 | 2,542 | 2,725 | 1,676 | 250.4 | 0.299 | 0 |
| mus-typ | 1,691 | 2,535 | 2,591 | 2,623 | 1,720 | 254.4 | 0.326 | 0 |
| mus-trans-base | 1,639 | 2,653 | 2,751 | 2,771 | 1,753 | 240.5 | 0.268 | 0 |
| mus-trans | 1,698 | 2,478 | 3,264 | 3,863 | 1,734 | 254.4 | 0.298 | 0 |
| mus-worst-base | 1,855 | 2,636 | 2,906 | 7,904 | 1,903 | 234.5 | 0.144 | 0 |
| mus-worst | 1,978 | 3,069 | 5,935 | 9,995 | 2,067 | 254.5 | 0.206 | 0 |
| mus-worst-split | 2,730 | 3,842 | 4,718 | 5,454 | 2,769 | 254.5 | 0.202 | 0 |
| mus-trans-nofade | 1,675 | 2,401 | 2,883 | 3,191 | 1,712 | 254.4 | 0.310 | 0 |
| mus-worst-nofade | 1,943 | 3,258 | 4,021 | 4,059 | 2,043 | 254.5 | 0.250 | 0 |
| iso-empty | 1 | 2 | 5 | 5 | 1 | 0.0 | 0.000 | 0 |
| iso-clip48 | 36 | 73 | 113 | 133 | 38 | 16.0 | 0.086 | 0 |
| iso-clip441 | 36 | 65 | 257 | 1,092 | 40 | 16.0 | 0.081 | 0 |
| iso-clip48-sp | 36 | 62 | 92 | 177 | 38 | 16.0 | 0.084 | 0 |
| iso-clip441-sp | 47 | 74 | 86 | 91 | 45 | 16.0 | 0.077 | 0 |
| iso-stream48 | 45 | 73 | 92 | 99 | 47 | 16.0 | 0.108 | 0 |
| iso-stream441 | 45 | 74 | 106 | 106 | 48 | 16.0 | 0.129 | 0 |
| iso-clip48-64 | 143 | 237 | 437 | 665 | 149 | 64.0 | 0.194 | 0 |
| iso-clip441-64 | 142 | 229 | 411 | 419 | 148 | 64.0 | 0.170 | 0 |

### Music delta, native (scene minus its twin without the music voices; us per quantum; % of the 2667 us quantum)

| scene | d p50 | d p99 | d p99.9 | d mean | d mean % of quantum |
|---|---:|---:|---:|---:|---:|
| mus-typ (vs mus-typ-base) | 35 | 415 | 50 | 45 | 1.68 |
| mus-trans (vs mus-trans-base) | 59 | -174 | 514 | -19 | -0.71 |
| mus-worst (vs mus-worst-base) | 123 | 433 | 3,029 | 163 | 6.13 |
| mus-worst-split (vs mus-worst-base) | 875 | 1,206 | 1,812 | 865 | 32.45 |
| mus-trans-nofade (vs mus-trans-base) | 35 | -251 | 132 | -41 | -1.55 |
| mus-worst-nofade (vs mus-worst-base) | 88 | 621 | 1,115 | 140 | 5.25 |

### Q4 per-voice cost, native ((scene mean - iso-empty mean) / voices; ns per voice per quantum; mean, not p50)

| scene | voices | source | ns / voice / quantum |
|---|---:|---|---:|
| iso-clip48 | 16 | decoded, 48 kHz, non-spatial | 2,296 |
| iso-clip441 | 16 | decoded, 44.1 kHz, non-spatial | 2,394 |
| iso-clip48-sp | 16 | decoded, 48 kHz, spatial (equal-power) | 2,289 |
| iso-clip441-sp | 16 | decoded, 44.1 kHz, spatial (equal-power) | 2,733 |
| iso-stream48 | 16 | stream ring, 48 kHz, non-spatial | 2,858 |
| iso-stream441 | 16 | stream ring, 44.1 kHz, non-spatial | 2,938 |
| iso-clip48-64 | 64 | decoded, 48 kHz, non-spatial | 2,311 |
| iso-clip441-64 | 64 | decoded, 44.1 kHz, non-spatial | 2,293 |

## Scenes, wasm (median over 1 runs of each run's statistic, us per quantum)

| scene | p50 | p99 | p99.9 | max | mean | mixed | peak | starved |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| mus-typ-base | 2,182 | 3,306 | 5,278 | 9,455 | 2,271 | 250.4 | 0.299 | 0 |
| mus-typ | 2,238 | 3,290 | 5,662 | 6,273 | 2,314 | 254.4 | 0.326 | 0 |
| mus-trans-base | 2,145 | 2,849 | 3,267 | 4,243 | 2,174 | 240.5 | 0.268 | 0 |
| mus-trans | 2,210 | 3,847 | 5,036 | 5,646 | 2,300 | 254.4 | 0.298 | 0 |
| mus-worst-base | 2,329 | 3,580 | 4,289 | 4,514 | 2,433 | 234.5 | 0.144 | 0 |
| mus-worst | 2,421 | 3,499 | 4,341 | 5,255 | 2,457 | 254.5 | 0.206 | 0 |
| mus-worst-split | 3,101 | 4,471 | 4,628 | 4,736 | 3,160 | 254.5 | 0.202 | 0 |
| mus-trans-nofade | 2,204 | 3,329 | 4,488 | 4,892 | 2,353 | 254.4 | 0.310 | 0 |
| mus-worst-nofade | 2,427 | 3,494 | 4,988 | 5,591 | 2,513 | 254.5 | 0.250 | 0 |
| iso-empty | 2 | 3 | 14 | 23 | 2 | 0.0 | 0.000 | 0 |
| iso-clip48 | 63 | 89 | 164 | 171 | 62 | 16.0 | 0.086 | 0 |
| iso-clip441 | 50 | 154 | 248 | 305 | 57 | 16.0 | 0.081 | 0 |
| iso-clip48-sp | 51 | 77 | 89 | 104 | 54 | 16.0 | 0.084 | 0 |
| iso-clip441-sp | 49 | 72 | 80 | 87 | 51 | 16.0 | 0.077 | 0 |
| iso-stream48 | 38 | 67 | 93 | 305 | 41 | 16.0 | 0.108 | 0 |
| iso-stream441 | 64 | 118 | 171 | 190 | 65 | 16.0 | 0.129 | 0 |
| iso-clip48-64 | 235 | 352 | 374 | 396 | 237 | 64.0 | 0.194 | 0 |
| iso-clip441-64 | 190 | 248 | 396 | 502 | 196 | 64.0 | 0.170 | 0 |

### Music delta, wasm (scene minus its twin without the music voices; us per quantum; % of the 2667 us quantum)

| scene | d p50 | d p99 | d p99.9 | d mean | d mean % of quantum |
|---|---:|---:|---:|---:|---:|
| mus-typ (vs mus-typ-base) | 55 | -15 | 385 | 44 | 1.64 |
| mus-trans (vs mus-trans-base) | 66 | 998 | 1,769 | 127 | 4.75 |
| mus-worst (vs mus-worst-base) | 91 | -81 | 52 | 23 | 0.88 |
| mus-worst-split (vs mus-worst-base) | 772 | 891 | 340 | 727 | 27.27 |
| mus-trans-nofade (vs mus-trans-base) | 60 | 480 | 1,221 | 179 | 6.71 |
| mus-worst-nofade (vs mus-worst-base) | 97 | -86 | 699 | 80 | 3.00 |

### Q4 per-voice cost, wasm ((scene mean - iso-empty mean) / voices; ns per voice per quantum; mean, not p50)

| scene | voices | source | ns / voice / quantum |
|---|---:|---|---:|
| iso-clip48 | 16 | decoded, 48 kHz, non-spatial | 3,743 |
| iso-clip441 | 16 | decoded, 44.1 kHz, non-spatial | 3,434 |
| iso-clip48-sp | 16 | decoded, 48 kHz, spatial (equal-power) | 3,245 |
| iso-clip441-sp | 16 | decoded, 44.1 kHz, spatial (equal-power) | 3,004 |
| iso-stream48 | 16 | stream ring, 48 kHz, non-spatial | 2,404 |
| iso-stream441 | 16 | stream ring, 44.1 kHz, non-spatial | 3,900 |
| iso-clip48-64 | 64 | decoded, 48 kHz, non-spatial | 3,664 |
| iso-clip441-64 | 64 | decoded, 44.1 kHz, non-spatial | 3,026 |

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

