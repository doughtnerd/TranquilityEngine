| IR | kernels KB | whole zone KB (kernels + input spectra delay lines + rings + accumulators) | head partitions | tail partitions |
|---|---|---|---|---|
| 1 s stereo | 768 | 1665 | 32 | 22 |
| 2 s stereo | 1504 | 3137 | 32 | 45 |
| 4 s stereo | 3008 | 6145 | 32 | 92 |

Shared across zones (one set per core): FFT twiddles + scratch = 65536 B. M1's whole region for its 1.8 s IR = 3015744 B.
