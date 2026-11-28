Run 2026-11-28T00:43:01.807Z; Intel(R) Xeon(R) Processor @ 2.10GHz x4; load 4.91/2.43/1.17; 7 runs x 40 frames per job; rustc 1.97.0 (2d8144b78 2026-07-07); node v22.23.5; chromium 158.0.8127.36 (cross-origin isolated). wasm: {"simd":{"bytes":96157,"gzip":37633},"scalar":{"bytes":96565,"gzip":37264}}

### 1. Frame cost, one camera, ms per frame (p50 / p99 / max)

**city-box**

| buffer | environment | path | total p50 | p99 | max | clear | select | setup | raster | mip | test |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 256x128 | native | simd | 0.91 | 1.27 | 1.33 | 0.002 | 0.010 | 0.23 | 0.35 | 0.004 | 0.30 |
| 256x128 | native | scalar | 1.71 | 1.83 | 1.86 | 0.002 | 0.011 | 0.24 | 1.06 | 0.086 | 0.31 |
| 256x128 | Node wasm simd | simd | 1.23 | 1.96 | 2.33 | 0.002 | 0.013 | 0.26 | 0.50 | 0.012 | 0.39 |
| 256x128 | Node wasm simd | scalar | 1.49 | 1.66 | 1.71 | 0.002 | 0.010 | 0.21 | 0.87 | 0.044 | 0.35 |
| 256x128 | Node wasm scalar | scalar | 1.96 | 3.01 | 3.89 | 0.002 | 0.014 | 0.29 | 1.19 | 0.060 | 0.48 |
| 256x128 | Chromium wasm simd | simd | 1.07 | 3.12 | 4.10 | 0.000 | 0.010 | 0.20 | 0.43 | 0.010 | 0.31 |
| 256x128 | Chromium wasm simd | scalar | 1.82 | 2.54 | 5.52 | 0.005 | 0.010 | 0.25 | 1.05 | 0.055 | 0.43 |
| 256x128 | Chromium wasm scalar | scalar | 1.86 | 2.84 | 3.60 | 0.005 | 0.015 | 0.26 | 1.06 | 0.060 | 0.45 |
| 320x180 | native | simd | 1.09 | 1.17 | 1.21 | 0.004 | 0.011 | 0.24 | 0.52 | 0.008 | 0.32 |
| 320x180 | native | scalar | 2.35 | 2.56 | 6.48 | 0.004 | 0.011 | 0.25 | 1.62 | 0.15 | 0.32 |
| 320x180 | Node wasm simd | simd | 1.19 | 1.55 | 1.74 | 0.003 | 0.010 | 0.21 | 0.62 | 0.016 | 0.33 |
| 320x180 | Node wasm simd | scalar | 2.04 | 2.23 | 6.87 | 0.004 | 0.013 | 0.26 | 1.72 | 0.098 | 0.47 |
| 320x180 | Node wasm scalar | scalar | 2.64 | 4.00 | 5.18 | 0.004 | 0.012 | 0.26 | 1.62 | 0.092 | 0.44 |
| 320x180 | Chromium wasm simd | simd | 1.51 | 1.71 | 2.11 | 0.005 | 0.010 | 0.25 | 0.83 | 0.020 | 0.41 |
| 320x180 | Chromium wasm simd | scalar | 2.42 | 3.04 | 4.69 | 0.005 | 0.010 | 0.24 | 1.55 | 0.095 | 0.45 |
| 320x180 | Chromium wasm scalar | scalar | 2.44 | 3.99 | 6.93 | 0.005 | 0.015 | 0.26 | 1.60 | 0.10 | 0.47 |
| 512x256 | native | simd | 1.57 | 1.90 | 1.97 | 0.008 | 0.011 | 0.22 | 0.80 | 0.018 | 0.29 |
| 512x256 | native | scalar | 4.04 | 5.37 | 6.73 | 0.010 | 0.012 | 0.25 | 3.18 | 0.36 | 0.35 |
| 512x256 | Node wasm simd | simd | 1.98 | 2.46 | 2.63 | 0.010 | 0.013 | 0.26 | 1.43 | 0.047 | 0.43 |
| 512x256 | Node wasm simd | scalar | 4.54 | 7.60 | 8.21 | 0.010 | 0.013 | 0.28 | 3.40 | 0.22 | 0.53 |
| 512x256 | Node wasm scalar | scalar | 4.12 | 7.01 | 7.85 | 0.010 | 0.014 | 0.28 | 3.38 | 0.22 | 0.51 |
| 512x256 | Chromium wasm simd | simd | 2.15 | 2.56 | 7.28 | 0.010 | 0.015 | 0.25 | 1.50 | 0.045 | 0.42 |
| 512x256 | Chromium wasm simd | scalar | 4.19 | 4.66 | 5.07 | 0.010 | 0.015 | 0.25 | 3.10 | 0.22 | 0.50 |
| 512x256 | Chromium wasm scalar | scalar | 4.30 | 5.93 | 7.21 | 0.010 | 0.015 | 0.27 | 3.16 | 0.23 | 0.51 |

