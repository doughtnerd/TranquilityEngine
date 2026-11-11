| case | n | samples | p50 us | p99 us | p99.9 us | max us | p50 % | p99.9 % | max % | worst-run p99.9 us | mem/zone KB | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single_1s_noise | 1 | 140000 | 13.7 | 66.3 | 182.5 | 3850.7 | 0.51 | 6.85 | 144.40 | 600.5 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_1s_room | 1 | 140000 | 12.5 | 56.3 | 95.0 | 5122.0 | 0.47 | 3.56 | 192.07 | 275.7 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_2s_noise | 1 | 140000 | 19.8 | 69.9 | 142.3 | 1602.2 | 0.74 | 5.34 | 60.08 | 306.7 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_2s_room | 1 | 140000 | 19.5 | 70.4 | 139.9 | 4237.0 | 0.73 | 5.25 | 158.89 | 453.5 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_4s_noise | 1 | 140000 | 31.2 | 80.0 | 158.9 | 3579.4 | 1.17 | 5.96 | 134.23 | 277.9 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| single_4s_room | 1 | 140000 | 30.5 | 79.3 | 124.1 | 2845.2 | 1.15 | 4.65 | 106.70 | 301.5 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| m1_real_1.8s | 1 | 140000 | 19.2 | 68.8 | 106.6 | 2892.4 | 0.72 | 4.00 | 108.46 | 201.8 | 2945 |  |
| zones_1x2s_unstaggered | 1 | 140000 | 20.1 | 72.4 | 112.9 | 1532.3 | 0.75 | 4.23 | 57.46 | 140.9 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_1x2s_staggered | 1 | 140000 | 19.5 | 70.9 | 149.3 | 3393.4 | 0.73 | 5.60 | 127.25 | 296.8 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x2s_unstaggered | 2 | 140000 | 40.4 | 118.9 | 218.3 | 4107.1 | 1.52 | 8.19 | 154.02 | 255.7 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_2x2s_staggered | 2 | 140000 | 48.6 | 100.8 | 223.4 | 8192.1 | 1.82 | 8.38 | 307.20 | 482.2 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_4x2s_unstaggered | 4 | 140000 | 94.0 | 243.3 | 516.6 | 16691.3 | 3.52 | 19.37 | 625.92 | 709.8 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_4x2s_staggered | 4 | 140000 | 106.3 | 211.5 | 522.8 | 15386.9 | 3.99 | 19.61 | 577.01 | 938.6 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_4x2s_unique | 4 | 140000 | 121.0 | 248.8 | 725.9 | 29694.9 | 4.54 | 27.22 | 1113.56 | 2245.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 2.9 FFT-eq |
| zones_8x2s_unstaggered | 8 | 140000 | 256.4 | 540.3 | 1174.5 | 5432.0 | 9.62 | 44.04 | 203.70 | 1409.4 | 3137 | tail FFTs in busiest quantum 8; modelled busiest quantum 9.4 FFT-eq |
| zones_8x2s_staggered | 8 | 140000 | 262.7 | 494.3 | 908.5 | 31981.7 | 9.85 | 34.07 | 1199.31 | 1460.7 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_8x2s_unique | 8 | 140000 | 224.6 | 543.6 | 1038.7 | 10709.0 | 8.42 | 38.95 | 401.59 | 1489.7 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 7.4 FFT-eq |
| zones_1x4s_unstaggered | 1 | 140000 | 30.3 | 75.9 | 122.9 | 1084.8 | 1.14 | 4.61 | 40.68 | 192.6 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| zones_1x4s_staggered | 1 | 140000 | 33.2 | 86.0 | 131.8 | 3270.2 | 1.25 | 4.94 | 122.63 | 186.2 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x4s_unstaggered | 2 | 140000 | 65.4 | 148.7 | 502.5 | 33963.3 | 2.45 | 18.84 | 1273.62 | 870.1 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| zones_2x4s_staggered | 2 | 140000 | 65.7 | 138.9 | 260.2 | 11255.7 | 2.46 | 9.76 | 422.09 | 333.7 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| zones_4x4s_unstaggered | 4 | 140000 | 153.6 | 287.2 | 1034.6 | 8522.3 | 5.76 | 38.80 | 319.59 | 2233.9 | 6145 | tail FFTs in busiest quantum 4; modelled busiest quantum 5.4 FFT-eq |
| zones_4x4s_staggered | 4 | 140000 | 156.2 | 288.7 | 605.4 | 4401.9 | 5.86 | 22.70 | 165.07 | 944.7 | 6145 | tail FFTs in busiest quantum 3; modelled busiest quantum 3.8 FFT-eq |
| zones_4x4s_unique | 4 | 140000 | 177.7 | 316.4 | 594.9 | 4424.2 | 6.66 | 22.31 | 165.91 | 965.3 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 4.9 FFT-eq |
| zones_8x4s_unstaggered | 8 | 140000 | 356.7 | 656.7 | 1485.6 | 8665.4 | 13.38 | 55.71 | 324.95 | 2138.1 | 6145 | tail FFTs in busiest quantum 8; modelled busiest quantum 10.9 FFT-eq |
| zones_8x4s_staggered | 8 | 140000 | 396.5 | 774.9 | 1549.0 | 8807.6 | 14.87 | 58.09 | 330.28 | 2003.9 | 6145 | tail FFTs in busiest quantum 7; modelled busiest quantum 7.1 FFT-eq |
| zones_8x4s_unique | 8 | 140000 | 323.3 | 1142.3 | 1768.6 | 6741.1 | 12.12 | 66.32 | 252.79 | 2447.3 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 13.0 FFT-eq |
| blend_2x2s_unstaggered | 2 | 140000 | 39.7 | 118.4 | 243.4 | 3984.6 | 1.49 | 9.13 | 149.42 | 436.5 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| blend_2x2s_staggered | 2 | 140000 | 46.8 | 107.0 | 215.2 | 5792.8 | 1.76 | 8.07 | 217.23 | 271.3 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| blend_2x4s_unstaggered | 2 | 140000 | 65.3 | 154.5 | 337.0 | 4021.3 | 2.45 | 12.64 | 150.80 | 683.8 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| blend_2x4s_staggered | 2 | 140000 | 67.6 | 145.0 | 311.2 | 4078.3 | 2.54 | 11.67 | 152.94 | 420.3 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| prep_atonce_1s | 1 | 7000 | 1411.0 | 2529.5 | 3694.3 | 4814.3 | - | - | - | 4245.6 | 768 |  |
| prep_atonce_2s | 1 | 7000 | 2869.3 | 5218.3 | 7177.8 | 10770.9 | - | - | - | 9355.3 | 1504 |  |
| prep_atonce_4s | 1 | 7000 | 5847.5 | 10323.9 | 13064.8 | 21736.3 | - | - | - | 13992.4 | 3008 |  |
| prep_spread_1s_u1 | 1 | 140000 | 32.5 | 86.5 | 175.8 | 3112.3 | 1.22 | 6.59 | 116.71 | 210.3 | 1665 | 120 units, 120 quanta to prepare |
| prep_spread_1s_u2 | 1 | 140000 | 38.3 | 119.9 | 182.1 | 1636.6 | 1.44 | 6.83 | 61.37 | 242.3 | 1665 | 120 units, 60 quanta to prepare |
| prep_spread_1s_u4 | 1 | 140000 | 63.4 | 199.8 | 456.7 | 6048.6 | 2.38 | 17.12 | 226.82 | 1250.7 | 1665 | 120 units, 30 quanta to prepare |
| prep_spread_2s_u1 | 1 | 140000 | 43.1 | 100.9 | 188.2 | 4265.6 | 1.61 | 7.06 | 159.96 | 292.9 | 3137 | 178 units, 178 quanta to prepare |
| prep_spread_2s_u2 | 1 | 140000 | 67.6 | 141.7 | 273.2 | 5899.3 | 2.53 | 10.25 | 221.23 | 361.5 | 3137 | 178 units, 89 quanta to prepare |
| prep_spread_2s_u4 | 1 | 140000 | 104.2 | 216.6 | 336.0 | 5322.5 | 3.91 | 12.60 | 199.59 | 420.0 | 3137 | 178 units, 45 quanta to prepare |
| prep_spread_4s_u1 | 1 | 140000 | 55.6 | 121.2 | 276.8 | 2609.8 | 2.09 | 10.38 | 97.87 | 386.8 | 6145 | 295 units, 295 quanta to prepare |
| prep_spread_4s_u2 | 1 | 140000 | 79.9 | 148.8 | 266.6 | 9973.9 | 3.00 | 10.00 | 374.02 | 359.0 | 6145 | 295 units, 148 quanta to prepare |
| prep_spread_4s_u4 | 1 | 140000 | 130.6 | 257.2 | 395.3 | 5247.9 | 4.90 | 14.82 | 196.80 | 828.0 | 6145 | 295 units, 74 quanta to prepare |
| event_16_route_only | 16 | 140000 | 4.9 | 15.9 | 49.0 | 322.6 | 0.18 | 1.84 | 12.10 | 53.1 | - |  |
| event_16_filter | 16 | 140000 | 18.3 | 51.6 | 79.3 | 2857.3 | 0.69 | 2.98 | 107.15 | 96.5 | - |  |
| event_16_filter_send | 16 | 140000 | 18.5 | 51.3 | 84.9 | 4272.4 | 0.69 | 3.18 | 160.22 | 238.0 | - |  |
| event_16_filter_send_auto | 16 | 140000 | 19.5 | 51.0 | 77.4 | 2122.1 | 0.73 | 2.90 | 79.58 | 108.4 | - |  |
| event_64_route_only | 64 | 140000 | 21.9 | 70.7 | 170.9 | 2174.3 | 0.82 | 6.41 | 81.53 | 602.4 | - |  |
| event_64_filter | 64 | 140000 | 73.8 | 140.2 | 292.8 | 4766.1 | 2.77 | 10.98 | 178.73 | 539.9 | - |  |
| event_64_filter_send | 64 | 140000 | 76.1 | 133.2 | 288.1 | 5193.5 | 2.86 | 10.80 | 194.76 | 476.7 | - |  |
| event_64_filter_send_auto | 64 | 140000 | 77.1 | 154.1 | 437.3 | 9226.3 | 2.89 | 16.40 | 345.99 | 600.9 | - |  |
| event_256_route_only | 256 | 140000 | 98.6 | 213.1 | 360.9 | 4193.1 | 3.70 | 13.54 | 157.24 | 596.6 | - |  |
| event_256_filter | 256 | 140000 | 315.2 | 495.1 | 1039.8 | 4498.4 | 11.82 | 38.99 | 168.69 | 1366.0 | - |  |
| event_256_filter_send | 256 | 140000 | 325.1 | 511.7 | 1058.2 | 9631.5 | 12.19 | 39.68 | 361.18 | 1172.9 | - |  |
| event_256_filter_send_auto | 256 | 140000 | 347.1 | 565.4 | 1156.5 | 20193.3 | 13.02 | 43.37 | 757.25 | 1549.0 | - |  |

(node v22.23.4 wasm (+simd128): 7 runs, >= 20000 quanta per run; % of a 2666.7 us quantum; samples pooled over runs; clock pair overhead 0.07 us included)
