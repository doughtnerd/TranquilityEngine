| case | n | samples | p50 us | p99 us | p99.9 us | max us | p50 % | p99.9 % | max % | worst-run p99.9 us | mem/zone KB | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single_1s_noise | 1 | 10000 | 12.8 | 42.7 | 54.2 | 444.4 | 0.48 | 2.03 | 16.67 | 57.6 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_1s_room | 1 | 10000 | 12.5 | 41.4 | 51.2 | 58.9 | 0.47 | 1.92 | 2.21 | 54.5 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_2s_noise | 1 | 10000 | 17.8 | 47.7 | 75.3 | 730.5 | 0.67 | 2.82 | 27.39 | 447.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_2s_room | 1 | 10000 | 17.4 | 45.2 | 56.5 | 581.1 | 0.65 | 2.12 | 21.79 | 57.5 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_4s_noise | 1 | 10000 | 28.0 | 73.2 | 166.0 | 1156.1 | 1.05 | 6.22 | 43.36 | 212.0 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| single_4s_room | 1 | 10000 | 26.9 | 52.2 | 64.4 | 181.2 | 1.01 | 2.42 | 6.80 | 66.0 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| m1_real_1.8s | 1 | 10000 | 16.3 | 45.7 | 59.7 | 455.7 | 0.61 | 2.24 | 17.09 | 84.8 | 2945 |  |
| zones_1x2s_unstaggered | 1 | 10000 | 17.7 | 46.2 | 57.9 | 375.8 | 0.66 | 2.17 | 14.09 | 59.6 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_1x2s_staggered | 1 | 10000 | 15.8 | 43.9 | 56.9 | 178.2 | 0.59 | 2.13 | 6.68 | 63.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x2s_unstaggered | 2 | 10000 | 36.3 | 88.5 | 119.2 | 201.6 | 1.36 | 4.47 | 7.56 | 179.4 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_2x2s_staggered | 2 | 10000 | 45.2 | 70.7 | 83.3 | 111.0 | 1.69 | 3.13 | 4.16 | 94.2 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_4x2s_unstaggered | 4 | 10000 | 80.7 | 256.9 | 317.1 | 628.6 | 3.03 | 11.89 | 23.57 | 343.2 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_4x2s_staggered | 4 | 10000 | 91.4 | 169.2 | 245.6 | 631.3 | 3.43 | 9.21 | 23.67 | 273.9 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_4x2s_unique | 4 | 10000 | 102.5 | 139.3 | 160.5 | 684.1 | 3.84 | 6.02 | 25.65 | 224.1 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 2.9 FFT-eq |
| zones_8x2s_unstaggered | 8 | 10000 | 177.5 | 350.1 | 386.3 | 711.5 | 6.66 | 14.49 | 26.68 | 401.2 | 3137 | tail FFTs in busiest quantum 8; modelled busiest quantum 9.4 FFT-eq |
| zones_8x2s_staggered | 8 | 10000 | 200.6 | 252.9 | 289.9 | 2899.6 | 7.52 | 10.87 | 108.73 | 732.3 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_8x2s_unique | 8 | 10000 | 176.7 | 320.6 | 395.3 | 938.8 | 6.62 | 14.82 | 35.21 | 440.0 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 7.4 FFT-eq |
| zones_1x4s_unstaggered | 1 | 10000 | 28.2 | 62.6 | 120.5 | 645.5 | 1.06 | 4.52 | 24.20 | 137.2 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| zones_1x4s_staggered | 1 | 10000 | 29.2 | 63.8 | 91.8 | 339.2 | 1.10 | 3.44 | 12.72 | 129.8 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x4s_unstaggered | 2 | 10000 | 57.4 | 106.2 | 138.7 | 688.4 | 2.15 | 5.20 | 25.81 | 216.5 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| zones_2x4s_staggered | 2 | 10000 | 58.6 | 97.5 | 139.0 | 560.4 | 2.20 | 5.21 | 21.02 | 181.9 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| zones_4x4s_unstaggered | 4 | 10000 | 126.4 | 265.2 | 362.8 | 2583.3 | 4.74 | 13.60 | 96.88 | 530.6 | 6145 | tail FFTs in busiest quantum 4; modelled busiest quantum 5.4 FFT-eq |
| zones_4x4s_staggered | 4 | 10000 | 130.5 | 179.5 | 535.2 | 5728.5 | 4.89 | 20.07 | 214.82 | 959.0 | 6145 | tail FFTs in busiest quantum 3; modelled busiest quantum 3.8 FFT-eq |
| zones_4x4s_unique | 4 | 10000 | 148.3 | 227.2 | 415.9 | 1490.1 | 5.56 | 15.60 | 55.88 | 800.6 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 4.9 FFT-eq |
| zones_8x4s_unstaggered | 8 | 10000 | 252.3 | 422.7 | 629.3 | 2509.6 | 9.46 | 23.60 | 94.11 | 656.9 | 6145 | tail FFTs in busiest quantum 8; modelled busiest quantum 10.9 FFT-eq |
| zones_8x4s_staggered | 8 | 10000 | 266.3 | 462.6 | 654.5 | 1185.0 | 9.99 | 24.55 | 44.44 | 888.2 | 6145 | tail FFTs in busiest quantum 7; modelled busiest quantum 7.1 FFT-eq |
| zones_8x4s_unique | 8 | 10000 | 213.8 | 466.5 | 538.0 | 1770.7 | 8.02 | 20.17 | 66.40 | 795.1 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 13.0 FFT-eq |
| blend_2x2s_unstaggered | 2 | 10000 | 36.8 | 133.4 | 173.4 | 2494.0 | 1.38 | 6.50 | 93.53 | 487.1 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| blend_2x2s_staggered | 2 | 10000 | 42.6 | 67.9 | 116.3 | 699.2 | 1.60 | 4.36 | 26.22 | 602.2 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| blend_2x4s_unstaggered | 2 | 10000 | 57.2 | 140.2 | 196.0 | 962.7 | 2.15 | 7.35 | 36.10 | 217.4 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| blend_2x4s_staggered | 2 | 10000 | 58.4 | 94.6 | 151.0 | 558.8 | 2.19 | 5.66 | 20.95 | 419.3 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| prep_atonce_1s | 1 | 500 | 1404.3 | 2488.4 | 2648.0 | 2648.0 | - | - | - | 2648.0 | 768 |  |
| prep_atonce_2s | 1 | 500 | 2702.4 | 4984.4 | 5728.8 | 5728.8 | - | - | - | 5728.8 | 1504 |  |
| prep_atonce_4s | 1 | 500 | 5206.9 | 7546.2 | 8737.0 | 8737.0 | - | - | - | 8737.0 | 3008 |  |
| prep_spread_1s_u1 | 1 | 10000 | 31.0 | 61.1 | 73.1 | 871.9 | 1.16 | 2.74 | 32.70 | 89.4 | 1665 | 120 units, 120 quanta to prepare |
| prep_spread_1s_u2 | 1 | 10000 | 38.6 | 144.5 | 196.5 | 2099.3 | 1.45 | 7.37 | 78.72 | 253.9 | 1665 | 120 units, 60 quanta to prepare |
| prep_spread_1s_u4 | 1 | 10000 | 59.4 | 211.2 | 255.2 | 670.6 | 2.23 | 9.57 | 25.15 | 265.4 | 1665 | 120 units, 30 quanta to prepare |
| prep_spread_2s_u1 | 1 | 10000 | 38.7 | 70.7 | 87.0 | 120.1 | 1.45 | 3.26 | 4.50 | 92.9 | 3137 | 178 units, 178 quanta to prepare |
| prep_spread_2s_u2 | 1 | 10000 | 60.9 | 91.7 | 105.7 | 125.6 | 2.29 | 3.96 | 4.71 | 110.0 | 3137 | 178 units, 89 quanta to prepare |
| prep_spread_2s_u4 | 1 | 10000 | 105.6 | 155.0 | 232.2 | 2182.7 | 3.96 | 8.71 | 81.85 | 2160.4 | 3137 | 178 units, 45 quanta to prepare |
| prep_spread_4s_u1 | 1 | 10000 | 48.4 | 85.1 | 181.6 | 266.9 | 1.82 | 6.81 | 10.01 | 257.2 | 6145 | 295 units, 295 quanta to prepare |
| prep_spread_4s_u2 | 1 | 10000 | 71.1 | 148.9 | 192.1 | 259.0 | 2.67 | 7.20 | 9.71 | 234.2 | 6145 | 295 units, 148 quanta to prepare |
| prep_spread_4s_u4 | 1 | 10000 | 115.7 | 164.5 | 471.6 | 1486.2 | 4.34 | 17.69 | 55.73 | 714.3 | 6145 | 295 units, 74 quanta to prepare |
| event_16_route_only | 16 | 10000 | 3.1 | 6.7 | 26.7 | 47.0 | 0.12 | 1.00 | 1.76 | 30.0 | - |  |
| event_16_filter | 16 | 10000 | 16.1 | 31.2 | 41.5 | 52.4 | 0.60 | 1.56 | 1.97 | 42.2 | - |  |
| event_16_filter_send | 16 | 10000 | 16.5 | 31.2 | 38.8 | 50.8 | 0.62 | 1.46 | 1.90 | 41.5 | - |  |
| event_16_filter_send_auto | 16 | 10000 | 19.1 | 34.5 | 45.2 | 57.2 | 0.72 | 1.69 | 2.15 | 51.1 | - |  |
| event_64_route_only | 64 | 10000 | 14.0 | 34.1 | 45.4 | 58.7 | 0.53 | 1.70 | 2.20 | 46.6 | - |  |
| event_64_filter | 64 | 10000 | 70.4 | 95.2 | 112.1 | 148.5 | 2.64 | 4.20 | 5.57 | 117.2 | - |  |
| event_64_filter_send | 64 | 10000 | 67.2 | 97.3 | 116.0 | 861.4 | 2.52 | 4.35 | 32.30 | 301.0 | - |  |
| event_64_filter_send_auto | 64 | 10000 | 71.4 | 100.4 | 116.3 | 304.1 | 2.68 | 4.36 | 11.40 | 123.0 | - |  |
| event_256_route_only | 256 | 10000 | 62.4 | 96.6 | 134.0 | 770.2 | 2.34 | 5.02 | 28.88 | 148.0 | - |  |
| event_256_filter | 256 | 10000 | 294.7 | 369.3 | 656.6 | 1580.8 | 11.05 | 24.62 | 59.28 | 805.4 | - |  |
| event_256_filter_send | 256 | 10000 | 302.5 | 416.1 | 518.5 | 731.5 | 11.35 | 19.45 | 27.43 | 560.3 | - |  |
| event_256_filter_send_auto | 256 | 10000 | 323.9 | 474.0 | 927.5 | 2556.3 | 12.15 | 34.78 | 95.86 | 2404.3 | - |  |

(node v22.23.4 wasm (+simd128): 5 runs, >= 2000 quanta per run; % of a 2666.7 us quantum; samples pooled over runs; clock pair overhead 0.07 us included)
