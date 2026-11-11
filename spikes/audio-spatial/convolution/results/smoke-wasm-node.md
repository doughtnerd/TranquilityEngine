| case | n | samples | p50 us | p99 us | p99.9 us | max us | p50 % | p99.9 % | max % | worst-run p99.9 us | mem/zone KB | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single_1s_noise | 1 | 10000 | 13.9 | 63.1 | 202.7 | 348.2 | 0.52 | 7.60 | 13.06 | 256.4 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_1s_room | 1 | 10000 | 13.9 | 62.3 | 194.7 | 784.9 | 0.52 | 7.30 | 29.44 | 329.2 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_2s_noise | 1 | 10000 | 20.7 | 78.1 | 185.8 | 2232.2 | 0.78 | 6.97 | 83.71 | 495.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_2s_room | 1 | 10000 | 19.4 | 60.3 | 109.6 | 809.2 | 0.73 | 4.11 | 30.35 | 157.5 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_4s_noise | 1 | 10000 | 28.2 | 96.8 | 236.4 | 981.2 | 1.06 | 8.87 | 36.79 | 352.1 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| single_4s_room | 1 | 10000 | 27.5 | 73.3 | 214.7 | 866.8 | 1.03 | 8.05 | 32.51 | 277.2 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| m1_real_1.8s | 1 | 10000 | 16.1 | 45.8 | 64.5 | 350.6 | 0.60 | 2.42 | 13.15 | 75.6 | 2945 |  |
| zones_1x2s_unstaggered | 1 | 10000 | 17.3 | 47.9 | 62.5 | 522.8 | 0.65 | 2.34 | 19.61 | 65.4 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_1x2s_staggered | 1 | 10000 | 16.0 | 50.4 | 68.5 | 133.3 | 0.60 | 2.57 | 5.00 | 95.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x2s_unstaggered | 2 | 10000 | 36.6 | 121.3 | 209.4 | 2151.0 | 1.37 | 7.85 | 80.66 | 2094.3 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_2x2s_staggered | 2 | 10000 | 44.8 | 99.9 | 150.8 | 1114.4 | 1.68 | 5.65 | 41.79 | 280.5 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_4x2s_unstaggered | 4 | 10000 | 79.2 | 257.7 | 316.3 | 1230.0 | 2.97 | 11.86 | 46.12 | 370.0 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_4x2s_staggered | 4 | 10000 | 92.6 | 194.3 | 324.1 | 2171.5 | 3.47 | 12.15 | 81.43 | 2167.0 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_4x2s_unique | 4 | 10000 | 101.7 | 155.3 | 217.2 | 3952.3 | 3.81 | 8.14 | 148.21 | 290.9 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 2.9 FFT-eq |
| zones_8x2s_unstaggered | 8 | 10000 | 190.5 | 580.4 | 908.3 | 3250.4 | 7.14 | 34.06 | 121.89 | 2344.9 | 3137 | tail FFTs in busiest quantum 8; modelled busiest quantum 9.4 FFT-eq |
| zones_8x2s_staggered | 8 | 10000 | 207.4 | 457.2 | 1469.6 | 2369.1 | 7.78 | 55.11 | 88.84 | 2255.5 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_8x2s_unique | 8 | 10000 | 190.4 | 427.6 | 525.1 | 2499.2 | 7.14 | 19.69 | 93.72 | 2366.6 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 7.4 FFT-eq |
| zones_1x4s_unstaggered | 1 | 10000 | 26.6 | 53.6 | 63.3 | 273.2 | 1.00 | 2.37 | 10.24 | 63.9 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| zones_1x4s_staggered | 1 | 10000 | 26.8 | 48.5 | 60.1 | 295.6 | 1.01 | 2.25 | 11.08 | 77.0 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x4s_unstaggered | 2 | 10000 | 56.5 | 109.4 | 262.2 | 833.0 | 2.12 | 9.83 | 31.24 | 481.5 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| zones_2x4s_staggered | 2 | 10000 | 59.7 | 102.9 | 193.6 | 1198.3 | 2.24 | 7.26 | 44.93 | 243.8 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| zones_4x4s_unstaggered | 4 | 10000 | 126.2 | 294.1 | 1078.5 | 4278.5 | 4.73 | 40.45 | 160.44 | 2211.5 | 6145 | tail FFTs in busiest quantum 4; modelled busiest quantum 5.4 FFT-eq |
| zones_4x4s_staggered | 4 | 10000 | 127.6 | 186.8 | 625.7 | 2232.6 | 4.79 | 23.46 | 83.72 | 2078.6 | 6145 | tail FFTs in busiest quantum 3; modelled busiest quantum 3.8 FFT-eq |
| zones_4x4s_unique | 4 | 10000 | 151.6 | 240.4 | 320.4 | 526.8 | 5.68 | 12.02 | 19.75 | 359.8 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 4.9 FFT-eq |
| zones_8x4s_unstaggered | 8 | 10000 | 259.3 | 408.8 | 557.5 | 1518.9 | 9.72 | 20.91 | 56.96 | 635.8 | 6145 | tail FFTs in busiest quantum 8; modelled busiest quantum 10.9 FFT-eq |
| zones_8x4s_staggered | 8 | 10000 | 263.0 | 314.6 | 355.4 | 700.0 | 9.86 | 13.33 | 26.25 | 376.8 | 6145 | tail FFTs in busiest quantum 7; modelled busiest quantum 7.1 FFT-eq |
| zones_8x4s_unique | 8 | 10000 | 231.8 | 552.6 | 972.6 | 1763.2 | 8.69 | 36.47 | 66.12 | 1197.3 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 13.0 FFT-eq |
| blend_2x2s_unstaggered | 2 | 10000 | 36.6 | 97.3 | 127.9 | 547.1 | 1.37 | 4.80 | 20.52 | 137.5 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| blend_2x2s_staggered | 2 | 10000 | 43.6 | 78.2 | 99.8 | 350.1 | 1.64 | 3.74 | 13.13 | 104.9 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| blend_2x4s_unstaggered | 2 | 10000 | 56.7 | 107.4 | 143.5 | 297.9 | 2.13 | 5.38 | 11.17 | 210.7 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| blend_2x4s_staggered | 2 | 10000 | 61.7 | 123.8 | 433.7 | 3017.0 | 2.31 | 16.26 | 113.14 | 1943.0 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| prep_atonce_1s | 1 | 500 | 1467.2 | 3054.9 | 4287.2 | 4287.2 | - | - | - | 4287.2 | 768 |  |
| prep_atonce_2s | 1 | 500 | 2881.6 | 5116.3 | 5305.2 | 5305.2 | - | - | - | 5305.2 | 1504 |  |
| prep_atonce_4s | 1 | 500 | 5846.4 | 9379.2 | 13177.5 | 13177.5 | - | - | - | 13177.5 | 3008 |  |
| prep_spread_1s_u1 | 1 | 10000 | 34.3 | 74.5 | 117.3 | 1538.8 | 1.28 | 4.40 | 57.71 | 146.1 | 1665 | 120 units, 120 quanta to prepare |
| prep_spread_1s_u2 | 1 | 10000 | 38.0 | 117.2 | 169.9 | 2177.9 | 1.42 | 6.37 | 81.67 | 260.6 | 1665 | 120 units, 60 quanta to prepare |
| prep_spread_1s_u4 | 1 | 10000 | 58.3 | 165.8 | 340.6 | 1246.7 | 2.19 | 12.77 | 46.75 | 494.5 | 1665 | 120 units, 30 quanta to prepare |
| prep_spread_2s_u1 | 1 | 10000 | 39.9 | 97.0 | 126.2 | 155.8 | 1.50 | 4.73 | 5.84 | 136.5 | 3137 | 178 units, 178 quanta to prepare |
| prep_spread_2s_u2 | 1 | 10000 | 61.0 | 100.8 | 163.5 | 2139.8 | 2.29 | 6.13 | 80.24 | 262.4 | 3137 | 178 units, 89 quanta to prepare |
| prep_spread_2s_u4 | 1 | 10000 | 108.9 | 238.3 | 348.6 | 2853.0 | 4.09 | 13.07 | 106.99 | 1132.4 | 3137 | 178 units, 45 quanta to prepare |
| prep_spread_4s_u1 | 1 | 10000 | 55.4 | 138.4 | 244.5 | 5949.9 | 2.08 | 9.17 | 223.12 | 1460.9 | 6145 | 295 units, 295 quanta to prepare |
| prep_spread_4s_u2 | 1 | 10000 | 75.6 | 122.1 | 206.0 | 1033.5 | 2.84 | 7.72 | 38.76 | 325.9 | 6145 | 295 units, 148 quanta to prepare |
| prep_spread_4s_u4 | 1 | 10000 | 125.9 | 209.2 | 293.7 | 1651.0 | 4.72 | 11.01 | 61.91 | 910.0 | 6145 | 295 units, 74 quanta to prepare |
| event_16_route_only | 16 | 10000 | 11.2 | 26.6 | 33.0 | 54.1 | 0.42 | 1.24 | 2.03 | 33.4 | - |  |
| event_16_filter | 16 | 10000 | 26.3 | 42.8 | 49.3 | 96.7 | 0.99 | 1.85 | 3.63 | 56.9 | - |  |
| event_16_filter_send | 16 | 10000 | 26.0 | 44.7 | 89.0 | 2145.3 | 0.97 | 3.34 | 80.45 | 2096.9 | - |  |
| event_16_filter_send_auto | 16 | 10000 | 27.4 | 65.3 | 255.0 | 10185.3 | 1.03 | 9.56 | 381.95 | 2079.3 | - |  |
| event_64_route_only | 64 | 10000 | 47.5 | 122.5 | 280.1 | 3171.5 | 1.78 | 10.50 | 118.93 | 2149.6 | - |  |
| event_64_filter | 64 | 10000 | 110.8 | 209.6 | 432.8 | 1544.5 | 4.15 | 16.23 | 57.92 | 574.5 | - |  |
| event_64_filter_send | 64 | 10000 | 107.3 | 183.9 | 239.1 | 287.7 | 4.02 | 8.96 | 10.79 | 276.8 | - |  |
| event_64_filter_send_auto | 64 | 10000 | 112.3 | 186.0 | 462.0 | 1223.5 | 4.21 | 17.33 | 45.88 | 577.7 | - |  |
| event_256_route_only | 256 | 10000 | 217.9 | 310.3 | 441.5 | 1780.8 | 8.17 | 16.56 | 66.78 | 676.0 | - |  |
| event_256_filter | 256 | 10000 | 458.5 | 715.6 | 1231.7 | 8494.9 | 17.19 | 46.19 | 318.56 | 1491.4 | - |  |
| event_256_filter_send | 256 | 10000 | 465.9 | 766.8 | 2161.1 | 9482.1 | 17.47 | 81.04 | 355.58 | 3794.7 | - |  |
| event_256_filter_send_auto | 256 | 10000 | 478.7 | 812.0 | 1274.7 | 5576.1 | 17.95 | 47.80 | 209.10 | 2515.7 | - |  |

(node v22.23.4 wasm (+simd128): 5 runs, >= 2000 quanta per run; % of a 2666.7 us quantum; samples pooled over runs; clock pair overhead 0.07 us included)
