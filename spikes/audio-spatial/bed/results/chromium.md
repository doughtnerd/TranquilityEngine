Runs: 7 x 6000 quanta (+500 warm-up each). Per metric: median over runs of the per-run p50/p99/p99.9; max = worst run. Quantum = 2666.7 us. Cells: us (% of quantum).

### chromium-audioworklet - the shared clock is quantised to 5 us in the data (all cases with k=1); time from a spinning worker writing performance.now() into a SharedArrayBuffer (no performance in the worklet; the spinner occupies one core); cheap cases are timed as the mean of k quanta (k in the case entry)

| case | p50 | p99 | p99.9 | max |
|---|---|---|---|---|
| bed64 | 50.0 (1.88%) | 100.0 (3.75%) | 335.0 (12.56%) | 4325.0 (162.19%) |
| bed256 | 175.0 (6.56%) | 330.0 (12.38%) | 1300.0 (48.75%) | 7345.0 (275.44%) |
| bed1024 | 705.0 (26.44%) | 1340.0 (50.25%) | 2705.0 (101.44%) | 9670.0 (362.62%) |
| bed256_spk | 220.0 (8.25%) | 405.0 (15.19%) | 880.0 (33.00%) | 5540.0 (207.75%) |
| decode_sh | 20.3 (0.76%) | 39.0 (1.46%) | 84.3 (3.16%) | 1176.3 (44.11%) |
| decode_spk | 42.8 (1.60%) | 71.1 (2.67%) | 148.3 (5.56%) | 991.7 (37.19%) |
| clip_foa_rot | 1.16 (0.04%) | 2.15 (0.08%) | 4.65 (0.17%) | 176.9 (6.63%) |
| clip_foa_dec | 7.44 (0.28%) | 14.3 (0.54%) | 24.3 (0.91%) | 208.9 (7.83%) |
| clip_o3_rot | 5.17 (0.19%) | 8.92 (0.33%) | 17.9 (0.67%) | 103.3 (3.87%) |
| clip_o3_dec | 24.6 (0.92%) | 46.5 (1.75%) | 105.0 (3.94%) | 498.8 (18.71%) |
| dop256_const | 355.0 (13.31%) | 530.0 (19.87%) | 1270.0 (47.63%) | 15215.0 (570.56%) |
| dop256_pitch | 350.0 (13.13%) | 620.0 (23.25%) | 1235.0 (46.31%) | 11245.0 (421.69%) |
| dop256_full | 355.0 (13.31%) | 635.0 (23.81%) | 1045.0 (39.19%) | 12105.0 (453.94%) |
| hrtf16 | 215.0 (8.06%) | 370.0 (13.87%) | 1165.0 (43.69%) | 3880.0 (145.50%) |
| bed16 | 29.0 (1.09%) | 59.0 (2.21%) | 148.5 (5.57%) | 1058.5 (39.69%) |
| xfade16 | 245.0 (9.19%) | 445.0 (16.69%) | 995.0 (37.31%) | 4745.0 (177.94%) |

### Checksums after 50 quanta (native / node wasm / chromium)

- bed64: - / - / -14.696117
- bed256: - / - / -34.031907
- bed1024: - / - / -43.193019
- bed256_spk: - / - / -35.095107
- decode_sh: - / - / -0.976238
- decode_spk: - / - / -0.531236
- clip_foa_rot: - / - / 0.070338
- clip_foa_dec: - / - / -0.372936
- clip_o3_rot: - / - / 0.233948
- clip_o3_dec: - / - / -1.676198
- dop256_const: - / - / 0.047284
- dop256_pitch: - / - / -1.305574
- dop256_full: - / - / -2.658781
- hrtf16: - / - / 4.088544
- bed16: - / - / 3.441623
- xfade16: - / - / 3.764883