**city-coarse**

| buffer | environment | path | total p50 | p99 | max | clear | select | setup | raster | mip | test |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 256x128 | native | simd | 3.51 | 6.04 | 7.72 | 0.002 | 0.011 | 2.35 | 0.84 | 0.006 | 0.31 |
| 256x128 | native | scalar | 4.78 | 5.45 | 6.50 | 0.002 | 0.012 | 2.36 | 2.05 | 0.087 | 0.31 |
| 256x128 | Node wasm simd | simd | 3.15 | 5.86 | 6.50 | 0.002 | 0.011 | 1.89 | 0.84 | 0.011 | 0.32 |
| 256x128 | Node wasm simd | scalar | 5.06 | 9.36 | 9.42 | 0.002 | 0.014 | 2.39 | 2.13 | 0.063 | 0.45 |
| 256x128 | Node wasm scalar | scalar | 5.02 | 10.3 | 10.7 | 0.002 | 0.012 | 1.93 | 1.71 | 0.051 | 0.36 |
| 256x128 | Chromium wasm simd | simd | 3.68 | 4.08 | 4.14 | 0.005 | 0.015 | 2.22 | 1.07 | 0.015 | 0.39 |
| 256x128 | Chromium wasm simd | scalar | 4.91 | 7.33 | 10.3 | 0.005 | 0.015 | 2.39 | 2.17 | 0.065 | 0.46 |
| 256x128 | Chromium wasm scalar | scalar | 5.00 | 7.03 | 7.65 | 0.005 | 0.015 | 2.44 | 2.14 | 0.070 | 0.47 |
| 320x180 | native | simd | 3.98 | 5.69 | 7.13 | 0.004 | 0.012 | 2.47 | 1.26 | 0.013 | 0.32 |
| 320x180 | native | scalar | 5.89 | 9.07 | 9.15 | 0.004 | 0.012 | 2.31 | 3.06 | 0.15 | 0.32 |
| 320x180 | Node wasm simd | simd | 4.46 | 8.59 | 9.53 | 0.004 | 0.013 | 2.20 | 1.48 | 0.020 | 0.40 |
| 320x180 | Node wasm simd | scalar | 6.14 | 7.04 | 7.68 | 0.004 | 0.015 | 2.47 | 3.31 | 0.11 | 0.49 |
| 320x180 | Node wasm scalar | scalar | 6.18 | 9.53 | 21.1 | 0.004 | 0.014 | 2.36 | 3.23 | 0.11 | 0.47 |
| 320x180 | Chromium wasm simd | simd | 3.51 | 5.20 | 5.47 | 0.005 | 0.015 | 2.10 | 1.56 | 0.020 | 0.38 |
| 320x180 | Chromium wasm simd | scalar | 6.07 | 7.97 | 8.63 | 0.005 | 0.015 | 2.34 | 3.20 | 0.11 | 0.48 |
| 320x180 | Chromium wasm scalar | scalar | 7.07 | 9.13 | 9.45 | 0.005 | 0.015 | 2.32 | 3.02 | 0.11 | 0.47 |
| 512x256 | native | simd | 4.75 | 7.56 | 9.56 | 0.010 | 0.012 | 2.38 | 2.05 | 0.028 | 0.34 |
| 512x256 | native | scalar | 8.12 | 10.2 | 10.7 | 0.010 | 0.012 | 2.35 | 5.45 | 0.35 | 0.34 |
| 512x256 | Node wasm simd | simd | 4.53 | 6.07 | 6.72 | 0.010 | 0.013 | 2.25 | 2.53 | 0.050 | 0.43 |
| 512x256 | Node wasm simd | scalar | 9.07 | 12.5 | 12.7 | 0.010 | 0.014 | 2.46 | 5.98 | 0.24 | 0.53 |
| 512x256 | Node wasm scalar | scalar | 8.99 | 10.6 | 14.6 | 0.010 | 0.014 | 2.36 | 5.81 | 0.24 | 0.50 |
| 512x256 | Chromium wasm simd | simd | 5.82 | 8.49 | 11.3 | 0.010 | 0.015 | 1.97 | 2.44 | 0.045 | 0.37 |
| 512x256 | Chromium wasm simd | scalar | 8.64 | 12.1 | 12.3 | 0.010 | 0.015 | 2.29 | 5.54 | 0.24 | 0.51 |
| 512x256 | Chromium wasm scalar | scalar | 7.97 | 11.7 | 11.9 | 0.010 | 0.015 | 2.35 | 5.59 | 0.25 | 0.51 |

