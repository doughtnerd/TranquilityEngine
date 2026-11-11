# S4 run 2026-11-11T18-15-37-670Z

RUNS=5 SECONDS=10 WARMUP=2 PACE=0; quantum = 128 frames at 48 kHz = 2667 us. Medians over runs. Times in us per quantum.

## Correctness checks
- native: gain_ramp PASS; clock_120bpm (worst error 0 frames over 107 beats); clock_130bpm (worst error 0 frames over 116 beats); clock_tempo_change (worst error 0 frames over 34 beats); all PASS
- wasm: gain_ramp PASS; clock_120bpm (worst error 0 frames over 107 beats); clock_130bpm (worst error 0 frames over 116 beats); clock_tempo_change (worst error 0 frames over 34 beats); all PASS

## Micro: gain_ramp (ns per call; one call = one voice (gain_ramp) or one clock-quantum set (music_clock) per 128-frame quantum; median over runs of each run's p50 / p99)

| case | native p50 | native p99 | wasm p50 | wasm p99 |
|---|---:|---:|---:|---:|
| core_settled (g=gain.next()*fade.next()) | 37.5 | 45.7 | 40.5 | 49.6 |
| copy_only (the two 128-frame copies) | 12.3 | 16.3 | 15.3 | 23.9 |
| linear_full (fade ramp running, 128 frames) | 154.8 | 194.0 | 202.5 | 243.7 |
| linear_from_sample_37 (two ranges: settled, then ramp) | 122.7 | 155.9 | 171.4 | 198.3 |
| sin (equal-power, libm sinf per sample), full, per-sample | 1,826.2 | 2,027.8 | 860.8 | 1,045.1 |
| sin (equal-power, libm sinf per sample), from_37, per-sample | 1,290.4 | 1,612.6 | 668.5 | 761.5 |
| sin (equal-power, libm sinf per sample), full, block (curve array then multiply) | 510.3 | 783.7 | 772.5 | 829.9 |
| sqrt (equal-power law g=sqrt(t)), full, per-sample | 241.2 | 263.5 | 1,080.2 | 1,790.3 |
| sqrt (equal-power law g=sqrt(t)), from_37, per-sample | 181.2 | 194.1 | 836.1 | 1,344.7 |
| sqrt (equal-power law g=sqrt(t)), full, block (curve array then multiply) | 264.1 | 345.5 | 1,058.1 | 1,412.1 |
| smoothstep (S-curve, polynomial), full, per-sample | 287.9 | 353.5 | 446.2 | 496.7 |
| smoothstep (S-curve, polynomial), from_37, per-sample | 234.6 | 275.8 | 374.0 | 638.3 |
| smoothstep (S-curve, polynomial), full, block (curve array then multiply) | 268.6 | 362.9 | 462.2 | 720.4 |
| lut1024 (equal-power table, lerp), full, per-sample | 533.6 | 754.5 | 683.4 | 776.8 |
| lut1024 (equal-power table, lerp), from_37, per-sample | 422.1 | 545.9 | 542.0 | 721.0 |
| lut1024 (equal-power table, lerp), full, block (curve array then multiply) | 522.1 | 759.9 | 666.4 | 871.2 |

## Micro: music_clock (ns per call; one call = one voice (gain_ramp) or one clock-quantum set (music_clock) per 128-frame quantum; median over runs of each run's p50 / p99)

| case | native p50 | native p99 | wasm p50 | wasm p99 |
|---|---:|---:|---:|---:|
| 1 instance(s), 1 tempo segment(s), cached segment | 4.7 | 5.9 | 7.7 | 13.3 |
| 8 instance(s), 1 tempo segment(s), cached segment | 34.7 | 40.7 | 58.1 | 74.9 |
| 1 instance(s), 8 tempo segment(s), cached segment | 5.0 | 7.8 | 7.8 | 9.6 |
| 8 instance(s), 8 tempo segment(s), cached segment | 36.5 | 43.3 | 58.2 | 81.2 |
| 1 instance(s), 64 tempo segment(s), cached segment | 5.0 | 6.7 | 7.7 | 10.4 |
| 8 instance(s), 64 tempo segment(s), cached segment | 37.5 | 45.3 | 58.2 | 102.3 |
| 1 instance(s), 8 tempo segment(s), binary search every quantum | 8.1 | 15.9 | 11.2 | 20.1 |
| 8 instance(s), 8 tempo segment(s), binary search every quantum | 62.3 | 88.4 | 85.3 | 147.7 |
| 1 instance(s), 64 tempo segment(s), binary search every quantum | 13.2 | 23.5 | 16.9 | 21.0 |
| 8 instance(s), 64 tempo segment(s), binary search every quantum | 105.6 | 135.5 | 133.1 | 190.9 |

## Scenes, native (median over 5 runs of each run's statistic, us per quantum)

