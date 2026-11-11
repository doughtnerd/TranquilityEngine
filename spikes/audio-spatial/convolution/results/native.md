| case | n | samples | p50 us | p99 us | p99.9 us | max us | p50 % | p99.9 % | max % | worst-run p99.9 us | mem/zone KB | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single_1s_noise | 1 | 140000 | 12.1 | 54.7 | 88.6 | 1117.4 | 0.45 | 3.32 | 41.90 | 101.7 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_1s_room | 1 | 140000 | 12.4 | 57.7 | 106.4 | 4144.9 | 0.47 | 3.99 | 155.43 | 222.7 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_2s_noise | 1 | 140000 | 16.7 | 57.7 | 72.7 | 3105.6 | 0.63 | 2.73 | 116.46 | 118.7 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_2s_room | 1 | 140000 | 17.6 | 66.2 | 120.1 | 1895.3 | 0.66 | 4.50 | 71.07 | 216.2 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_4s_noise | 1 | 140000 | 29.3 | 75.8 | 121.5 | 2118.9 | 1.10 | 4.55 | 79.46 | 188.9 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| single_4s_room | 1 | 140000 | 30.7 | 80.0 | 172.0 | 2203.5 | 1.15 | 6.45 | 82.63 | 304.6 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| m1_real_1.8s | 1 | 140000 | 17.7 | 62.7 | 143.4 | 2481.7 | 0.67 | 5.38 | 93.06 | 620.0 | 2945 |  |
| zones_1x2s_unstaggered | 1 | 140000 | 18.0 | 63.7 | 118.7 | 2701.0 | 0.67 | 4.45 | 101.29 | 198.7 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_1x2s_staggered | 1 | 140000 | 17.1 | 66.4 | 111.2 | 8281.5 | 0.64 | 4.17 | 310.56 | 189.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x2s_unstaggered | 2 | 140000 | 38.6 | 133.1 | 265.9 | 9595.5 | 1.45 | 9.97 | 359.83 | 418.4 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_2x2s_staggered | 2 | 140000 | 46.9 | 105.7 | 184.3 | 3199.7 | 1.76 | 6.91 | 119.99 | 314.1 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_4x2s_unstaggered | 4 | 140000 | 86.1 | 225.9 | 402.9 | 4214.9 | 3.23 | 15.11 | 158.06 | 524.8 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_4x2s_staggered | 4 | 140000 | 100.9 | 204.1 | 358.3 | 3921.9 | 3.79 | 13.44 | 147.07 | 578.5 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_4x2s_unique | 4 | 140000 | 112.1 | 227.7 | 556.0 | 6823.9 | 4.21 | 20.85 | 255.90 | 901.1 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 2.9 FFT-eq |
| zones_8x2s_unstaggered | 8 | 140000 | 222.4 | 491.0 | 985.1 | 5427.3 | 8.34 | 36.94 | 203.52 | 1447.5 | 3137 | tail FFTs in busiest quantum 8; modelled busiest quantum 9.4 FFT-eq |
| zones_8x2s_staggered | 8 | 140000 | 229.1 | 393.7 | 758.6 | 6302.9 | 8.59 | 28.45 | 236.36 | 1017.8 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_8x2s_unique | 8 | 140000 | 199.7 | 462.7 | 767.0 | 3945.0 | 7.49 | 28.76 | 147.94 | 951.2 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 7.4 FFT-eq |
| zones_1x4s_unstaggered | 1 | 140000 | 30.4 | 82.0 | 176.4 | 5511.5 | 1.14 | 6.62 | 206.68 | 301.6 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| zones_1x4s_staggered | 1 | 140000 | 29.9 | 83.8 | 238.3 | 5007.0 | 1.12 | 8.94 | 187.76 | 377.9 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x4s_unstaggered | 2 | 140000 | 63.0 | 148.2 | 334.3 | 3884.7 | 2.36 | 12.53 | 145.68 | 393.5 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| zones_2x4s_staggered | 2 | 140000 | 62.2 | 134.6 | 288.4 | 8147.9 | 2.33 | 10.81 | 305.55 | 317.8 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| zones_4x4s_unstaggered | 4 | 140000 | 148.3 | 294.1 | 567.4 | 11478.2 | 5.56 | 21.28 | 430.43 | 656.6 | 6145 | tail FFTs in busiest quantum 4; modelled busiest quantum 5.4 FFT-eq |
| zones_4x4s_staggered | 4 | 140000 | 148.7 | 275.2 | 553.7 | 6284.6 | 5.58 | 20.76 | 235.67 | 1239.0 | 6145 | tail FFTs in busiest quantum 3; modelled busiest quantum 3.8 FFT-eq |
| zones_4x4s_unique | 4 | 140000 | 166.5 | 299.3 | 526.7 | 2797.3 | 6.25 | 19.75 | 104.90 | 806.3 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 4.9 FFT-eq |
| zones_8x4s_unstaggered | 8 | 140000 | 367.5 | 641.1 | 1198.9 | 9679.2 | 13.78 | 44.96 | 362.97 | 1568.1 | 6145 | tail FFTs in busiest quantum 8; modelled busiest quantum 10.9 FFT-eq |
| zones_8x4s_staggered | 8 | 140000 | 394.4 | 709.3 | 1395.0 | 8881.0 | 14.79 | 52.31 | 333.04 | 1939.4 | 6145 | tail FFTs in busiest quantum 7; modelled busiest quantum 7.1 FFT-eq |
| zones_8x4s_unique | 8 | 140000 | 326.2 | 1117.8 | 1946.3 | 15116.0 | 12.23 | 72.99 | 566.85 | 2374.9 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 13.0 FFT-eq |
| blend_2x2s_unstaggered | 2 | 140000 | 42.7 | 126.9 | 378.4 | 4012.3 | 1.60 | 14.19 | 150.46 | 906.0 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| blend_2x2s_staggered | 2 | 140000 | 44.4 | 99.3 | 202.0 | 2139.2 | 1.67 | 7.58 | 80.22 | 276.8 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| blend_2x4s_unstaggered | 2 | 140000 | 63.3 | 138.8 | 273.9 | 2309.6 | 2.37 | 10.27 | 86.61 | 370.3 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| blend_2x4s_staggered | 2 | 140000 | 62.9 | 131.7 | 306.5 | 9474.6 | 2.36 | 11.49 | 355.30 | 476.4 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| prep_atonce_1s | 1 | 7000 | 1267.0 | 2136.9 | 3404.1 | 5303.5 | - | - | - | 3470.1 | 768 |  |
| prep_atonce_2s | 1 | 7000 | 2524.1 | 4249.2 | 6480.9 | 8616.0 | - | - | - | 7616.4 | 1504 |  |
| prep_atonce_4s | 1 | 7000 | 5272.6 | 8316.5 | 12680.5 | 15471.4 | - | - | - | 14668.1 | 3008 |  |
| prep_spread_1s_u1 | 1 | 140000 | 28.6 | 79.5 | 178.5 | 3164.5 | 1.07 | 6.69 | 118.67 | 309.3 | 1665 | 120 units, 120 quanta to prepare |
| prep_spread_1s_u2 | 1 | 140000 | 33.6 | 111.3 | 178.5 | 1888.0 | 1.26 | 6.69 | 70.80 | 255.8 | 1665 | 120 units, 60 quanta to prepare |
| prep_spread_1s_u4 | 1 | 140000 | 51.3 | 168.7 | 250.2 | 3505.0 | 1.93 | 9.38 | 131.44 | 282.5 | 1665 | 120 units, 30 quanta to prepare |
| prep_spread_2s_u1 | 1 | 140000 | 36.5 | 86.8 | 143.9 | 3657.8 | 1.37 | 5.40 | 137.17 | 201.5 | 3137 | 178 units, 178 quanta to prepare |
| prep_spread_2s_u2 | 1 | 140000 | 58.6 | 111.3 | 189.3 | 2345.9 | 2.20 | 7.10 | 87.97 | 234.4 | 3137 | 178 units, 89 quanta to prepare |
| prep_spread_2s_u4 | 1 | 140000 | 89.8 | 181.2 | 325.5 | 5519.1 | 3.37 | 12.21 | 206.97 | 436.3 | 3137 | 178 units, 45 quanta to prepare |
| prep_spread_4s_u1 | 1 | 140000 | 52.1 | 104.7 | 181.5 | 3149.8 | 1.95 | 6.81 | 118.12 | 275.7 | 6145 | 295 units, 295 quanta to prepare |
| prep_spread_4s_u2 | 1 | 140000 | 72.0 | 137.5 | 306.7 | 3892.0 | 2.70 | 11.50 | 145.95 | 363.5 | 6145 | 295 units, 148 quanta to prepare |
| prep_spread_4s_u4 | 1 | 140000 | 117.0 | 213.8 | 366.9 | 4067.4 | 4.39 | 13.76 | 152.53 | 697.9 | 6145 | 295 units, 74 quanta to prepare |
| event_16_route_only | 16 | 140000 | 4.0 | 13.0 | 45.9 | 2469.5 | 0.15 | 1.72 | 92.61 | 58.4 | - |  |
| event_16_filter | 16 | 140000 | 16.8 | 46.5 | 76.3 | 1853.7 | 0.63 | 2.86 | 69.51 | 95.5 | - |  |
| event_16_filter_send | 16 | 140000 | 17.2 | 49.3 | 108.9 | 4121.7 | 0.64 | 4.08 | 154.56 | 175.2 | - |  |
| event_16_filter_send_auto | 16 | 140000 | 18.0 | 49.7 | 79.4 | 3071.0 | 0.67 | 2.98 | 115.16 | 99.9 | - |  |
| event_64_route_only | 64 | 140000 | 18.2 | 60.4 | 98.1 | 3029.5 | 0.68 | 3.68 | 113.61 | 154.8 | - |  |
| event_64_filter | 64 | 140000 | 69.1 | 122.3 | 224.4 | 3237.2 | 2.59 | 8.41 | 121.40 | 264.9 | - |  |
| event_64_filter_send | 64 | 140000 | 73.4 | 128.2 | 198.1 | 2860.0 | 2.75 | 7.43 | 107.25 | 244.9 | - |  |
| event_64_filter_send_auto | 64 | 140000 | 73.9 | 125.3 | 210.0 | 2209.8 | 2.77 | 7.88 | 82.87 | 272.6 | - |  |
| event_256_route_only | 256 | 140000 | 89.0 | 170.6 | 347.0 | 3447.3 | 3.34 | 13.01 | 129.27 | 542.1 | - |  |
| event_256_filter | 256 | 140000 | 303.0 | 455.5 | 946.2 | 5737.3 | 11.36 | 35.48 | 215.15 | 1363.6 | - |  |
| event_256_filter_send | 256 | 140000 | 306.5 | 462.9 | 1084.5 | 6525.6 | 11.49 | 40.67 | 244.71 | 1492.4 | - |  |
| event_256_filter_send_auto | 256 | 140000 | 322.0 | 469.4 | 1061.4 | 7524.9 | 12.08 | 39.80 | 282.19 | 1334.7 | - |  |

(7 runs, >= 20000 quanta per run; % of a 2666.7 us quantum; samples pooled over runs)
