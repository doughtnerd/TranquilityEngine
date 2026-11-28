Run 2026-11-28T02:04:30.883Z; Intel(R) Xeon(R) Processor @ 2.10GHz x4; load 0.54/1.26/1.85; 7 runs x 40 frames per job; rustc 1.97.0 (2d8144b78 2026-07-07); node v22.23.5; chromium 158.0.8127.36 (cross-origin isolated). wasm: {"simd":{"bytes":96157,"gzip":37633},"scalar":{"bytes":96565,"gzip":37264}}

### 1. Frame cost, one camera, ms per frame (p50 / p99 / max)

**city-box**

| buffer | environment | path | total p50 | p99 | max | clear | select | setup | raster | mip | test |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 256x128 | native | simd | 0.93 | 2.12 | 4.50 | 0.002 | 0.010 | 0.24 | 0.35 | 0.004 | 0.30 |
| 256x128 | native | scalar | 1.71 | 2.31 | 2.64 | 0.002 | 0.011 | 0.24 | 1.04 | 0.085 | 0.31 |
| 256x128 | Node wasm simd | simd | 1.21 | 3.12 | 4.24 | 0.002 | 0.012 | 0.27 | 0.52 | 0.012 | 0.40 |
| 256x128 | Node wasm simd | scalar | 1.83 | 2.87 | 3.00 | 0.002 | 0.013 | 0.27 | 1.13 | 0.057 | 0.45 |
| 256x128 | Node wasm scalar | scalar | 1.98 | 3.03 | 3.45 | 0.002 | 0.013 | 0.28 | 1.14 | 0.057 | 0.46 |
| 256x128 | Chromium wasm simd | simd | 1.20 | 1.33 | 1.41 | 0.000 | 0.010 | 0.25 | 0.54 | 0.010 | 0.38 |
| 256x128 | Chromium wasm simd | scalar | 1.86 | 2.74 | 2.88 | 0.000 | 0.015 | 0.25 | 1.06 | 0.060 | 0.44 |
| 256x128 | Chromium wasm scalar | scalar | 1.87 | 2.88 | 4.85 | 0.005 | 0.015 | 0.26 | 1.08 | 0.060 | 0.46 |
| 320x180 | native | simd | 1.09 | 1.60 | 2.57 | 0.004 | 0.011 | 0.25 | 0.54 | 0.009 | 0.33 |
| 320x180 | native | scalar | 2.41 | 3.45 | 5.77 | 0.004 | 0.011 | 0.24 | 1.63 | 0.15 | 0.32 |
| 320x180 | Node wasm simd | simd | 1.52 | 1.63 | 1.67 | 0.004 | 0.012 | 0.27 | 0.80 | 0.020 | 0.42 |
| 320x180 | Node wasm simd | scalar | 2.59 | 2.83 | 2.88 | 0.004 | 0.013 | 0.27 | 1.73 | 0.098 | 0.48 |
| 320x180 | Node wasm scalar | scalar | 2.60 | 3.84 | 5.82 | 0.004 | 0.012 | 0.27 | 1.66 | 0.095 | 0.45 |
| 320x180 | Chromium wasm simd | simd | 1.53 | 2.06 | 4.14 | 0.005 | 0.015 | 0.25 | 0.84 | 0.025 | 0.41 |
| 320x180 | Chromium wasm simd | scalar | 2.48 | 2.94 | 3.01 | 0.005 | 0.015 | 0.26 | 1.66 | 0.10 | 0.47 |
| 320x180 | Chromium wasm scalar | scalar | 2.44 | 3.02 | 5.13 | 0.005 | 0.015 | 0.25 | 1.54 | 0.095 | 0.45 |
| 512x256 | native | simd | 1.57 | 2.58 | 2.82 | 0.010 | 0.013 | 0.27 | 1.00 | 0.025 | 0.36 |
| 512x256 | native | scalar | 4.06 | 4.34 | 5.03 | 0.009 | 0.011 | 0.24 | 3.12 | 0.35 | 0.35 |
| 512x256 | Node wasm simd | simd | 2.29 | 4.55 | 8.34 | 0.010 | 0.013 | 0.27 | 1.48 | 0.045 | 0.45 |
| 512x256 | Node wasm simd | scalar | 4.35 | 4.76 | 4.84 | 0.010 | 0.013 | 0.27 | 3.34 | 0.22 | 0.53 |
| 512x256 | Node wasm scalar | scalar | 4.34 | 4.69 | 4.71 | 0.010 | 0.013 | 0.28 | 3.36 | 0.22 | 0.51 |
| 512x256 | Chromium wasm simd | simd | 2.35 | 4.04 | 7.26 | 0.010 | 0.015 | 0.25 | 1.50 | 0.050 | 0.42 |
| 512x256 | Chromium wasm simd | scalar | 4.21 | 5.16 | 6.36 | 0.010 | 0.015 | 0.25 | 3.13 | 0.22 | 0.51 |
| 512x256 | Chromium wasm scalar | scalar | 4.21 | 7.87 | 8.04 | 0.010 | 0.015 | 0.27 | 3.21 | 0.23 | 0.51 |