**forest**

| buffer | environment | path | total p50 | p99 | max | clear | select | setup | raster | mip | test |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 256x128 | native | simd | 2.36 | 2.61 | 2.66 | 0.002 | 0.023 | 0.77 | 0.25 | 0.003 | 0.82 |
| 256x128 | native | scalar | 2.93 | 5.20 | 8.38 | 0.002 | 0.031 | 1.01 | 0.68 | 0.086 | 1.13 |
| 256x128 | Node wasm simd | simd | 3.07 | 5.43 | 8.54 | 0.002 | 0.034 | 1.10 | 0.42 | 0.012 | 1.40 |
| 256x128 | Node wasm simd | scalar | 3.68 | 4.78 | 5.92 | 0.002 | 0.035 | 1.10 | 0.69 | 0.070 | 1.73 |
| 256x128 | Node wasm scalar | scalar | 3.66 | 9.04 | 11.6 | 0.002 | 0.035 | 1.12 | 0.72 | 0.070 | 1.72 |
| 256x128 | Chromium wasm simd | simd | 2.57 | 3.47 | 4.12 | 0.005 | 0.035 | 1.07 | 0.46 | 0.015 | 1.38 |
| 256x128 | Chromium wasm simd | scalar | 3.54 | 4.54 | 5.28 | 0.005 | 0.035 | 1.06 | 0.72 | 0.070 | 1.72 |
| 256x128 | Chromium wasm scalar | scalar | 3.54 | 4.23 | 7.28 | 0.005 | 0.035 | 1.06 | 0.71 | 0.070 | 1.70 |
| 320x180 | native | simd | 2.77 | 4.24 | 4.72 | 0.004 | 0.030 | 1.01 | 0.51 | 0.008 | 1.11 |
| 320x180 | native | scalar | 3.45 | 5.12 | 7.30 | 0.004 | 0.031 | 1.03 | 1.10 | 0.15 | 1.21 |
| 320x180 | Node wasm simd | simd | 3.24 | 3.47 | 3.68 | 0.004 | 0.035 | 1.08 | 0.63 | 0.020 | 1.40 |
| 320x180 | Node wasm simd | scalar | 4.33 | 6.10 | 10.9 | 0.004 | 0.035 | 1.13 | 1.12 | 0.12 | 1.94 |
| 320x180 | Node wasm scalar | scalar | 4.19 | 6.29 | 6.77 | 0.004 | 0.034 | 1.10 | 1.04 | 0.11 | 1.78 |
| 320x180 | Chromium wasm simd | simd | 3.17 | 4.34 | 4.70 | 0.005 | 0.035 | 1.04 | 0.69 | 0.020 | 1.39 |
| 320x180 | Chromium wasm simd | scalar | 3.30 | 5.61 | 9.83 | 0.005 | 0.030 | 0.93 | 0.95 | 0.10 | 1.61 |
| 320x180 | Chromium wasm scalar | scalar | 3.80 | 4.45 | 5.00 | 0.005 | 0.030 | 0.83 | 0.84 | 0.090 | 1.41 |
| 512x256 | native | simd | 3.23 | 5.62 | 19.2 | 0.010 | 0.030 | 1.00 | 0.91 | 0.022 | 1.17 |
| 512x256 | native | scalar | 4.55 | 6.43 | 10.5 | 0.010 | 0.032 | 1.03 | 1.99 | 0.36 | 1.31 |
| 512x256 | Node wasm simd | simd | 4.10 | 5.49 | 8.97 | 0.011 | 0.036 | 1.15 | 1.29 | 0.048 | 1.61 |
| 512x256 | Node wasm simd | scalar | 5.87 | 8.66 | 9.95 | 0.011 | 0.036 | 1.15 | 2.11 | 0.26 | 2.24 |
| 512x256 | Node wasm scalar | scalar | 5.70 | 13.6 | 17.7 | 0.010 | 0.036 | 1.16 | 2.06 | 0.25 | 2.07 |
| 512x256 | Chromium wasm simd | simd | 4.10 | 9.18 | 9.38 | 0.010 | 0.035 | 1.06 | 1.29 | 0.050 | 1.47 |
| 512x256 | Chromium wasm simd | scalar | 5.57 | 8.60 | 9.08 | 0.010 | 0.030 | 0.93 | 1.76 | 0.22 | 1.88 |
| 512x256 | Chromium wasm scalar | scalar | 5.59 | 8.42 | 10.1 | 0.015 | 0.040 | 1.21 | 2.19 | 0.27 | 2.21 |

