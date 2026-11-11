Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36

| case | n | samples | p50 us | p99 us | p99.9 us | max us | p50 % | p99.9 % | max % | worst-run p99.9 us | mem/zone KB | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single_1s_noise | 1 | 10000 | 15.0 | 50.0 | 80.0 | 100.0 | 0.56 | 3.00 | 3.75 | 90.0 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_1s_room | 1 | 10000 | 15.0 | 55.0 | 80.0 | 180.0 | 0.56 | 3.00 | 6.75 | 100.0 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_2s_noise | 1 | 10000 | 20.0 | 50.0 | 75.0 | 165.0 | 0.75 | 2.81 | 6.19 | 80.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_2s_room | 1 | 10000 | 20.0 | 50.0 | 95.0 | 595.0 | 0.75 | 3.56 | 22.31 | 135.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_4s_noise | 1 | 10000 | 25.0 | 65.0 | 110.0 | 220.0 | 0.94 | 4.12 | 8.25 | 140.0 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| single_4s_room | 1 | 10000 | 25.0 | 55.0 | 75.0 | 360.0 | 0.94 | 2.81 | 13.50 | 90.0 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| m1_real_1.8s | 1 | 10000 | 20.0 | 65.0 | 95.0 | 150.0 | 0.75 | 3.56 | 5.62 | 105.0 | 2945 |  |
| zones_1x2s_unstaggered | 1 | 10000 | 20.0 | 45.0 | 60.0 | 95.0 | 0.75 | 2.25 | 3.56 | 60.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_1x2s_staggered | 1 | 10000 | 20.0 | 45.0 | 60.0 | 65.0 | 0.75 | 2.25 | 2.44 | 60.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x2s_unstaggered | 2 | 10000 | 35.0 | 90.0 | 140.0 | 760.0 | 1.31 | 5.25 | 28.50 | 150.0 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_2x2s_staggered | 2 | 10000 | 40.0 | 65.0 | 80.0 | 145.0 | 1.50 | 3.00 | 5.44 | 85.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_4x2s_unstaggered | 4 | 10000 | 70.0 | 165.0 | 225.0 | 625.0 | 2.63 | 8.44 | 23.44 | 235.0 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_4x2s_staggered | 4 | 10000 | 90.0 | 145.0 | 205.0 | 880.0 | 3.37 | 7.69 | 33.00 | 250.0 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_4x2s_unique | 4 | 10000 | 95.0 | 160.0 | 225.0 | 1415.0 | 3.56 | 8.44 | 53.06 | 245.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 2.9 FFT-eq |
| zones_8x2s_unstaggered | 8 | 10000 | 175.0 | 355.0 | 535.0 | 805.0 | 6.56 | 20.06 | 30.19 | 585.0 | 3137 | tail FFTs in busiest quantum 8; modelled busiest quantum 9.4 FFT-eq |
| zones_8x2s_staggered | 8 | 10000 | 190.0 | 330.0 | 380.0 | 430.0 | 7.12 | 14.25 | 16.13 | 410.0 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_8x2s_unique | 8 | 10000 | 165.0 | 305.0 | 345.0 | 560.0 | 6.19 | 12.94 | 21.00 | 350.0 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 7.4 FFT-eq |
| zones_1x4s_unstaggered | 1 | 10000 | 25.0 | 50.0 | 60.0 | 90.0 | 0.94 | 2.25 | 3.37 | 70.0 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| zones_1x4s_staggered | 1 | 10000 | 30.0 | 50.0 | 65.0 | 375.0 | 1.12 | 2.44 | 14.06 | 70.0 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x4s_unstaggered | 2 | 10000 | 50.0 | 90.0 | 105.0 | 115.0 | 1.88 | 3.94 | 4.31 | 105.0 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| zones_2x4s_staggered | 2 | 10000 | 55.0 | 85.0 | 260.0 | 1040.0 | 2.06 | 9.75 | 39.00 | 585.0 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| zones_4x4s_unstaggered | 4 | 10000 | 115.0 | 255.0 | 590.0 | 1115.0 | 4.31 | 22.12 | 41.81 | 780.0 | 6145 | tail FFTs in busiest quantum 4; modelled busiest quantum 5.4 FFT-eq |
| zones_4x4s_staggered | 4 | 10000 | 125.0 | 165.0 | 205.0 | 270.0 | 4.69 | 7.69 | 10.13 | 215.0 | 6145 | tail FFTs in busiest quantum 3; modelled busiest quantum 3.8 FFT-eq |
| zones_4x4s_unique | 4 | 10000 | 145.0 | 205.0 | 265.0 | 805.0 | 5.44 | 9.94 | 30.19 | 405.0 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 4.9 FFT-eq |
| zones_8x4s_unstaggered | 8 | 10000 | 255.0 | 435.0 | 595.0 | 900.0 | 9.56 | 22.31 | 33.75 | 760.0 | 6145 | tail FFTs in busiest quantum 8; modelled busiest quantum 10.9 FFT-eq |
| zones_8x4s_staggered | 8 | 10000 | 255.0 | 400.0 | 855.0 | 3060.0 | 9.56 | 32.06 | 114.75 | 2650.0 | 6145 | tail FFTs in busiest quantum 7; modelled busiest quantum 7.1 FFT-eq |
| zones_8x4s_unique | 8 | 10000 | 205.0 | 430.0 | 455.0 | 610.0 | 7.69 | 17.06 | 22.87 | 485.0 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 13.0 FFT-eq |
| blend_2x2s_unstaggered | 2 | 10000 | 35.0 | 80.0 | 100.0 | 190.0 | 1.31 | 3.75 | 7.12 | 100.0 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| blend_2x2s_staggered | 2 | 10000 | 40.0 | 65.0 | 75.0 | 305.0 | 1.50 | 2.81 | 11.44 | 105.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| blend_2x4s_unstaggered | 2 | 10000 | 55.0 | 95.0 | 110.0 | 190.0 | 2.06 | 4.12 | 7.13 | 110.0 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| blend_2x4s_staggered | 2 | 10000 | 55.0 | 90.0 | 115.0 | 155.0 | 2.06 | 4.31 | 5.81 | 130.0 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| prep_atonce_1s | 1 | 500 | 1275.0 | 1520.0 | 2080.0 | 2080.0 | - | - | - | 2080.0 | 768 |  |
| prep_atonce_2s | 1 | 500 | 2515.0 | 2960.0 | 3335.0 | 3335.0 | - | - | - | 3335.0 | 1504 |  |
| prep_atonce_4s | 1 | 500 | 5100.0 | 6010.0 | 6155.0 | 6155.0 | - | - | - | 6155.0 | 3008 |  |
| prep_spread_1s_u1 | 1 | 10000 | 30.0 | 60.0 | 75.0 | 130.0 | 1.12 | 2.81 | 4.87 | 85.0 | 1665 | 120 units, 120 quanta to prepare |
| prep_spread_1s_u2 | 1 | 10000 | 35.0 | 90.0 | 105.0 | 275.0 | 1.31 | 3.94 | 10.31 | 110.0 | 1665 | 120 units, 60 quanta to prepare |
| prep_spread_1s_u4 | 1 | 10000 | 55.0 | 130.0 | 160.0 | 365.0 | 2.06 | 6.00 | 13.69 | 250.0 | 1665 | 120 units, 30 quanta to prepare |
| prep_spread_2s_u1 | 1 | 10000 | 35.0 | 65.0 | 85.0 | 145.0 | 1.31 | 3.19 | 5.44 | 85.0 | 3137 | 178 units, 178 quanta to prepare |
| prep_spread_2s_u2 | 1 | 10000 | 55.0 | 90.0 | 115.0 | 2725.0 | 2.06 | 4.31 | 102.19 | 185.0 | 3137 | 178 units, 89 quanta to prepare |
| prep_spread_2s_u4 | 1 | 10000 | 100.0 | 140.0 | 275.0 | 900.0 | 3.75 | 10.31 | 33.75 | 555.0 | 3137 | 178 units, 45 quanta to prepare |
| prep_spread_4s_u1 | 1 | 10000 | 50.0 | 100.0 | 130.0 | 315.0 | 1.87 | 4.87 | 11.81 | 140.0 | 6145 | 295 units, 295 quanta to prepare |
| prep_spread_4s_u2 | 1 | 10000 | 70.0 | 115.0 | 140.0 | 695.0 | 2.62 | 5.25 | 26.06 | 200.0 | 6145 | 295 units, 148 quanta to prepare |
| prep_spread_4s_u4 | 1 | 10000 | 115.0 | 160.0 | 230.0 | 1000.0 | 4.31 | 8.62 | 37.50 | 480.0 | 6145 | 295 units, 74 quanta to prepare |
| event_16_route_only | 16 | 10000 | 5.0 | 10.0 | 30.0 | 40.0 | 0.19 | 1.12 | 1.50 | 30.0 | - |  |
| event_16_filter | 16 | 10000 | 15.0 | 30.0 | 40.0 | 50.0 | 0.56 | 1.50 | 1.88 | 45.0 | - |  |
| event_16_filter_send | 16 | 10000 | 15.0 | 35.0 | 45.0 | 85.0 | 0.56 | 1.69 | 3.19 | 50.0 | - |  |
| event_16_filter_send_auto | 16 | 10000 | 20.0 | 35.0 | 50.0 | 80.0 | 0.75 | 1.87 | 3.00 | 55.0 | - |  |
| event_64_route_only | 64 | 10000 | 15.0 | 35.0 | 50.0 | 70.0 | 0.56 | 1.87 | 2.63 | 50.0 | - |  |
| event_64_filter | 64 | 10000 | 70.0 | 95.0 | 125.0 | 1890.0 | 2.62 | 4.69 | 70.87 | 135.0 | - |  |
| event_64_filter_send | 64 | 10000 | 70.0 | 95.0 | 110.0 | 870.0 | 2.63 | 4.13 | 32.62 | 115.0 | - |  |
| event_64_filter_send_auto | 64 | 10000 | 75.0 | 105.0 | 115.0 | 180.0 | 2.81 | 4.31 | 6.75 | 135.0 | - |  |
| event_256_route_only | 256 | 10000 | 70.0 | 115.0 | 145.0 | 195.0 | 2.63 | 5.44 | 7.31 | 155.0 | - |  |
| event_256_filter | 256 | 10000 | 290.0 | 355.0 | 445.0 | 660.0 | 10.87 | 16.69 | 24.75 | 500.0 | - |  |
| event_256_filter_send | 256 | 10000 | 295.0 | 365.0 | 465.0 | 580.0 | 11.06 | 17.44 | 21.75 | 500.0 | - |  |
| event_256_filter_send_auto | 256 | 10000 | 310.0 | 375.0 | 430.0 | 1460.0 | 11.63 | 16.13 | 54.75 | 435.0 | - |  |

(chromium main thread, crossOriginIsolated=true: 5 runs, >= 2000 quanta per run; % of a 2666.7 us quantum; samples pooled over runs; clock pair overhead 0.00 us included)