**city-coarse**

| buffer | environment | path | total p50 | p99 | max | clear | select | setup | raster | mip | test |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 256x128 | native | simd | 3.51 | 5.57 | 6.10 | 0.002 | 0.011 | 2.36 | 0.84 | 0.006 | 0.31 |
| 256x128 | native | scalar | 4.74 | 7.34 | 7.49 | 0.002 | 0.011 | 2.29 | 2.00 | 0.086 | 0.31 |
| 256x128 | Node wasm simd | simd | 3.85 | 6.56 | 7.60 | 0.002 | 0.014 | 2.37 | 1.06 | 0.013 | 0.41 |
| 256x128 | Node wasm simd | scalar | 5.05 | 5.94 | 6.37 | 0.002 | 0.014 | 2.37 | 2.16 | 0.063 | 0.45 |
| 256x128 | Node wasm scalar | scalar | 5.06 | 5.41 | 5.88 | 0.003 | 0.014 | 2.40 | 2.15 | 0.063 | 0.45 |
| 256x128 | Chromium wasm simd | simd | 3.89 | 6.64 | 6.83 | 0.005 | 0.015 | 2.26 | 1.11 | 0.015 | 0.40 |
| 256x128 | Chromium wasm simd | scalar | 4.85 | 7.05 | 8.38 | 0.005 | 0.015 | 2.25 | 2.07 | 0.065 | 0.44 |
| 256x128 | Chromium wasm scalar | scalar | 4.84 | 5.26 | 5.42 | 0.005 | 0.015 | 2.29 | 2.08 | 0.065 | 0.46 |
| 320x180 | native | simd | 3.86 | 6.50 | 7.20 | 0.004 | 0.011 | 2.26 | 1.17 | 0.011 | 0.31 |
| 320x180 | native | scalar | 5.99 | 9.42 | 10.2 | 0.004 | 0.012 | 2.35 | 3.07 | 0.15 | 0.32 |
| 320x180 | Node wasm simd | simd | 4.46 | 5.11 | 5.86 | 0.004 | 0.014 | 2.44 | 1.61 | 0.023 | 0.43 |
| 320x180 | Node wasm simd | scalar | 6.33 | 8.10 | 8.24 | 0.004 | 0.015 | 2.45 | 3.31 | 0.11 | 0.50 |
| 320x180 | Node wasm scalar | scalar | 6.43 | 8.44 | 10.2 | 0.004 | 0.015 | 2.49 | 3.31 | 0.11 | 0.49 |
| 320x180 | Chromium wasm simd | simd | 4.50 | 8.54 | 9.08 | 0.005 | 0.015 | 2.33 | 1.67 | 0.025 | 0.42 |
| 320x180 | Chromium wasm simd | scalar | 5.93 | 8.02 | 8.41 | 0.005 | 0.015 | 2.25 | 3.08 | 0.11 | 0.47 |
| 320x180 | Chromium wasm scalar | scalar | 6.04 | 9.54 | 9.77 | 0.005 | 0.015 | 2.41 | 3.18 | 0.12 | 0.49 |
| 512x256 | native | simd | 4.66 | 7.98 | 9.49 | 0.009 | 0.012 | 2.31 | 2.01 | 0.028 | 0.33 |
| 512x256 | native | scalar | 8.33 | 12.0 | 12.3 | 0.009 | 0.013 | 2.36 | 5.39 | 0.35 | 0.34 |
| 512x256 | Node wasm simd | simd | 5.83 | 8.39 | 8.47 | 0.010 | 0.015 | 2.47 | 2.86 | 0.052 | 0.45 |
| 512x256 | Node wasm simd | scalar | 9.47 | 14.6 | 21.5 | 0.010 | 0.016 | 2.48 | 5.86 | 0.25 | 0.53 |
| 512x256 | Node wasm scalar | scalar | 9.32 | 13.7 | 19.1 | 0.010 | 0.015 | 2.53 | 5.97 | 0.25 | 0.51 |
| 512x256 | Chromium wasm simd | simd | 5.67 | 6.90 | 8.85 | 0.010 | 0.015 | 2.32 | 2.97 | 0.050 | 0.43 |
| 512x256 | Chromium wasm simd | scalar | 8.88 | 13.5 | 15.0 | 0.010 | 0.015 | 2.31 | 5.57 | 0.25 | 0.51 |
| 512x256 | Chromium wasm scalar | scalar | 8.95 | 14.0 | 16.3 | 0.010 | 0.015 | 2.42 | 5.73 | 0.25 | 0.52 |