### Triangles (mean over 8 frames, 256x128)

| scene | occluder instances | in frustum | source tris of those | not outside frustum | back-facing/degenerate | clipped | rasterised (covers a pixel centre) | occludees | outside frustum | near-crossing | culled | visible |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| city-box | 1024 | 714.6 | 8575.5 | 8542.8 | 5719.6 | 66 | 2500.9 | 3000 | 1021.4 | 0 | 1813.4 | 165.2 |
| city-coarse | 1024 | 717.5 | 71750 | 71285.5 | 38038.5 | 222.8 | 14167.4 | 3000 | 1021.8 | 0 | 1813.5 | 164.8 |
| forest | 2000 | 1230.5 | 32032 | 31851.6 | 19817.8 | 121.2 | 3896.2 | 10000 | 4167.6 | 0 | 3848.6 | 1983.8 |

### 2. Accuracy vs 1920x1080 oracle (8 frames summed; in-frustum occludees)

| scene | buffer | in frustum | oracle culled | buffer culled | lost culls | FALSE OCCLUDED | dilate |
|---|---|---|---|---|---|---|---|
| city-box | 256x128 | 15829 | 15353 | 15322 | 41 | 10 | 0 |
| city-box | 256x128 | 15829 | 15353 | 14507 | 846 | 0 | 1 |
| city-box | 320x180 | 15829 | 15353 | 15310 | 51 | 8 | 0 |
| city-box | 320x180 | 15829 | 15353 | 14845 | 508 | 0 | 1 |
| city-box | 512x256 | 15829 | 15353 | 15319 | 38 | 4 | 0 |
| city-box | 512x256 | 15829 | 15353 | 15051 | 302 | 0 | 1 |
| city-coarse | 256x128 | 15826 | 15333 | 15299 | 42 | 8 | 0 |
| city-coarse | 256x128 | 15826 | 15333 | 14508 | 827 | 2 | 1 |
| city-coarse | 320x180 | 15826 | 15333 | 15293 | 47 | 7 | 0 |
| city-coarse | 320x180 | 15826 | 15333 | 14823 | 510 | 0 | 1 |
| city-coarse | 512x256 | 15826 | 15333 | 15304 | 35 | 6 | 0 |
| city-coarse | 512x256 | 15826 | 15333 | 15038 | 295 | 0 | 1 |
| forest | 256x128 | 46659 | 34909 | 36138 | 370 | 1599 | 0 |
| forest | 256x128 | 46659 | 34909 | 30789 | 4893 | 773 | 1 |
| forest | 320x180 | 46659 | 34909 | 36063 | 287 | 1441 | 0 |
| forest | 320x180 | 46659 | 34909 | 32401 | 3316 | 808 | 1 |
| forest | 512x256 | 46659 | 34909 | 35545 | 268 | 904 | 0 |
| forest | 512x256 | 46659 | 34909 | 33170 | 2279 | 540 | 1 |

