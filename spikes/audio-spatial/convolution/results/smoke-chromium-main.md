Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36

| case | n | samples | p50 us | p99 us | p99.9 us | max us | p50 % | p99.9 % | max % | worst-run p99.9 us | mem/zone KB | note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single_1s_noise | 1 | 10000 | 15.0 | 50.0 | 300.0 | 1695.0 | 0.56 | 11.25 | 63.56 | 550.0 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_1s_room | 1 | 10000 | 15.0 | 45.0 | 65.0 | 540.0 | 0.56 | 2.44 | 20.25 | 90.0 | 1665 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.1 FFT-eq |
| single_2s_noise | 1 | 10000 | 20.0 | 65.0 | 90.0 | 435.0 | 0.75 | 3.37 | 16.31 | 100.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_2s_room | 1 | 10000 | 20.0 | 60.0 | 160.0 | 610.0 | 0.75 | 6.00 | 22.87 | 385.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| single_4s_noise | 1 | 10000 | 30.0 | 55.0 | 75.0 | 495.0 | 1.12 | 2.81 | 18.56 | 85.0 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| single_4s_room | 1 | 10000 | 30.0 | 65.0 | 80.0 | 545.0 | 1.12 | 3.00 | 20.44 | 90.0 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| m1_real_1.8s | 1 | 10000 | 15.0 | 45.0 | 70.0 | 425.0 | 0.56 | 2.62 | 15.94 | 95.0 | 2945 |  |
| zones_1x2s_unstaggered | 1 | 10000 | 20.0 | 50.0 | 65.0 | 315.0 | 0.75 | 2.44 | 11.81 | 70.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_1x2s_staggered | 1 | 10000 | 20.0 | 45.0 | 55.0 | 75.0 | 0.75 | 2.06 | 2.81 | 65.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x2s_unstaggered | 2 | 10000 | 35.0 | 95.0 | 140.0 | 1125.0 | 1.31 | 5.25 | 42.19 | 155.0 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_2x2s_staggered | 2 | 10000 | 45.0 | 110.0 | 225.0 | 510.0 | 1.69 | 8.44 | 19.13 | 300.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| zones_4x2s_unstaggered | 4 | 10000 | 80.0 | 195.0 | 320.0 | 2680.0 | 3.00 | 12.00 | 100.50 | 2220.0 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_4x2s_staggered | 4 | 10000 | 90.0 | 140.0 | 170.0 | 265.0 | 3.37 | 6.37 | 9.94 | 185.0 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| zones_4x2s_unique | 4 | 10000 | 100.0 | 190.0 | 240.0 | 285.0 | 3.75 | 9.00 | 10.69 | 250.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 2.9 FFT-eq |
| zones_8x2s_unstaggered | 8 | 10000 | 180.0 | 515.0 | 900.0 | 2375.0 | 6.75 | 33.75 | 89.06 | 985.0 | 3137 | tail FFTs in busiest quantum 8; modelled busiest quantum 9.4 FFT-eq |
| zones_8x2s_staggered | 8 | 10000 | 200.0 | 360.0 | 585.0 | 1445.0 | 7.50 | 21.94 | 54.19 | 845.0 | 3137 | tail FFTs in busiest quantum 4; modelled busiest quantum 4.7 FFT-eq |
| zones_8x2s_unique | 8 | 10000 | 175.0 | 340.0 | 695.0 | 4405.0 | 6.56 | 26.06 | 165.19 | 1755.0 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 7.4 FFT-eq |
| zones_1x4s_unstaggered | 1 | 10000 | 30.0 | 65.0 | 100.0 | 710.0 | 1.12 | 3.75 | 26.62 | 190.0 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.4 FFT-eq |
| zones_1x4s_staggered | 1 | 10000 | 30.0 | 65.0 | 90.0 | 240.0 | 1.13 | 3.37 | 9.00 | 95.0 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.0 FFT-eq |
| zones_2x4s_unstaggered | 2 | 10000 | 55.0 | 100.0 | 120.0 | 215.0 | 2.06 | 4.50 | 8.06 | 155.0 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| zones_2x4s_staggered | 2 | 10000 | 60.0 | 125.0 | 315.0 | 980.0 | 2.25 | 11.81 | 36.75 | 550.0 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| zones_4x4s_unstaggered | 4 | 10000 | 130.0 | 245.0 | 475.0 | 4215.0 | 4.87 | 17.81 | 158.06 | 875.0 | 6145 | tail FFTs in busiest quantum 4; modelled busiest quantum 5.4 FFT-eq |
| zones_4x4s_staggered | 4 | 10000 | 125.0 | 225.0 | 300.0 | 395.0 | 4.69 | 11.25 | 14.81 | 345.0 | 6145 | tail FFTs in busiest quantum 3; modelled busiest quantum 3.8 FFT-eq |
| zones_4x4s_unique | 4 | 10000 | 140.0 | 200.0 | 245.0 | 1230.0 | 5.25 | 9.19 | 46.12 | 295.0 | 6145 | tail FFTs in busiest quantum 1; modelled busiest quantum 4.9 FFT-eq |
| zones_8x4s_unstaggered | 8 | 10000 | 255.0 | 550.0 | 2375.0 | 4860.0 | 9.56 | 89.06 | 182.25 | 4040.0 | 6145 | tail FFTs in busiest quantum 8; modelled busiest quantum 10.9 FFT-eq |
| zones_8x4s_staggered | 8 | 10000 | 260.0 | 435.0 | 625.0 | 1250.0 | 9.75 | 23.44 | 46.88 | 825.0 | 6145 | tail FFTs in busiest quantum 7; modelled busiest quantum 7.1 FFT-eq |
| zones_8x4s_unique | 8 | 10000 | 225.0 | 625.0 | 1165.0 | 2280.0 | 8.44 | 43.69 | 85.50 | 2200.0 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 13.0 FFT-eq |
| blend_2x2s_unstaggered | 2 | 10000 | 35.0 | 110.0 | 160.0 | 1000.0 | 1.31 | 6.00 | 37.50 | 280.0 | 3137 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.4 FFT-eq |
| blend_2x2s_staggered | 2 | 10000 | 45.0 | 100.0 | 160.0 | 730.0 | 1.69 | 6.00 | 27.38 | 295.0 | 3137 | tail FFTs in busiest quantum 1; modelled busiest quantum 1.2 FFT-eq |
| blend_2x4s_unstaggered | 2 | 10000 | 55.0 | 105.0 | 340.0 | 1705.0 | 2.06 | 12.75 | 63.94 | 875.0 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.7 FFT-eq |
| blend_2x4s_staggered | 2 | 10000 | 55.0 | 95.0 | 155.0 | 965.0 | 2.06 | 5.81 | 36.19 | 230.0 | 6145 | tail FFTs in busiest quantum 2; modelled busiest quantum 2.0 FFT-eq |
| prep_atonce_1s | 1 | 500 | 1370.0 | 1595.0 | 1935.0 | 1935.0 | - | - | - | 1935.0 | 768 |  |
| prep_atonce_2s | 1 | 500 | 2700.0 | 4865.0 | 20525.0 | 20525.0 | - | - | - | 20525.0 | 1504 |  |
| prep_atonce_4s | 1 | 500 | 5400.0 | 9765.0 | 12245.0 | 12245.0 | - | - | - | 12245.0 | 3008 |  |
| prep_spread_1s_u1 | 1 | 10000 | 30.0 | 65.0 | 85.0 | 275.0 | 1.12 | 3.19 | 10.31 | 115.0 | 1665 | 120 units, 120 quanta to prepare |
| prep_spread_1s_u2 | 1 | 10000 | 50.0 | 150.0 | 195.0 | 440.0 | 1.88 | 7.31 | 16.50 | 205.0 | 1665 | 120 units, 60 quanta to prepare |
| prep_spread_1s_u4 | 1 | 10000 | 55.0 | 165.0 | 2110.0 | 2210.0 | 2.06 | 79.12 | 82.87 | 2200.0 | 1665 | 120 units, 30 quanta to prepare |
| prep_spread_2s_u1 | 1 | 10000 | 40.0 | 145.0 | 240.0 | 1650.0 | 1.50 | 9.00 | 61.88 | 330.0 | 3137 | 178 units, 178 quanta to prepare |
| prep_spread_2s_u2 | 1 | 10000 | 60.0 | 120.0 | 190.0 | 2365.0 | 2.25 | 7.12 | 88.69 | 1525.0 | 3137 | 178 units, 89 quanta to prepare |
| prep_spread_2s_u4 | 1 | 10000 | 105.0 | 160.0 | 230.0 | 730.0 | 3.94 | 8.62 | 27.38 | 315.0 | 3137 | 178 units, 45 quanta to prepare |
| prep_spread_4s_u1 | 1 | 10000 | 50.0 | 80.0 | 100.0 | 240.0 | 1.87 | 3.75 | 9.00 | 110.0 | 6145 | 295 units, 295 quanta to prepare |
| prep_spread_4s_u2 | 1 | 10000 | 70.0 | 110.0 | 135.0 | 465.0 | 2.63 | 5.06 | 17.44 | 150.0 | 6145 | 295 units, 148 quanta to prepare |
| prep_spread_4s_u4 | 1 | 10000 | 115.0 | 155.0 | 210.0 | 375.0 | 4.31 | 7.87 | 14.06 | 250.0 | 6145 | 295 units, 74 quanta to prepare |
| event_16_route_only | 16 | 10000 | 10.0 | 25.0 | 35.0 | 45.0 | 0.38 | 1.31 | 1.69 | 35.0 | - |  |
| event_16_filter | 16 | 10000 | 25.0 | 45.0 | 55.0 | 95.0 | 0.94 | 2.06 | 3.56 | 55.0 | - |  |
| event_16_filter_send | 16 | 10000 | 30.0 | 60.0 | 85.0 | 140.0 | 1.12 | 3.19 | 5.25 | 100.0 | - |  |
| event_16_filter_send_auto | 16 | 10000 | 30.0 | 70.0 | 185.0 | 805.0 | 1.12 | 6.94 | 30.19 | 465.0 | - |  |
| event_64_route_only | 64 | 10000 | 55.0 | 110.0 | 210.0 | 765.0 | 2.06 | 7.88 | 28.69 | 255.0 | - |  |
| event_64_filter | 64 | 10000 | 105.0 | 160.0 | 265.0 | 1520.0 | 3.94 | 9.94 | 57.00 | 350.0 | - |  |
| event_64_filter_send | 64 | 10000 | 115.0 | 175.0 | 325.0 | 810.0 | 4.31 | 12.19 | 30.38 | 550.0 | - |  |
| event_64_filter_send_auto | 64 | 10000 | 120.0 | 195.0 | 745.0 | 2460.0 | 4.50 | 27.94 | 92.25 | 2245.0 | - |  |
| event_256_route_only | 256 | 10000 | 235.0 | 450.0 | 2270.0 | 3385.0 | 8.81 | 85.13 | 126.94 | 2585.0 | - |  |
| event_256_filter | 256 | 10000 | 470.0 | 685.0 | 1140.0 | 2010.0 | 17.63 | 42.75 | 75.37 | 1865.0 | - |  |
| event_256_filter_send | 256 | 10000 | 480.0 | 760.0 | 875.0 | 1720.0 | 18.00 | 32.81 | 64.50 | 1175.0 | - |  |
| event_256_filter_send_auto | 256 | 10000 | 490.0 | 600.0 | 795.0 | 2045.0 | 18.38 | 29.81 | 76.69 | 915.0 | - |  |

(chromium main thread, crossOriginIsolated=true: 5 runs, >= 2000 quanta per run; % of a 2666.7 us quantum; samples pooled over runs; clock pair overhead 0.00 us included)
