# Stream-throughput spike: runner output

Date: 2026-11-11T17:51:41.394Z (SMOKE, not for the record). Host: Linux 6.18.44-fc-v378 x86_64, 4 vCPUs, load before start: 2.17 1.36 0.62 2/131 7917

## build (1 s)

built

## q4 (2 s)


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

## q1 (7 s)


Q1 decode cost, one stream, 48 kHz stereo, readF32 x 4,096 frames (us per chunk; median over 1 runs of the per-run statistic; max = worst run). Chunk = 85.33 ms of audio.

| codec | kbps | p50 | p99 | p99.9 | max | mean | real-time factor (x) | % of 1 core per stream | i16 read p50 | open (us) | frames vs ffmpeg | SNR vs ffmpeg (dB) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| mp3-cbr192 | 192 | 138.9 | 207.1 | 1101.9 | 1101.9 | 134.3 | 635 | 0.16 | 190.3 | 1306 | 3952223 / 3952223 | 121.7 |
| mp3-vbr | 134 | 123.5 | 207.5 | 999.9 | 999.9 | 120.6 | 708 | 0.14 | 175.9 | 989 | 3952223 / 3952223 | 121.8 |
| mp3-cbr128 | 128 | 130.3 | 217.5 | 1037.1 | 1037.1 | 125.7 | 679 | 0.15 | 185.2 | 894 | 3952223 / 3952223 | 121.9 |
| vorbis-q5 | 115 | 136.7 | 198.9 | 257.8 | 257.8 | 142.6 | 598 | 0.17 | 191.3 | 2992 | 3952223 / 3952223 | 137.4 |
| vorbis-q3 | 86 | 133.1 | 288.3 | 744.9 | 744.9 | 146.2 | 584 | 0.17 | 183.6 | 3445 | 3952223 / 3952223 | 137.4 |
| flac | 1098 | 128.9 | 281.4 | 934.1 | 934.1 | 129.4 | 660 | 0.15 | 180.1 | 7096 | 3952223 / 3952223 | 331.6 |
| wav | 1536 | 31.7 | 57.8 | 1250.3 | 1250.3 | 32.8 | 2603 | 0.04 | 83.7 | 9744 | 3952223 / 3952223 | 331.6 |
| aac-192 (aac wasm) | 194 | 127.0 | 255.0 | 1198.3 | 1198.3 | 135.1 | 632 | 0.16 | 180.7 | 1737 | 3952223 / 3952640 | 132.5 |

## q2 (41 s)


Q2 concurrency: 1 runs x 8 s each. Worker busy % = event-loop utilisation of the worker thread (= fraction of one core); refill = credit posted -> its chunk received (the worker's response time); start = open -> first sample played (needs 4096 frames); min ring = fewest frames buffered after a 3 s warm-up (starve below 368). Median over runs, max = worst run, starves = total over runs.

| codec | N | worker busy % | start p50 (ms) | start max (ms) | refill p50 (ms) | p99 | p99.9 | max | min ring (frames) | starves | opened (min over runs) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| mp3-cbr192 | 4 | 2.64 | 5 | 40 | 4.1 | 8.3 | 8.6 | 8.6 | 28416 | 0 | 4 |
| mp3-cbr192 | 16 | 6.87 | 53 | 88 | 3.8 | 5.5 | 7.9 | 7.9 | 28544 | 0 | 16 |
| mp3-cbr192 | 32 | 11.78 | 85 | 147 | 3.7 | 4.7 | 6.8 | 8.4 | 28544 | 0 | 32 |
| vorbis-q5 | 16 | 8.25 | 59 | 101 | 3.7 | 6.9 | 12.1 | 12.1 | 28544 | 0 | 16 |
| flac | 16 | 8.07 | 227 | 328 | 3.8 | 6.6 | 8.2 | 8.2 | 28544 | 0 | 16 |

## q2clip (16 s)


Q2 concurrency + a whole-clip decode of the same file every 3 s in the same worker: 1 runs x 8 s each. Worker busy % = event-loop utilisation of the worker thread (= fraction of one core); refill = credit posted -> its chunk received (the worker's response time); start = open -> first sample played (needs 4096 frames); min ring = fewest frames buffered after a 3 s warm-up (starve below 368). Median over runs, max = worst run, starves = total over runs.

| codec | N | worker busy % | start p50 (ms) | start max (ms) | refill p50 (ms) | p99 | p99.9 | max | min ring (frames) | starves | opened (min over runs) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| mp3-cbr192 | 8 | 10.70 | 8 | 8 | 4.5 | 6.3 | 6.4 | 6.4 | 28544 | 0 | 8 |
| mp3-cbr192 | 16 | 13.30 | 27 | 64 | 4.1 | 7.9 | 13.7 | 13.7 | 28288 | 0 | 16 |

## q3 (19 s)


Q3 Chromium (Chrome/153.0.0.0), real-time AudioContext, null sink, 1 runs x 10 s per config. starved = core stream-starvation reports (STATUS starved + stream event 1); underruns = shell probe (drift vs wall clock). Totals over runs.

| preset | rings | N (streams) | codec | starved (sum) | stream evt 1 (sum) | stream evt 3 = refused/error (sum) | underruns (sum) | underrun frames | late cmds | live voices (max) | output peak | status blocks | streams opened | audio s / wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| high | 16 | 16 | mp3-cbr192 (10 s) | 0 | 0 | 0 | 0 | 0 | 0 | 16 | 0.068 | 111 | 16 | 10.1 / 10.1 |
| low | 4 | 8 | mp3-cbr192 (6 s) | 0 | 0 | 4 | 0 | 0 | 0 | 8 | 0.082 | 80 | 8 | 6.0 / 6.0 |

## q3control (10 s)


Q3 Chromium (Chrome/153.0.0.0), real-time AudioContext, null sink, 1 runs x 8 s per config. starved = core stream-starvation reports (STATUS starved + stream event 1); underruns = shell probe (drift vs wall clock). Totals over runs.

| preset | rings | N (streams) | codec | starved (sum) | stream evt 1 (sum) | stream evt 3 = refused/error (sum) | underruns (sum) | underrun frames | late cmds | live voices (max) | output peak | status blocks | streams opened | audio s / wall s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| default | 8 | 8 | mp3-cbr192 (8 s) | 8 | 8 | 0 | 0 | 0 | 0 | 8 | 0.109 | 96 | 8 | 8.0 / 8.0 |

