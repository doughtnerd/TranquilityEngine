| case | n | samples | p50 us | p99 us | p99.9 us | max us | p50 % | p99.9 % | max % | worst-run p99.9 us | mem/zone KB | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single_1s_noise | 1 | 10000 | 12.7 | 45.9 | 77.0 | 506.5 | 0.48 | 2.89 | 18.99 | 240.1 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_1s_room | 1 | 10000 | 13.4 | 60.3 | 86.2 | 172.9 | 0.50 | 3.23 | 6.48 | 90.8 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_2s_noise | 1 | 10000 | 17.8 | 60.3 | 102.1 | 525.0 | 0.67 | 3.83 | 19.69 | 349.2 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_2s_room | 1 | 10000 | 17.3 | 48.7 | 65.9 | 266.9 | 0.65 | 2.47 | 10.01 | 95.1 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_4s_noise | 1 | 10000 | 27.2 | 58.7 | 128.1 | 375.4 | 1.02 | 4.80 | 14.08 | 165.8 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| single_4s_room | 1 | 10000 | 27.9 | 73.3 | 110.1 | 714.9 | 1.05 | 4.13 | 26.81 | 230.8 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| m1_real_1.8s | 1 | 10000 | 17.2 | 50.2 | 67.1 | 143.9 | 0.65 | 2.52 | 5.40 | 71.8 | 2945 |  |
| zones_1x2s_unstaggered | 1 | 10000 | 17.0 | 51.7 | 119.3 | 673.4 | 0.64 | 4.47 | 25.25 | 317.8 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_1x2s_staggered | 1 | 10000 | 15.4 | 48.7 | 78.2 | 228.8 | 0.58 | 2.93 | 8.58 | 134.7 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x2s_unstaggered | 2 | 10000 | 35.1 | 90.9 | 115.2 | 157.9 | 1.32 | 4.32 | 5.92 | 126.5 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_2x2s_staggered | 2 | 10000 | 41.8 | 70.8 | 135.1 | 285.7 | 1.57 | 5.06 | 10.71 | 252.8 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_4x2s_unstaggered | 4 | 10000 | 77.0 | 191.0 | 300.2 | 926.1 | 2.89 | 11.26 | 34.73 | 411.4 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_4x2s_staggered | 4 | 10000 | 93.9 | 187.5 | 465.1 | 2183.2 | 3.52 | 17.44 | 81.87 | 1217.3 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_4x2s_unique | 4 | 10000 | 100.3 | 196.3 | 295.1 | 497.2 | 3.76 | 11.07 | 18.65 | 380.5 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 2.9 FFT-eq |
| zones_8x2s_unstaggered | 8 | 10000 | 189.7 | 569.8 | 2279.1 | 6292.0 | 7.11 | 85.47 | 235.95 | 2915.2 | 3137 | tail FFTs in busiest quantum 8; modelled busiest quantum 9.4 FFT-eq |
| zones_8x2s_staggered | 8 | 10000 | 196.2 | 325.5 | 899.4 | 2375.7 | 7.36 | 33.73 | 89.09 | 1382.0 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_8x2s_unique | 8 | 10000 | 173.8 | 323.3 | 472.0 | 2123.9 | 6.52 | 17.70 | 79.65 | 1036.7 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 7.4 FFT-eq |
| zones_1x4s_unstaggered | 1 | 10000 | 26.7 | 53.7 | 68.4 | 147.5 | 1.00 | 2.57 | 5.53 | 84.6 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| zones_1x4s_staggered | 1 | 10000 | 27.8 | 53.3 | 78.9 | 151.9 | 1.04 | 2.96 | 5.70 | 84.6 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x4s_unstaggered | 2 | 10000 | 54.5 | 96.6 | 124.0 | 830.4 | 2.04 | 4.65 | 31.14 | 309.9 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| zones_2x4s_staggered | 2 | 10000 | 56.9 | 117.3 | 261.6 | 1012.5 | 2.13 | 9.81 | 37.97 | 393.5 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| zones_4x4s_unstaggered | 4 | 10000 | 121.9 | 247.0 | 358.3 | 1390.7 | 4.57 | 13.44 | 52.15 | 633.4 | 6145 | tail FFTs in busiest quantum 4; modelled busiest quantum 5.4 FFT-eq |
| zones_4x4s_staggered | 4 | 10000 | 126.0 | 220.8 | 307.5 | 2228.6 | 4.72 | 11.53 | 83.57 | 416.5 | 6145 | tail FFTs in busiest quantum 3; modelled busiest quantum 3.8 FFT-eq |
| zones_4x4s_unique | 4 | 10000 | 146.4 | 256.2 | 379.6 | 3508.5 | 5.49 | 14.23 | 131.57 | 680.3 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 4.9 FFT-eq |
| zones_8x4s_unstaggered | 8 | 10000 | 249.8 | 403.2 | 884.5 | 2315.2 | 9.37 | 33.17 | 86.82 | 1053.3 | 6145 | tail FFTs in busiest quantum 8; modelled busiest quantum 10.9 FFT-eq |
| zones_8x4s_staggered | 8 | 10000 | 264.1 | 490.7 | 1272.5 | 3438.7 | 9.90 | 47.72 | 128.95 | 1967.7 | 6145 | tail FFTs in busiest quantum 7; modelled busiest quantum 7.1 FFT-eq |
| zones_8x4s_unique | 8 | 10000 | 226.7 | 739.4 | 1993.1 | 3498.9 | 8.50 | 74.74 | 131.21 | 2581.3 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 13.0 FFT-eq |
| blend_2x2s_unstaggered | 2 | 10000 | 35.7 | 89.8 | 107.2 | 694.2 | 1.34 | 4.02 | 26.03 | 109.8 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| blend_2x2s_staggered | 2 | 10000 | 41.0 | 67.2 | 86.3 | 291.9 | 1.54 | 3.24 | 10.95 | 183.9 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| blend_2x4s_unstaggered | 2 | 10000 | 54.8 | 127.7 | 170.9 | 751.5 | 2.05 | 6.41 | 28.18 | 259.9 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| blend_2x4s_staggered | 2 | 10000 | 59.4 | 119.7 | 147.6 | 708.7 | 2.23 | 5.54 | 26.58 | 246.0 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| prep_atonce_1s | 1 | 500 | 1319.4 | 1907.2 | 2677.7 | 2677.7 | - | - | - | 2677.7 | 768 |  |
| prep_atonce_2s | 1 | 500 | 2788.5 | 5475.8 | 7650.6 | 7650.6 | - | - | - | 7650.6 | 1504 |  |
| prep_atonce_4s | 1 | 500 | 5289.5 | 8333.6 | 10014.0 | 10014.0 | - | - | - | 10014.0 | 3008 |  |
| prep_spread_1s_u1 | 1 | 10000 | 31.8 | 67.8 | 81.4 | 359.1 | 1.19 | 3.05 | 13.47 | 85.7 | 1665 | 120 units, 120 quanta to prepare |
| prep_spread_1s_u2 | 1 | 10000 | 35.1 | 91.7 | 114.3 | 529.7 | 1.32 | 4.29 | 19.86 | 126.9 | 1665 | 120 units, 60 quanta to prepare |
| prep_spread_1s_u4 | 1 | 10000 | 55.3 | 147.1 | 230.5 | 643.6 | 2.07 | 8.64 | 24.14 | 307.0 | 1665 | 120 units, 30 quanta to prepare |
| prep_spread_2s_u1 | 1 | 10000 | 37.7 | 79.6 | 152.7 | 644.0 | 1.41 | 5.73 | 24.15 | 267.7 | 3137 | 178 units, 178 quanta to prepare |
| prep_spread_2s_u2 | 1 | 10000 | 59.0 | 136.4 | 201.1 | 730.4 | 2.21 | 7.54 | 27.39 | 234.5 | 3137 | 178 units, 89 quanta to prepare |
| prep_spread_2s_u4 | 1 | 10000 | 100.7 | 200.0 | 300.1 | 2169.7 | 3.77 | 11.25 | 81.36 | 438.1 | 3137 | 178 units, 45 quanta to prepare |
| prep_spread_4s_u1 | 1 | 10000 | 50.0 | 82.3 | 105.1 | 227.0 | 1.88 | 3.94 | 8.51 | 123.3 | 6145 | 295 units, 295 quanta to prepare |
| prep_spread_4s_u2 | 1 | 10000 | 67.8 | 102.8 | 117.0 | 200.9 | 2.54 | 4.39 | 7.54 | 126.5 | 6145 | 295 units, 148 quanta to prepare |
| prep_spread_4s_u4 | 1 | 10000 | 117.3 | 160.2 | 183.4 | 432.4 | 4.40 | 6.88 | 16.21 | 191.7 | 6145 | 295 units, 74 quanta to prepare |
| event_16_route_only | 16 | 10000 | 3.2 | 5.5 | 24.0 | 36.1 | 0.12 | 0.90 | 1.35 | 25.5 | - |  |
| event_16_filter | 16 | 10000 | 17.1 | 33.3 | 46.9 | 76.5 | 0.64 | 1.76 | 2.87 | 52.7 | - |  |
| event_16_filter_send | 16 | 10000 | 19.1 | 43.1 | 59.8 | 78.9 | 0.72 | 2.24 | 2.96 | 68.5 | - |  |
| event_16_filter_send_auto | 16 | 10000 | 18.5 | 35.6 | 51.1 | 155.4 | 0.69 | 1.92 | 5.83 | 54.7 | - |  |
| event_64_route_only | 64 | 10000 | 15.2 | 35.1 | 46.7 | 87.6 | 0.57 | 1.75 | 3.28 | 47.3 | - |  |
| event_64_filter | 64 | 10000 | 70.4 | 97.4 | 118.4 | 218.2 | 2.64 | 4.44 | 8.18 | 129.6 | - |  |
| event_64_filter_send | 64 | 10000 | 70.8 | 96.9 | 205.9 | 842.1 | 2.66 | 7.72 | 31.58 | 331.8 | - |  |
| event_64_filter_send_auto | 64 | 10000 | 78.9 | 105.0 | 144.4 | 306.4 | 2.96 | 5.41 | 11.49 | 168.3 | - |  |
| event_256_route_only | 256 | 10000 | 66.4 | 96.2 | 114.0 | 159.8 | 2.49 | 4.27 | 5.99 | 143.4 | - |  |
| event_256_filter | 256 | 10000 | 302.3 | 410.7 | 1312.1 | 2404.3 | 11.34 | 49.20 | 90.16 | 2364.8 | - |  |
| event_256_filter_send | 256 | 10000 | 308.7 | 453.7 | 574.1 | 1049.7 | 11.58 | 21.53 | 39.36 | 610.8 | - |  |
| event_256_filter_send_auto | 256 | 10000 | 323.4 | 465.0 | 526.0 | 848.4 | 12.13 | 19.73 | 31.81 | 615.2 | - |  |

(5 runs, >= 2000 quanta per run; % of a 2666.7 us quantum; samples pooled over runs)