**forest**

| buffer | environment | path | total p50 | p99 | max | clear | select | setup | raster | mip | test |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 256x128 | native | simd | 2.17 | 2.49 | 2.53 | 0.002 | 0.029 | 0.99 | 0.32 | 0.004 | 1.06 |
| 256x128 | native | scalar | 2.93 | 3.22 | 3.50 | 0.002 | 0.030 | 1.01 | 0.67 | 0.085 | 1.12 |
| 256x128 | Node wasm simd | simd | 2.79 | 5.52 | 9.60 | 0.002 | 0.035 | 1.10 | 0.42 | 0.012 | 1.41 |
| 256x128 | Node wasm simd | scalar | 3.73 | 4.40 | 4.66 | 0.002 | 0.036 | 1.12 | 0.73 | 0.071 | 1.78 |
| 256x128 | Node wasm scalar | scalar | 3.93 | 5.31 | 5.78 | 0.002 | 0.035 | 1.11 | 0.70 | 0.070 | 1.69 |
| 256x128 | Chromium wasm simd | simd | 2.87 | 3.20 | 3.24 | 0.000 | 0.035 | 1.04 | 0.45 | 0.010 | 1.33 |
| 256x128 | Chromium wasm simd | scalar | 3.41 | 6.05 | 9.18 | 0.005 | 0.035 | 1.03 | 0.67 | 0.070 | 1.67 |
| 256x128 | Chromium wasm scalar | scalar | 3.57 | 5.92 | 6.15 | 0.000 | 0.035 | 1.07 | 0.72 | 0.070 | 1.71 |
| 320x180 | native | simd | 2.68 | 4.32 | 4.87 | 0.004 | 0.030 | 0.99 | 0.50 | 0.008 | 1.09 |
| 320x180 | native | scalar | 3.34 | 5.24 | 6.86 | 0.004 | 0.031 | 1.02 | 1.07 | 0.15 | 1.20 |
| 320x180 | Node wasm simd | simd | 3.14 | 3.58 | 3.70 | 0.004 | 0.035 | 1.11 | 0.67 | 0.020 | 1.47 |
| 320x180 | Node wasm simd | scalar | 4.42 | 7.07 | 7.72 | 0.004 | 0.035 | 1.12 | 1.10 | 0.12 | 1.93 |
| 320x180 | Node wasm scalar | scalar | 4.30 | 6.64 | 7.21 | 0.004 | 0.036 | 1.15 | 1.13 | 0.12 | 1.85 |
| 320x180 | Chromium wasm simd | simd | 3.23 | 4.47 | 4.63 | 0.005 | 0.035 | 1.05 | 0.71 | 0.020 | 1.40 |
| 320x180 | Chromium wasm simd | scalar | 4.24 | 6.63 | 8.78 | 0.005 | 0.035 | 1.03 | 1.05 | 0.12 | 1.79 |
| 320x180 | Chromium wasm scalar | scalar | 4.12 | 5.10 | 5.65 | 0.005 | 0.035 | 1.06 | 1.08 | 0.12 | 1.81 |
| 512x256 | native | simd | 3.19 | 3.93 | 4.26 | 0.009 | 0.030 | 0.94 | 0.87 | 0.020 | 1.11 |
| 512x256 | native | scalar | 4.54 | 5.92 | 6.37 | 0.010 | 0.030 | 0.99 | 1.89 | 0.34 | 1.26 |
| 512x256 | Node wasm simd | simd | 4.14 | 7.57 | 9.76 | 0.011 | 0.037 | 1.17 | 1.36 | 0.049 | 1.64 |
| 512x256 | Node wasm simd | scalar | 5.96 | 8.63 | 12.3 | 0.010 | 0.035 | 1.14 | 2.05 | 0.25 | 2.22 |
| 512x256 | Node wasm scalar | scalar | 5.51 | 8.68 | 9.07 | 0.010 | 0.036 | 1.17 | 2.09 | 0.25 | 2.08 |
| 512x256 | Chromium wasm simd | simd | 4.14 | 5.34 | 5.55 | 0.010 | 0.035 | 1.08 | 1.36 | 0.050 | 1.52 |
| 512x256 | Chromium wasm simd | scalar | 5.43 | 7.31 | 7.79 | 0.010 | 0.035 | 1.09 | 2.03 | 0.26 | 2.18 |
| 512x256 | Chromium wasm scalar | scalar | 5.44 | 5.89 | 6.12 | 0.010 | 0.035 | 1.09 | 2.00 | 0.25 | 2.04 |

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
| city-box | 0 | 14507 | 15353 | 846 | 0 | 10 | 0.93 |
| city-box | 0.25 | 14077 | 15353 | 1276 | 0 | 0 | 0.92 |
| city-box | 0.5 | 13516 | 15353 | 1837 | 0 | 0 | 0.89 |
| city-coarse | 0 | 14508 | 15333 | 827 | 2 | 8 | 3.51 |
| city-coarse | 0.25 | 13970 | 15333 | 1363 | 0 | 1 | 3.38 |
| city-coarse | 0.5 | 13346 | 15333 | 1987 | 0 | 0 | 3.27 |
| forest | 0 | 30789 | 34909 | 4893 | 773 | 1599 | 2.17 |
| forest | 0.25 | 9641 | 34909 | 25268 | 0 | 3 | 2.22 |
| forest | 0.5 | 5228 | 34909 | 29681 | 0 | 0 | 2.10 |

