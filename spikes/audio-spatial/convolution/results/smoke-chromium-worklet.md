Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36

| case | wall us per quantum, median of runs | min | max | minus empty processor (median) | % of quantum | max Date.now() gap between process() calls, worst run (ms) |
|---|---|---|---|---|---|---|
| (empty processor) | 2.82 | 2.77 | 3.01 | - | - | 0 |
| single_2s_noise | 25.14 | 24.32 | 26.53 | 22.32 | 0.84 | 1 |
| single_4s_noise | 33.12 | 32.87 | 33.28 | 30.30 | 1.14 | 1 |
| m1_real_1.8s | 23.74 | 23.37 | 35.03 | 20.92 | 0.78 | 1 |
| zones_4x2s_unstaggered | 93.23 | 92.02 | 94.45 | 90.41 | 3.39 | 1 |
| zones_4x2s_staggered | 91.29 | 90.53 | 93.08 | 88.47 | 3.32 | 1 |
| zones_8x2s_unstaggered | 200.99 | 196.11 | 209.95 | 198.17 | 7.43 | 2 |
| zones_8x2s_staggered | 199.04 | 198.24 | 207.97 | 196.22 | 7.36 | 3 |
| blend_2x2s_staggered | 47.37 | 46.98 | 47.95 | 44.55 | 1.67 | 1 |
| event_256_filter_send | 313.61 | 312.68 | 327.79 | 310.79 | 11.65 | 2 |