Coverage rule (256x128, dilate 1 / dilate 0):

| scene | shrink | buffer culled | oracle culled | lost | FALSE OCCLUDED (d1) | FALSE OCCLUDED (d0) | native total p50 ms |
|---|---|---|---|---|---|---|---|
| city-box | 0 | 14507 | 15353 | 846 | 0 | 10 | 0.91 |
| city-box | 0.25 | 14077 | 15353 | 1276 | 0 | 0 | 0.87 |
| city-box | 0.5 | 13516 | 15353 | 1837 | 0 | 0 | 0.93 |
| city-coarse | 0 | 14508 | 15333 | 827 | 2 | 8 | 3.51 |
| city-coarse | 0.25 | 13970 | 15333 | 1363 | 0 | 1 | 3.44 |
| city-coarse | 0.5 | 13346 | 15333 | 1987 | 0 | 0 | 3.33 |
| forest | 0 | 30789 | 34909 | 4893 | 773 | 1599 | 2.36 |
| forest | 0.25 | 9641 | 34909 | 25268 | 0 | 3 | 1.75 |
| forest | 0.5 | 5228 | 34909 | 29681 | 0 | 0 | 2.16 |

### 3. Occluder selection (256x128, native simd; Node wasm simd total p50 in last column)

| scene | setting | tris rasterised | buffer culled / oracle culled (dilate 1) | false occluded | native p50 ms | native p99 | node wasm p50 ms |
|---|---|---|---|---|---|---|---|
| city-coarse | no limit | 14167.4 | 14508 / 15333 | 2 | 3.51 | 6.04 | 3.15 |
| city-coarse | cap 20000 tris | 4904.8 | 14480 / 15333 | 2 | 1.53 | 2.10 | 1.50 |
| city-coarse | cap 10000 tris | 2537.4 | 14266 / 15333 | 2 | 0.84 | 1.11 | 1.36 |
| city-coarse | cap 5000 tris | 1194.8 | 13856 / 15333 | 2 | 0.78 | 1.03 | 0.99 |
| city-coarse | cap 2000 tris | 386.1 | 13323 / 15333 | 2 | 0.58 | 0.67 | 0.83 |
| city-coarse | min screen area 0.01% | 14167.4 | 14508 / 15333 | 2 | 3.50 | 5.29 | 3.63 |
| city-coarse | min screen area 0.05% | 14129 | 14508 / 15333 | 2 | 2.89 | 4.43 | 3.72 |
| city-coarse | min screen area 0.20% | 11218.5 | 14507 / 15333 | 2 | 2.98 | 5.14 | 3.17 |
| city-coarse | min screen area 1.00% | 4144.4 | 14477 / 15333 | 2 | 1.27 | 1.80 | 1.61 |
| forest | no limit | 3896.2 | 30789 / 34909 | 773 | 2.36 | 2.61 | 3.07 |
| forest | cap 20000 tris | 1970 | 28827 / 34909 | 735 | 2.05 | 3.07 | 2.35 |
| forest | cap 10000 tris | 1293.1 | 25037 / 34909 | 454 | 1.53 | 2.13 | 2.17 |
| forest | cap 5000 tris | 794.8 | 20495 / 34909 | 278 | 1.16 | 1.53 | 1.55 |
| forest | cap 2000 tris | 374.9 | 14500 / 34909 | 117 | 1.28 | 1.64 | 1.57 |
| forest | min screen area 0.01% | 3777.1 | 30785 / 34909 | 773 | 2.38 | 2.66 | 3.00 |
| forest | min screen area 0.05% | 2931.5 | 30646 / 34909 | 773 | 1.79 | 2.35 | 2.84 |
| forest | min screen area 0.20% | 1967.8 | 28827 / 34909 | 735 | 1.77 | 2.67 | 2.37 |
| forest | min screen area 1.00% | 855 | 21040 / 34909 | 282 | 1.37 | 1.66 | 1.84 |