| scene | p50 | p99 | p99.9 | max | mean | mixed | peak | starved |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| mus-typ-base | 1,676 | 2,604 | 3,354 | 7,227 | 1,731 | 250.4 | 0.301 | 0 |
| mus-typ | 1,719 | 2,778 | 4,437 | 6,738 | 1,794 | 254.4 | 0.314 | 0 |
| mus-trans-base | 1,639 | 2,578 | 3,623 | 4,844 | 1,710 | 240.4 | 0.306 | 0 |
| mus-trans | 1,714 | 2,724 | 4,017 | 5,359 | 1,790 | 254.4 | 0.319 | 0 |
| mus-worst-base | 1,914 | 2,953 | 4,147 | 7,786 | 1,970 | 234.5 | 0.125 | 0 |
| mus-worst | 2,013 | 2,981 | 3,730 | 6,180 | 2,061 | 254.4 | 0.198 | 0 |
| mus-worst-split | 2,452 | 4,072 | 5,801 | 9,263 | 2,541 | 254.4 | 0.196 | 0 |
| mus-trans-nofade | 1,673 | 2,582 | 3,554 | 6,865 | 1,716 | 254.4 | 0.348 | 0 |
| mus-worst-nofade | 1,938 | 2,880 | 4,198 | 7,802 | 1,997 | 254.4 | 0.246 | 0 |
| mus-typ-nofade | 1,729 | 2,467 | 3,645 | 6,729 | 1,760 | 254.4 | 0.313 | 0 |
| mus-typ-fades4 | 1,717 | 2,618 | 3,621 | 5,279 | 1,772 | 254.4 | 0.313 | 0 |
| mus-typ-ramp | 1,688 | 2,717 | 4,180 | 7,844 | 1,748 | 254.4 | 0.314 | 0 |
| iso-empty | 1 | 2 | 17 | 36 | 1 | 0.0 | 0.000 | 0 |
| iso-clip48 | 36 | 58 | 101 | 157 | 38 | 16.0 | 0.090 | 0 |
| iso-clip441 | 36 | 59 | 103 | 497 | 38 | 16.0 | 0.083 | 0 |
| iso-clip48-sp | 36 | 60 | 113 | 262 | 38 | 16.0 | 0.090 | 0 |
| iso-clip441-sp | 36 | 59 | 105 | 247 | 38 | 16.0 | 0.088 | 0 |
| iso-stream48 | 45 | 76 | 116 | 315 | 48 | 16.0 | 0.108 | 0 |
| iso-stream441 | 45 | 69 | 97 | 131 | 47 | 16.0 | 0.129 | 0 |
| iso-clip48-64 | 144 | 235 | 442 | 775 | 152 | 64.0 | 0.191 | 0 |
| iso-clip441-64 | 142 | 226 | 389 | 988 | 149 | 64.0 | 0.175 | 0 |

### Music delta, native (scene minus its twin without the music voices; us per quantum; % of the 2667 us quantum)

| scene | d p50 | d p99 | d p99.9 | d mean | d mean % of quantum |
|---|---:|---:|---:|---:|---:|
| mus-typ (vs mus-typ-base) | 43 | 174 | 1,083 | 63 | 2.38 |
| mus-trans (vs mus-trans-base) | 75 | 145 | 394 | 79 | 2.98 |
| mus-worst (vs mus-worst-base) | 99 | 29 | -417 | 91 | 3.41 |
| mus-worst-split (vs mus-worst-base) | 538 | 1,119 | 1,654 | 570 | 21.39 |
| mus-trans-nofade (vs mus-trans-base) | 34 | 3 | -69 | 5 | 0.19 |
| mus-worst-nofade (vs mus-worst-base) | 24 | -73 | 51 | 26 | 0.99 |
| mus-typ-nofade (vs mus-typ-base) | 53 | -137 | 291 | 29 | 1.08 |
| mus-typ-fades4 (vs mus-typ-base) | 41 | 14 | 267 | 41 | 1.54 |
| mus-typ-ramp (vs mus-typ-base) | 12 | 113 | 827 | 17 | 0.65 |

### Q4 per-voice cost, native ((scene mean - iso-empty mean) / voices; ns per voice per quantum; mean, not p50)

| scene | voices | source | ns / voice / quantum |
|---|---:|---|---:|
| iso-clip48 | 16 | decoded, 48 kHz, non-spatial | 2,269 |
| iso-clip441 | 16 | decoded, 44.1 kHz, non-spatial | 2,283 |
| iso-clip48-sp | 16 | decoded, 48 kHz, spatial (equal-power) | 2,304 |
| iso-clip441-sp | 16 | decoded, 44.1 kHz, spatial (equal-power) | 2,296 |
| iso-stream48 | 16 | stream ring, 48 kHz, non-spatial | 2,912 |
| iso-stream441 | 16 | stream ring, 44.1 kHz, non-spatial | 2,860 |
| iso-clip48-64 | 64 | decoded, 48 kHz, non-spatial | 2,358 |
| iso-clip441-64 | 64 | decoded, 44.1 kHz, non-spatial | 2,302 |

## Scenes, wasm (median over 5 runs of each run's statistic, us per quantum)

