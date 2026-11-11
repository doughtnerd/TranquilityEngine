Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36

| case | wall us per quantum, median of runs | min | max | minus empty processor (median) | % of quantum | max Date.now() gap between process() calls, worst run (ms) |
|---|---|---|---|---|---|---|
| (empty processor) | 2.88 | 2.88 | 2.93 | - | - | 0 |
| single_2s_noise | 26.21 | 26.00 | 26.48 | 23.33 | 0.88 | 1 |
| single_4s_noise | 35.62 | 34.52 | 37.55 | 32.74 | 1.23 | 5 |
| m1_real_1.8s | 25.84 | 24.02 | 28.39 | 22.96 | 0.86 | 3 |
| zones_4x2s_unstaggered | 96.54 | 95.74 | 98.67 | 93.66 | 3.51 | 2 |
| zones_4x2s_staggered | 99.78 | 99.23 | 101.18 | 96.90 | 3.63 | 5 |
| zones_8x2s_unstaggered | 210.21 | 209.51 | 213.91 | 207.33 | 7.77 | 5 |
| zones_8x2s_staggered | 222.60 | 207.78 | 223.67 | 219.72 | 8.24 | 6 |
| blend_2x2s_staggered | 46.69 | 45.45 | 48.65 | 43.81 | 1.64 | 1 |
| event_256_filter_send | 520.15 | 519.19 | 521.61 | 517.28 | 19.40 | 5 |