### 4. Wasm size (release, includes workload generators, oracle and temporal code)

simd128 module: 96157 B, gzip 37633 B. scalar module: 96565 B, gzip 37264 B.

### 5. Two cameras (256x128; ms p50 / p99; second camera: perspective side view or orthographic sun cascade)

| scene | second cam | environment | cam A | cam B | A+B in one go | B in frustum: instances / culled of tested | B false occluded (d1) |
|---|---|---|---|---|---|---|---|
| city-box | persp | native | 0.89 / 1.09 | 0.48 / 0.61 | 1.36 / 1.66 | 233.1 / 4706 of 4868 | 0 |
| city-box | persp | Node wasm simd | 1.21 / 1.65 | 0.70 / 0.95 | 1.91 / 2.56 | 233.1 / 4706 of 4868 | 0 |
| city-box | persp | Chromium wasm simd | 1.23 / 1.66 | 0.69 / 1.01 | 1.90 / 2.73 | 233.1 / 4706 of 4868 | 0 |
| city-box | ortho | native | 0.73 / 0.85 | 0.21 / 0.27 | 0.95 / 1.10 | 66.8 / 478 of 975 | 0 |
| city-box | ortho | Node wasm simd | 1.23 / 1.45 | 0.36 / 0.50 | 1.58 / 2.01 | 66.8 / 478 of 975 | 0 |
| city-box | ortho | Chromium wasm simd | 1.08 / 1.78 | 0.31 / 0.61 | 1.40 / 2.49 | 66.8 / 478 of 975 | 0 |
| city-coarse | persp | native | 3.38 / 4.74 | 1.47 / 2.59 | 4.84 / 7.98 | 235.5 / 4686 of 4861 | 0 |
| city-coarse | persp | Node wasm simd | 3.82 / 5.58 | 1.69 / 2.71 | 5.60 / 8.25 | 235.5 / 4686 of 4861 | 0 |
| city-coarse | persp | Chromium wasm simd | 3.65 / 6.69 | 1.71 / 3.26 | 5.37 / 9.88 | 235.5 / 4686 of 4861 | 0 |
| city-coarse | ortho | native | 3.23 / 4.42 | 0.65 / 0.96 | 3.88 / 5.69 | 68.9 / 438 of 975 | 0 |
| city-coarse | ortho | Node wasm simd | 3.66 / 6.37 | 0.78 / 1.32 | 4.47 / 7.63 | 68.9 / 438 of 975 | 0 |
| city-coarse | ortho | Chromium wasm simd | 3.71 / 6.49 | 0.82 / 1.26 | 4.52 / 7.49 | 68.9 / 438 of 975 | 0 |
| forest | persp | native | 1.95 / 3.25 | 0.94 / 1.66 | 2.86 / 4.92 | 380.6 / 6687 of 13900 | 76 |
| forest | persp | Node wasm simd | 2.36 / 3.26 | 1.17 / 1.61 | 3.52 / 5.01 | 380.6 / 6687 of 13900 | 76 |
| forest | persp | Chromium wasm simd | 2.85 / 4.35 | 1.30 / 1.97 | 4.16 / 6.28 | 380.6 / 6687 of 13900 | 76 |
| forest | ortho | native | 2.44 / 3.15 | 1.79 / 2.22 | 4.23 / 5.28 | 882.9 / 17 of 32392 | 1 |
| forest | ortho | Node wasm simd | 2.93 / 4.64 | 1.98 / 3.23 | 4.95 / 6.64 | 882.9 / 17 of 32392 | 1 |
| forest | ortho | Chromium wasm simd | 2.92 / 4.31 | 2.00 / 4.36 | 4.91 / 7.90 | 882.9 / 17 of 32392 | 1 |