| scene | p50 | p99 | p99.9 | max | mean | mixed | peak | starved |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| mus-typ-base | 2,193 | 3,327 | 4,797 | 7,523 | 2,258 | 250.4 | 0.301 | 0 |
| mus-typ | 2,232 | 3,320 | 3,892 | 7,437 | 2,289 | 254.4 | 0.314 | 0 |
| mus-trans-base | 2,169 | 3,612 | 5,465 | 7,060 | 2,306 | 240.4 | 0.306 | 0 |
| mus-trans | 2,237 | 3,754 | 5,530 | 6,753 | 2,342 | 254.4 | 0.319 | 0 |
| mus-worst-base | 2,338 | 3,926 | 6,335 | 8,343 | 2,448 | 234.5 | 0.125 | 0 |
| mus-worst | 2,434 | 3,965 | 6,340 | 9,906 | 2,540 | 254.4 | 0.198 | 0 |
| mus-worst-split | 3,149 | 5,044 | 6,756 | 11,141 | 3,262 | 254.4 | 0.196 | 0 |
| mus-trans-nofade | 2,208 | 3,687 | 5,409 | 7,729 | 2,333 | 254.4 | 0.348 | 0 |
| mus-worst-nofade | 2,418 | 3,960 | 5,275 | 7,945 | 2,582 | 254.4 | 0.246 | 0 |
| mus-typ-nofade | 2,232 | 3,864 | 5,222 | 7,188 | 2,409 | 254.4 | 0.313 | 0 |
| mus-typ-fades4 | 2,256 | 3,654 | 5,068 | 7,530 | 2,353 | 254.4 | 0.313 | 0 |
| mus-typ-ramp | 2,202 | 3,537 | 5,365 | 8,332 | 2,314 | 254.4 | 0.314 | 0 |
| iso-empty | 2 | 4 | 20 | 70 | 2 | 0.0 | 0.000 | 0 |
| iso-clip48 | 50 | 86 | 519 | 1,735 | 54 | 16.0 | 0.090 | 0 |
| iso-clip441 | 50 | 77 | 115 | 586 | 53 | 16.0 | 0.083 | 0 |
| iso-clip48-sp | 49 | 87 | 111 | 127 | 53 | 16.0 | 0.090 | 0 |
| iso-clip441-sp | 49 | 70 | 110 | 262 | 51 | 16.0 | 0.088 | 0 |
| iso-stream48 | 39 | 75 | 171 | 246 | 42 | 16.0 | 0.108 | 0 |
| iso-stream441 | 39 | 72 | 129 | 249 | 42 | 16.0 | 0.129 | 0 |
| iso-clip48-64 | 193 | 283 | 513 | 1,400 | 202 | 64.0 | 0.191 | 0 |
| iso-clip441-64 | 195 | 320 | 517 | 1,823 | 208 | 64.0 | 0.175 | 0 |

### Music delta, wasm (scene minus its twin without the music voices; us per quantum; % of the 2667 us quantum)

| scene | d p50 | d p99 | d p99.9 | d mean | d mean % of quantum |
|---|---:|---:|---:|---:|---:|
| mus-typ (vs mus-typ-base) | 39 | -7 | -905 | 31 | 1.16 |
| mus-trans (vs mus-trans-base) | 68 | 141 | 66 | 36 | 1.36 |
| mus-worst (vs mus-worst-base) | 96 | 39 | 6 | 92 | 3.44 |
| mus-worst-split (vs mus-worst-base) | 810 | 1,117 | 421 | 813 | 30.49 |
| mus-trans-nofade (vs mus-trans-base) | 38 | 75 | -55 | 28 | 1.04 |
| mus-worst-nofade (vs mus-worst-base) | 80 | 34 | -1,060 | 134 | 5.01 |
| mus-typ-nofade (vs mus-typ-base) | 39 | 537 | 425 | 151 | 5.66 |
| mus-typ-fades4 (vs mus-typ-base) | 63 | 328 | 271 | 95 | 3.57 |
| mus-typ-ramp (vs mus-typ-base) | 9 | 210 | 568 | 56 | 2.09 |

### Q4 per-voice cost, wasm ((scene mean - iso-empty mean) / voices; ns per voice per quantum; mean, not p50)

| scene | voices | source | ns / voice / quantum |
|---|---:|---|---:|
| iso-clip48 | 16 | decoded, 48 kHz, non-spatial | 3,231 |
| iso-clip441 | 16 | decoded, 44.1 kHz, non-spatial | 3,135 |
| iso-clip48-sp | 16 | decoded, 48 kHz, spatial (equal-power) | 3,183 |
| iso-clip441-sp | 16 | decoded, 44.1 kHz, spatial (equal-power) | 3,047 |
| iso-stream48 | 16 | stream ring, 48 kHz, non-spatial | 2,462 |
| iso-stream441 | 16 | stream ring, 44.1 kHz, non-spatial | 2,462 |
| iso-clip48-64 | 64 | decoded, 48 kHz, non-spatial | 3,117 |
| iso-clip441-64 | 64 | decoded, 44.1 kHz, non-spatial | 3,214 |

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