### 3. Occluder selection (256x128, native simd; Node wasm simd total p50 in last column)

| scene | setting | tris rasterised | buffer culled / oracle culled (dilate 1) | false occluded | native p50 ms | native p99 | node wasm p50 ms |
|---|---|---|---|---|---|---|---|
| city-coarse | no limit | 14167.4 | 14508 / 15333 | 2 | 3.51 | 5.57 | 3.85 |
| city-coarse | cap 20000 tris | 4904.8 | 14480 / 15333 | 2 | 1.47 | 2.28 | 1.87 |
| city-coarse | cap 10000 tris | 2537.4 | 14266 / 15333 | 2 | 1.07 | 1.48 | 1.36 |
| city-coarse | cap 5000 tris | 1194.8 | 13856 / 15333 | 2 | 0.76 | 1.40 | 1.03 |
| city-coarse | cap 2000 tris | 386.1 | 13323 / 15333 | 2 | 0.57 | 0.65 | 0.79 |
| city-coarse | min screen area 0.01% | 14167.4 | 14508 / 15333 | 2 | 3.52 | 4.79 | 3.75 |
| city-coarse | min screen area 0.05% | 14129 | 14508 / 15333 | 2 | 3.30 | 4.35 | 3.79 |
| city-coarse | min screen area 0.20% | 11218.5 | 14507 / 15333 | 2 | 2.76 | 3.11 | 3.21 |
| city-coarse | min screen area 1.00% | 4144.4 | 14477 / 15333 | 2 | 1.34 | 1.64 | 1.67 |
| forest | no limit | 3896.2 | 30789 / 34909 | 773 | 2.17 | 2.49 | 2.79 |
| forest | cap 20000 tris | 1970 | 28827 / 34909 | 735 | 1.97 | 2.41 | 2.55 |
| forest | cap 10000 tris | 1293.1 | 25037 / 34909 | 454 | 1.66 | 2.00 | 2.77 |
| forest | cap 5000 tris | 794.8 | 20495 / 34909 | 278 | 1.44 | 1.53 | 1.89 |
| forest | cap 2000 tris | 374.9 | 14500 / 34909 | 117 | 1.26 | 1.34 | 1.66 |
| forest | min screen area 0.01% | 3777.1 | 30785 / 34909 | 773 | 2.42 | 3.30 | 2.97 |
| forest | min screen area 0.05% | 2931.5 | 30646 / 34909 | 773 | 2.25 | 3.38 | 2.84 |
| forest | min screen area 0.20% | 1967.8 | 28827 / 34909 | 735 | 1.97 | 2.30 | 2.45 |
| forest | min screen area 1.00% | 855 | 21040 / 34909 | 282 | 1.44 | 1.87 | 1.87 |

