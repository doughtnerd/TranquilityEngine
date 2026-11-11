# Stream-throughput spike: runner output

Date: 2026-11-11T18:04:05.021Z. Host: Linux 6.18.44-fc-v378 x86_64, 4 vCPUs, load before start: 0.39 0.63 0.69 1/118 10891

## build (1 s)

built

## q4 (1 s)


Q4 memory

Ring: 307200 B per stream (38400 frames x 2 ch x 4 B; stream.rs RING_STORAGE_FRAMES). Region: low 1.17 MB, default 2.34 MB, high 4.69 MB. Worker chunk-buffer pool: up to 16 x 32804 B = 0.50 MB shared (streams.ts POOL_MAX), ~8 in flight per stream.

Decoder worker, per open stream (wasm memory growth over 32 opens of the 82 s file; includes the stream's own copy of the encoded file):

| codec | file (MB) | total per stream (MB) | state beyond file+scratch (KB) |
|---|---|---|---|
| mp3-cbr192 | 1.89 | 1.96 | 39 |
| mp3-vbr | 1.32 | 1.40 | 58 |
| mp3-cbr128 | 1.26 | 1.35 | 61 |
| vorbis-q5 | 1.12 | 2.77 | 1654 |
| vorbis-q3 | 0.84 | 2.58 | 1744 |
| flac | 10.78 | 10.61 | 0 |
| wav | 15.08 | 14.71 | 0 |
| aac-192 (aac wasm) | 1.90 | 2.03 | 98 |

Core memory after init (every fixed region incl. rings, before any clip):

| preset | rings | memory after init (MB) | memory maximum (MB) |
|---|---|---|---|
| low | 4 | 28.1 | 86.5 |
| default | 8 | 30.3 | 150.6 |
| high | 16 | 32.8 | 278.8 |

Decoded 3-minute track in the arena:

| format | bytes (MB) | arena block (MB) | waste | fit in low 64 MB (registry / blocks) | default 128 MB | high 256 MB |
|---|---|---|---|---|---|---|
| stereo 48 kHz i16 | 32.96 | 40.00 | 21% | 1 / 1 | 3 / 3 | 7 / 6 |
| stereo 44.1 kHz i16 | 30.28 | 32.00 | 6% | 2 / 2 | 4 / 4 | 8 / 8 |
| mono 48 kHz i16 | 16.48 | 20.00 | 21% | 3 / 3 | 7 / 6 | 15 / 12 |
| stereo 48 kHz f32 (clipFormat f32) | 65.92 | 80.00 | 21% | 0 / 0 | 1 / 1 | 3 / 3 |

## q1 (27 s)


Q1 decode cost, one stream, 48 kHz stereo, readF32 x 4,096 frames (us per chunk; median over 5 runs of the per-run statistic; max = worst run). Chunk = 85.33 ms of audio.

| codec | kbps | p50 | p99 | p99.9 | max | mean | real-time factor (x) | % of 1 core per stream | i16 read p50 | open (us) | frames vs ffmpeg | SNR vs ffmpeg (dB) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| mp3-cbr192 | 192 | 137.0 | 213.9 | 625.6 | 1579.6 | 132.3 | 645 | 0.16 | 189.5 | 348 | 3952223 / 3952223 | 121.7 |
| mp3-vbr | 134 | 124.0 | 241.2 | 627.3 | 3452.3 | 126.8 | 673 | 0.15 | 180.5 | 243 | 3952223 / 3952223 | 121.8 |
| mp3-cbr128 | 128 | 129.4 | 188.3 | 451.2 | 6356.5 | 124.1 | 687 | 0.15 | 180.4 | 227 | 3952223 / 3952223 | 121.9 |
| vorbis-q5 | 115 | 138.2 | 253.4 | 721.9 | 13282.7 | 150.0 | 569 | 0.18 | 190.9 | 1669 | 3952223 / 3952223 | 137.4 |
| vorbis-q3 | 86 | 130.5 | 230.4 | 475.1 | 2277.0 | 139.3 | 613 | 0.16 | 182.4 | 1627 | 3952223 / 3952223 | 137.4 |
| flac | 1098 | 129.0 | 256.0 | 810.7 | 4216.5 | 134.8 | 633 | 0.16 | 181.5 | 1822 | 3952223 / 3952223 | 331.6 |
| wav | 1536 | 31.3 | 61.0 | 194.5 | 1319.4 | 32.0 | 2667 | 0.04 | 83.0 | 2548 | 3952223 / 3952223 | 331.6 |
| aac-192 (aac wasm) | 194 | 126.0 | 223.9 | 450.5 | 2216.3 | 135.1 | 631 | 0.16 | 179.3 | 670 | 3952223 / 3952640 | 132.5 |