### 6. Temporal (native, 256x128): fresh frame vs reprojecting last frame's tiles; culls vs oracle (8 frames summed)

| scene | fresh frame p50 ms | reproject+mip+test p50 ms | age (frames) | variant | buffer culled | lost | FALSE OCCLUDED |
|---|---|---|---|---|---|---|---|
| city-box | 0.96 | 0.39 | 1 | stale | 14359 (oracle 15182) | 823 | 0 |
| city-box | 0.96 | 0.39 | 1 | reprojected | 8239 (oracle 15182) | 6943 | 0 |
| city-box | 0.96 | 0.39 | 1 | fresh | 14353 (oracle 15182) | 829 | 0 |
| city-box | 0.96 | 0.39 | 4 | stale | 14320 (oracle 15182) | 869 | 7 |
| city-box | 0.96 | 0.39 | 4 | reprojected | 6905 (oracle 15182) | 8277 | 0 |
| city-box | 0.96 | 0.39 | 4 | fresh | 14353 (oracle 15182) | 829 | 0 |
| city-box | 0.96 | 0.39 | 12 | stale | 14149 (oracle 15182) | 1045 | 12 |
| city-box | 0.96 | 0.39 | 12 | reprojected | 5199 (oracle 15182) | 9983 | 0 |
| city-box | 0.96 | 0.39 | 12 | fresh | 14353 (oracle 15182) | 829 | 0 |
| forest | 2.17 | 0.87 | 1 | stale | 29740 (oracle 34192) | 5417 | 965 |
| forest | 2.17 | 0.87 | 1 | reprojected | 6515 (oracle 34192) | 27798 | 121 |
| forest | 2.17 | 0.87 | 1 | fresh | 29641 (oracle 34192) | 5401 | 850 |
| forest | 2.17 | 0.87 | 4 | stale | 30246 (oracle 34192) | 6010 | 2064 |
| forest | 2.17 | 0.87 | 4 | reprojected | 5455 (oracle 34192) | 28952 | 215 |
| forest | 2.17 | 0.87 | 4 | fresh | 29641 (oracle 34192) | 5401 | 850 |
| forest | 2.17 | 0.87 | 12 | stale | 30898 (oracle 34192) | 6497 | 3203 |
| forest | 2.17 | 0.87 | 12 | reprojected | 4466 (oracle 34192) | 29921 | 195 |
| forest | 2.17 | 0.87 | 12 | fresh | 29641 (oracle 34192) | 5401 | 850 |

### JS to wasm boundary (per frame, p50 ms, typed-array views over wasm memory)

| scene | environment | instances | occludees | bytes in | set instances (bulk) | write instances (JS loop) | set AABBs (bulk) | write AABBs (JS loop) | read vis (copy) | read vis (scan) | 1000 empty calls |
|---|---|---|---|---|---|---|---|---|---|---|---|
| city-box | Node wasm simd | 1024 | 3000 | 121152 | 0.001 | 0.014 | 0.002 | 0.021 | 0.001 | 0.003 | 0.002 |
| city-box | Chromium wasm simd | 1024 | 3000 | 121152 | 0.001 | 0.008 | 0.001 | 0.014 | 0.002 | 0.003 | 0.003 |
| city-coarse | Node wasm simd | 1024 | 3000 | 121152 | 0.001 | 0.016 | 0.001 | 0.029 | 0.003 | 0.003 | 0.003 |
| city-coarse | Chromium wasm simd | 1024 | 3000 | 121152 | 0.002 | 0.009 | 0.001 | 0.018 | 0.001 | 0.002 | 0.003 |
| forest | Node wasm simd | 2000 | 10000 | 336000 | 0.002 | 0.035 | 0.005 | 0.12 | 0.002 | 0.011 | 0.002 |
| forest | Chromium wasm simd | 2000 | 10000 | 336000 | 0.002 | 0.018 | 0.004 | 0.059 | 0.005 | 0.007 | 0.003 |

### Cross-environment determinism (visibility hash over 8 frames, must match everywhere)

98 job results compared native vs wasm: 0 mismatches.