### 4. Wasm size (release, includes workload generators, oracle and temporal code)

simd128 module: 96157 B, gzip 37633 B. scalar module: 96565 B, gzip 37264 B.

### 5. Two cameras (256x128; ms p50 / p99; second camera: perspective side view or orthographic sun cascade)

| scene | second cam | environment | cam A | cam B | A+B in one go | B in frustum: instances / culled of tested | B false occluded (d1) |
|---|---|---|---|---|---|---|---|
| city-box | persp | native | 0.94 / 1.44 | 0.50 / 0.78 | 1.43 / 2.18 | 233.1 / 4706 of 4868 | 0 |
| city-box | persp | Node wasm simd | 1.24 / 2.40 | 0.71 / 1.54 | 1.94 / 4.80 | 233.1 / 4706 of 4868 | 0 |
| city-box | persp | Chromium wasm simd | 1.21 / 1.71 | 0.69 / 1.04 | 1.90 / 2.65 | 233.1 / 4706 of 4868 | 0 |
| city-box | ortho | native | 0.91 / 1.00 | 0.27 / 0.30 | 1.18 / 1.26 | 66.8 / 478 of 975 | 0 |
| city-box | ortho | Node wasm simd | 1.24 / 1.67 | 0.36 / 0.58 | 1.60 / 2.28 | 66.8 / 478 of 975 | 0 |
| city-box | ortho | Chromium wasm simd | 1.24 / 4.14 | 0.35 / 0.63 | 1.58 / 2.24 | 66.8 / 478 of 975 | 0 |
| city-coarse | persp | native | 3.52 / 6.03 | 1.51 / 2.47 | 5.03 / 7.92 | 235.5 / 4686 of 4861 | 0 |
| city-coarse | persp | Node wasm simd | 3.98 / 6.25 | 1.80 / 3.25 | 5.75 / 9.01 | 235.5 / 4686 of 4861 | 0 |
| city-coarse | persp | Chromium wasm simd | 3.76 / 5.65 | 1.75 / 2.38 | 5.50 / 8.44 | 235.5 / 4686 of 4861 | 0 |
| city-coarse | ortho | native | 3.53 / 5.35 | 0.71 / 1.26 | 4.24 / 6.87 | 68.9 / 438 of 975 | 0 |
| city-coarse | ortho | Node wasm simd | 3.92 / 6.63 | 0.83 / 1.48 | 4.75 / 7.94 | 68.9 / 438 of 975 | 0 |
| city-coarse | ortho | Chromium wasm simd | 3.76 / 4.13 | 0.81 / 0.97 | 4.55 / 5.06 | 68.9 / 438 of 975 | 0 |
| forest | persp | native | 2.45 / 3.92 | 1.17 / 2.08 | 3.62 / 6.20 | 380.6 / 6687 of 13900 | 76 |
| forest | persp | Node wasm simd | 3.01 / 4.20 | 1.46 / 2.04 | 4.48 / 5.76 | 380.6 / 6687 of 13900 | 76 |
| forest | persp | Chromium wasm simd | 2.88 / 4.05 | 1.38 / 2.10 | 4.27 / 6.15 | 380.6 / 6687 of 13900 | 76 |
| forest | ortho | native | 2.47 / 3.55 | 1.80 / 2.87 | 4.29 / 6.34 | 882.9 / 17 of 32392 | 1 |
| forest | ortho | Node wasm simd | 3.00 / 4.45 | 2.06 / 3.10 | 5.07 / 7.43 | 882.9 / 17 of 32392 | 1 |
| forest | ortho | Chromium wasm simd | 2.92 / 4.81 | 2.00 / 3.31 | 4.92 / 8.00 | 882.9 / 17 of 32392 | 1 |

