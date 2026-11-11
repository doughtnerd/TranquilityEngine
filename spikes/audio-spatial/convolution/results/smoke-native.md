| case | n | samples | p50 us | p99 us | p99.9 us | max us | p50 % | p99.9 % | max % | worst-run p99.9 us | mem/zone KB | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single_1s_noise | 1 | 10000 | 12.7 | 44.0 | 83.2 | 2005.4 | 0.48 | 3.12 | 75.20 | 980.5 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_1s_room | 1 | 10000 | 13.2 | 53.4 | 116.6 | 334.7 | 0.49 | 4.37 | 12.55 | 156.3 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_2s_noise | 1 | 10000 | 17.4 | 68.8 | 102.3 | 1004.4 | 0.65 | 3.83 | 37.66 | 185.6 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_2s_room | 1 | 10000 | 17.2 | 46.5 | 67.6 | 106.2 | 0.65 | 2.53 | 3.98 | 79.8 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_4s_noise | 1 | 10000 | 26.0 | 50.4 | 64.0 | 87.5 | 0.98 | 2.40 | 3.28 | 66.6 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| single_4s_room | 1 | 10000 | 26.5 | 50.8 | 62.8 | 73.4 | 0.99 | 2.36 | 2.75 | 65.3 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| m1_real_1.8s | 1 | 10000 | 16.8 | 46.8 | 56.8 | 883.2 | 0.63 | 2.13 | 33.12 | 63.6 | 2945 |  |
| zones_1x2s_unstaggered | 1 | 10000 | 17.1 | 45.4 | 57.5 | 89.2 | 0.64 | 2.16 | 3.34 | 62.5 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_1x2s_staggered | 1 | 10000 | 15.2 | 45.8 | 54.6 | 62.8 | 0.57 | 2.05 | 2.35 | 55.6 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x2s_unstaggered | 2 | 10000 | 34.5 | 85.7 | 101.0 | 260.4 | 1.29 | 3.79 | 9.77 | 104.8 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_2x2s_staggered | 2 | 10000 | 41.8 | 86.3 | 124.2 | 556.0 | 1.57 | 4.66 | 20.85 | 172.9 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_4x2s_unstaggered | 4 | 10000 | 73.7 | 164.7 | 215.3 | 717.8 | 2.76 | 8.07 | 26.92 | 252.1 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_4x2s_staggered | 4 | 10000 | 87.6 | 175.8 | 392.0 | 3094.8 | 3.29 | 14.70 | 116.06 | 509.2 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_4x2s_unique | 4 | 10000 | 98.3 | 157.5 | 200.0 | 631.0 | 3.69 | 7.50 | 23.66 | 221.4 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 2.9 FFT-eq |
| zones_8x2s_unstaggered | 8 | 10000 | 169.9 | 328.6 | 359.5 | 632.3 | 6.37 | 13.48 | 23.71 | 433.8 | 3137 | tail FFTs in busiest quantum 8; modelled busiest quantum 9.4 FFT-eq |
| zones_8x2s_staggered | 8 | 10000 | 188.5 | 241.9 | 374.4 | 2253.1 | 7.07 | 14.04 | 84.49 | 583.8 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_8x2s_unique | 8 | 10000 | 170.2 | 352.1 | 505.2 | 2310.7 | 6.38 | 18.94 | 86.65 | 2285.3 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 7.4 FFT-eq |
| zones_1x4s_unstaggered | 1 | 10000 | 29.1 | 68.0 | 92.8 | 130.1 | 1.09 | 3.48 | 4.88 | 98.9 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| zones_1x4s_staggered | 1 | 10000 | 27.8 | 49.4 | 59.5 | 83.0 | 1.04 | 2.23 | 3.11 | 65.7 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x4s_unstaggered | 2 | 10000 | 55.4 | 124.0 | 203.6 | 2285.4 | 2.08 | 7.63 | 85.70 | 279.0 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| zones_2x4s_staggered | 2 | 10000 | 54.8 | 87.9 | 277.6 | 2036.0 | 2.06 | 10.41 | 76.35 | 606.6 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| zones_4x4s_unstaggered | 4 | 10000 | 118.2 | 232.2 | 304.3 | 2160.8 | 4.43 | 11.41 | 81.03 | 318.5 | 6145 | tail FFTs in busiest quantum 4; modelled busiest quantum 5.4 FFT-eq |
| zones_4x4s_staggered | 4 | 10000 | 119.8 | 158.6 | 172.0 | 223.4 | 4.49 | 6.45 | 8.38 | 180.1 | 6145 | tail FFTs in busiest quantum 3; modelled busiest quantum 3.8 FFT-eq |
| zones_4x4s_unique | 4 | 10000 | 140.6 | 256.8 | 533.0 | 999.2 | 5.27 | 19.99 | 37.47 | 834.0 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 4.9 FFT-eq |
| zones_8x4s_unstaggered | 8 | 10000 | 239.4 | 366.1 | 417.6 | 1189.8 | 8.98 | 15.66 | 44.62 | 705.3 | 6145 | tail FFTs in busiest quantum 8; modelled busiest quantum 10.9 FFT-eq |
| zones_8x4s_staggered | 8 | 10000 | 240.3 | 309.0 | 443.2 | 1717.1 | 9.01 | 16.62 | 64.39 | 1455.9 | 6145 | tail FFTs in busiest quantum 7; modelled busiest quantum 7.1 FFT-eq |
| zones_8x4s_unique | 8 | 10000 | 208.3 | 583.0 | 1545.3 | 8538.6 | 7.81 | 57.95 | 320.20 | 4201.4 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 13.0 FFT-eq |
| blend_2x2s_unstaggered | 2 | 10000 | 33.4 | 93.6 | 325.9 | 582.5 | 1.25 | 12.22 | 21.84 | 438.8 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| blend_2x2s_staggered | 2 | 10000 | 40.0 | 67.9 | 169.8 | 2087.4 | 1.50 | 6.37 | 78.28 | 1985.2 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| blend_2x4s_unstaggered | 2 | 10000 | 51.0 | 95.5 | 125.0 | 758.2 | 1.91 | 4.69 | 28.43 | 338.7 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| blend_2x4s_staggered | 2 | 10000 | 55.5 | 93.7 | 128.3 | 656.2 | 2.08 | 4.81 | 24.61 | 612.8 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| prep_atonce_1s | 1 | 500 | 1262.7 | 3391.9 | 5280.4 | 5280.4 | - | - | - | 5280.4 | 768 |  |
| prep_atonce_2s | 1 | 500 | 2402.3 | 2981.5 | 4832.1 | 4832.1 | - | - | - | 4832.1 | 1504 |  |
| prep_atonce_4s | 1 | 500 | 4884.3 | 6241.1 | 9670.8 | 9670.8 | - | - | - | 9670.8 | 3008 |  |
| prep_spread_1s_u1 | 1 | 10000 | 29.0 | 57.9 | 71.8 | 87.8 | 1.09 | 2.69 | 3.29 | 76.7 | 1665 | 120 units, 120 quanta to prepare |
| prep_spread_1s_u2 | 1 | 10000 | 34.4 | 84.3 | 96.2 | 105.3 | 1.29 | 3.61 | 3.95 | 99.1 | 1665 | 120 units, 60 quanta to prepare |
| prep_spread_1s_u4 | 1 | 10000 | 54.5 | 134.5 | 152.3 | 759.7 | 2.05 | 5.71 | 28.49 | 176.5 | 1665 | 120 units, 30 quanta to prepare |
| prep_spread_2s_u1 | 1 | 10000 | 36.2 | 63.7 | 76.2 | 129.6 | 1.36 | 2.86 | 4.86 | 79.7 | 3137 | 178 units, 178 quanta to prepare |
| prep_spread_2s_u2 | 1 | 10000 | 57.3 | 91.1 | 110.6 | 639.1 | 2.15 | 4.15 | 23.97 | 210.5 | 3137 | 178 units, 89 quanta to prepare |
| prep_spread_2s_u4 | 1 | 10000 | 92.7 | 136.4 | 154.3 | 699.0 | 3.47 | 5.78 | 26.21 | 182.6 | 3137 | 178 units, 45 quanta to prepare |
| prep_spread_4s_u1 | 1 | 10000 | 45.0 | 72.6 | 101.0 | 636.0 | 1.69 | 3.79 | 23.85 | 193.5 | 6145 | 295 units, 295 quanta to prepare |
| prep_spread_4s_u2 | 1 | 10000 | 66.2 | 98.8 | 132.3 | 920.4 | 2.48 | 4.96 | 34.51 | 311.5 | 6145 | 295 units, 148 quanta to prepare |
| prep_spread_4s_u4 | 1 | 10000 | 108.9 | 148.6 | 175.5 | 774.6 | 4.08 | 6.58 | 29.05 | 177.3 | 6145 | 295 units, 74 quanta to prepare |
| event_16_route_only | 16 | 10000 | 2.4 | 2.9 | 17.2 | 24.9 | 0.09 | 0.64 | 0.93 | 21.6 | - |  |
| event_16_filter | 16 | 10000 | 15.2 | 28.6 | 37.4 | 63.0 | 0.57 | 1.40 | 2.36 | 41.5 | - |  |
| event_16_filter_send | 16 | 10000 | 16.9 | 32.2 | 54.5 | 120.9 | 0.64 | 2.04 | 4.53 | 64.6 | - |  |
| event_16_filter_send_auto | 16 | 10000 | 19.4 | 44.3 | 62.0 | 79.8 | 0.73 | 2.32 | 2.99 | 64.8 | - |  |
| event_64_route_only | 64 | 10000 | 13.2 | 33.4 | 41.5 | 63.0 | 0.50 | 1.56 | 2.36 | 43.3 | - |  |
| event_64_filter | 64 | 10000 | 68.4 | 101.1 | 262.0 | 1461.9 | 2.57 | 9.82 | 54.82 | 405.3 | - |  |
| event_64_filter_send | 64 | 10000 | 69.9 | 96.2 | 127.7 | 252.7 | 2.62 | 4.79 | 9.48 | 199.1 | - |  |
| event_64_filter_send_auto | 64 | 10000 | 68.4 | 98.1 | 149.8 | 763.1 | 2.56 | 5.62 | 28.62 | 554.4 | - |  |
| event_256_route_only | 256 | 10000 | 56.8 | 97.1 | 175.5 | 1142.3 | 2.13 | 6.58 | 42.84 | 286.2 | - |  |
| event_256_filter | 256 | 10000 | 278.3 | 371.8 | 428.0 | 2482.0 | 10.44 | 16.05 | 93.07 | 454.9 | - |  |
| event_256_filter_send | 256 | 10000 | 280.6 | 334.1 | 362.3 | 489.3 | 10.52 | 13.59 | 18.35 | 399.4 | - |  |
| event_256_filter_send_auto | 256 | 10000 | 293.0 | 351.2 | 548.9 | 953.8 | 10.99 | 20.59 | 35.77 | 863.6 | - |  |

(5 runs, >= 2000 quanta per run; % of a 2666.7 us quantum; samples pooled over runs)