### 6. Temporal (native, 256x128): fresh frame vs reprojecting last frame's tiles; culls vs oracle (8 frames summed)

| scene | fresh frame p50 ms | reproject+mip+test p50 ms | age (frames) | variant | buffer culled | lost | FALSE OCCLUDED |
|---|---|---|---|---|---|---|---|
| city-box | 0.95 | 0.38 | 1 | stale | 14359 (oracle 15182) | 823 | 0 |
| city-box | 0.95 | 0.38 | 1 | reprojected | 8239 (oracle 15182) | 6943 | 0 |
| city-box | 0.95 | 0.38 | 1 | fresh | 14353 (oracle 15182) | 829 | 0 |
| city-box | 0.95 | 0.38 | 4 | stale | 14320 (oracle 15182) | 869 | 7 |
| city-box | 0.95 | 0.38 | 4 | reprojected | 6905 (oracle 15182) | 8277 | 0 |
| city-box | 0.95 | 0.38 | 4 | fresh | 14353 (oracle 15182) | 829 | 0 |
| city-box | 0.95 | 0.38 | 12 | stale | 14149 (oracle 15182) | 1045 | 12 |
| city-box | 0.95 | 0.38 | 12 | reprojected | 5199 (oracle 15182) | 9983 | 0 |
| city-box | 0.95 | 0.38 | 12 | fresh | 14353 (oracle 15182) | 829 | 0 |
| forest | 2.50 | 1.00 | 1 | stale | 29740 (oracle 34192) | 5417 | 965 |
| forest | 2.50 | 1.00 | 1 | reprojected | 6515 (oracle 34192) | 27798 | 121 |
| forest | 2.50 | 1.00 | 1 | fresh | 29641 (oracle 34192) | 5401 | 850 |
| forest | 2.50 | 1.00 | 4 | stale | 30246 (oracle 34192) | 6010 | 2064 |
| forest | 2.50 | 1.00 | 4 | reprojected | 5455 (oracle 34192) | 28952 | 215 |
| forest | 2.50 | 1.00 | 4 | fresh | 29641 (oracle 34192) | 5401 | 850 |
| forest | 2.50 | 1.00 | 12 | stale | 30898 (oracle 34192) | 6497 | 3203 |
| forest | 2.50 | 1.00 | 12 | reprojected | 4466 (oracle 34192) | 29921 | 195 |
| forest | 2.50 | 1.00 | 12 | fresh | 29641 (oracle 34192) | 5401 | 850 |

### JS to wasm boundary (per frame, p50 ms, typed-array views over wasm memory)

| scene | environment | instances | occludees | bytes in | set instances (bulk) | write instances (JS loop) | set AABBs (bulk) | write AABBs (JS loop) | read vis (copy) | read vis (scan) | 1000 empty calls |
|---|---|---|---|---|---|---|---|---|---|---|---|
| city-box | Node wasm simd | 1024 | 3000 | 121152 | 0.001 | 0.015 | 0.002 | 0.022 | 0.001 | 0.003 | 0.002 |
| city-box | Chromium wasm simd | 1024 | 3000 | 121152 | 0.001 | 0.010 | 0.002 | 0.018 | 0.002 | 0.003 | 0.003 |
| city-coarse | Node wasm simd | 1024 | 3000 | 121152 | 0.001 | 0.018 | 0.002 | 0.032 | 0.001 | 0.004 | 0.003 |
| city-coarse | Chromium wasm simd | 1024 | 3000 | 121152 | 0.002 | 0.011 | 0.002 | 0.022 | 0.002 | 0.003 | 0.003 |
| forest | Node wasm simd | 2000 | 10000 | 336000 | 0.002 | 0.035 | 0.005 | 0.12 | 0.002 | 0.012 | 0.003 |
| forest | Chromium wasm simd | 2000 | 10000 | 336000 | 0.002 | 0.022 | 0.005 | 0.075 | 0.005 | 0.009 | 0.003 |

### Cross-environment determinism (visibility hash over 8 frames, must match everywhere)

98 job results compared native vs wasm: 0 mismatches.
