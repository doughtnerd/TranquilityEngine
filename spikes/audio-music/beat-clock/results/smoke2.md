# beat-clock results: 1 runs x 10 s, latencyHint interactive (baseLatency 0.010 s, outputLatency 0.032 s), sr 44100, limiter D = 66 frames, frame interval 16.665 ms (60.006 Hz)

truth line: sliding fit +-4 s; sliding-fit residual p99 4.933 ms;

render-clock fit: 3.113 ppm vs nominal, residual p99 4.945 ms; K (heard minus render clock) median 34.804 ms; STATUS period 17.426 ms

## Q2 clock error vs the audio clock (ms; offset removed; steady frames; per run then median over runs)
| estimator | const offset ms | p50 | p99 | p99.9 | max | f2f jitter std | f2f |d| p99 | drift ms/min |
|---|---|---|---|---|---|---|---|---|
| ClockMap | -0.000 | 0.007 | 0.043 | 0.058 | 0.058 | 0.004 | 0.010 | 0.142 |
| getOutputTimestamp (raw, per frame) | 0.003 | 0.019 | 0.094 | 0.654 | 0.654 | 0.056 | 0.108 | 0.139 |
| currentTime (raw, no latency comp.) | 37.159 | 2.621 | 4.845 | 6.360 | 6.360 | 4.842 | 7.963 | 2.241 |

ClockMap backwards steps per run: 0; reanchors: 1; rejected: 0

## Q2 hitches (error in the first frame after the long frame / worst in 14 frames / frames to settle within 1 ms; median over runs)
| hitch | estimator | first ms | worst ms | settle frames |
|---|---|---|---|---|
| 100 ms | ClockMap | -0.021 | -0.057 | 0.000 |
| 100 ms | getOutputTimestamp (raw, per frame) | 0.013 | -0.230 | 0.000 |
| 100 ms | currentTime (raw, no latency comp.) | 4.493 | -4.778 | 15.000 |
| 200 ms | ClockMap | 0.006 | -0.157 | 0.000 |
| 200 ms | getOutputTimestamp (raw, per frame) | 0.029 | -1.606 | 11.000 |
| 200 ms | currentTime (raw, no latency comp.) | 1.693 | -4.678 | 15.000 |
| 300 ms | ClockMap | 0.045 | 0.045 | 0.000 |
| 300 ms | getOutputTimestamp (raw, per frame) | 0.042 | -0.048 | 0.000 |
| 300 ms | currentTime (raw, no latency comp.) | 3.934 | -4.679 | 15.000 |

## Q1 beat callbacks: error vs the ideal frame (|distance| of the callback frame start from the "window" (0, frame interval] before the beat is heard; ms)
| design | bucket | beats/run | in-window | early | late | off=0 | off=-1 | off=+1 | other | |err| p50 | p99 | p99.9 | max | lead std |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | steady | 9.000 | 9.000 | 0.000 | 0.000 | 9.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.690 |
| A | transition | 12.000 | 12.000 | 0.000 | 0.000 | 12.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 3.498 |
| A | hitch | 7.000 | 6.000 | 0.000 | 1.000 | 6.000 | 0.000 | 1.000 | 0.000 | 0.000 | 73.484 | 73.484 | 73.484 | 31.510 |
| A0 | steady | 9.000 | 0.000 | 0.000 | 9.000 | 0.000 | 0.000 | 9.000 | 0.000 | 8.056 | 8.125 | 8.125 | 8.125 | 0.691 |
| A0 | transition | 12.000 | 0.000 | 0.000 | 12.000 | 0.000 | 0.000 | 12.000 | 0.000 | 8.166 | 16.030 | 16.030 | 16.030 | 3.498 |
| A0 | hitch | 7.000 | 0.000 | 0.000 | 7.000 | 0.000 | 0.000 | 7.000 | 0.000 | 6.792 | 73.484 | 73.484 | 73.484 | 25.211 |
| Braw_imm | steady | 9.000 | 0.000 | 9.000 | 0.000 | 0.000 | 6.000 | 0.000 | 3.000 | 9.987 | 25.274 | 25.274 | 25.274 | 7.911 |
| Braw_imm | transition | 12.000 | 0.000 | 12.000 | 0.000 | 0.000 | 12.000 | 0.000 | 0.000 | 7.940 | 10.092 | 10.092 | 10.092 | 3.499 |
| Braw_imm | hitch | 7.000 | 0.000 | 6.000 | 1.000 | 0.000 | 6.000 | 1.000 | 0.000 | 9.910 | 73.484 | 73.484 | 73.484 | 37.809 |
| Bheld_imm | steady | 9.000 | 9.000 | 0.000 | 0.000 | 9.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.690 |
| Bheld_imm | transition | 12.000 | 12.000 | 0.000 | 0.000 | 12.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 3.498 |
| Bheld_imm | hitch | 7.000 | 6.000 | 0.000 | 1.000 | 6.000 | 0.000 | 1.000 | 0.000 | 0.000 | 73.484 | 73.484 | 73.484 | 31.510 |
| Braw_status | steady | 9.000 | 2.000 | 7.000 | 0.000 | 2.000 | 6.000 | 0.000 | 1.000 | 9.744 | 25.274 | 25.274 | 25.274 | 10.167 |
| Braw_status | transition | 12.000 | 1.000 | 11.000 | 0.000 | 1.000 | 11.000 | 0.000 | 0.000 | 4.949 | 10.069 | 10.069 | 10.069 | 4.944 |
| Braw_status | hitch | 7.000 | 1.000 | 5.000 | 1.000 | 1.000 | 5.000 | 1.000 | 0.000 | 9.878 | 73.484 | 73.484 | 73.484 | 37.278 |
| Bheld_status | steady | 9.000 | 9.000 | 0.000 | 0.000 | 9.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.690 |
| Bheld_status | transition | 12.000 | 12.000 | 0.000 | 0.000 | 12.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 3.498 |
| Bheld_status | hitch | 7.000 | 6.000 | 0.000 | 1.000 | 6.000 | 0.000 | 1.000 | 0.000 | 0.000 | 73.484 | 73.484 | 73.484 | 31.510 |

(counts are means per run; "early" = callback ran more than one frame before the beat was heard, "late" = after it was heard)

## Q1 missed / doubled / phantom beats per run (per run; epochs: tempo change 120 -> 90 BPM, one stamped bar transition, 8 asap seeks)
| design | fired | missed | doubled | phantom (fired, never rendered) | missed in transition | missed in hitch |
|---|---|---|---|---|---|---|
| A | 29 | 0 | 0 | 0 | 0 | 0 |
| A0 | 29 | 0 | 0 | 0 | 0 | 0 |
| Braw_imm | 29 | 0 | 0 | 0 | 0 | 0 |
| Bheld_imm | 29 | 0 | 0 | 0 | 0 | 0 |
| Braw_status | 29 | 0 | 0 | 0 | 0 | 0 |
| Bheld_status | 29 | 0 | 0 | 0 | 0 | 0 |

keys (run 1, design A) missed: [] phantom: []

rendered beats per run: 29; stamped commands that arrived late: 0

## Q1 arrival lead of design B messages (ms the beat is still in the future when main learns of it; negative = already heard)
| channel | p50 | p1 | min |
|---|---|---|---|
| immediate port message | 33.622 | 31.140 | 31.140 |
| in STATUS (every 6 quanta) | 31.865 | 20.662 | 20.662 |

## Q5 input mapping error vs the audio clock (ms, abs; median over runs)
| events | mapping | n/run | p50 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|
| synthetic | ClockMap offset applied to event.timeStamp | 89.000 | 0.006 | 0.052 | 0.052 | 0.052 |
| synthetic | Audio.time as of last frame | 89.000 | 7.422 | 17.002 | 17.002 | 17.002 |
| synthetic | raw getOutputTimestamp at the event | 89.000 | 0.020 | 0.064 | 0.064 | 0.064 |
| synthetic | handler delay (now - event.timeStamp) | | 0.015 | 0.110 | | 0.110 |
| cdp | ClockMap offset applied to event.timeStamp | 18.000 | 0.006 | 0.023 | 0.023 | 0.023 |
| cdp | Audio.time as of last frame | 18.000 | 10.903 | 16.758 | 16.758 | 16.758 |
| cdp | raw getOutputTimestamp at the event | 18.000 | 0.014 | 0.052 | 0.052 | 0.052 |
| cdp | handler delay (now - event.timeStamp) | | 0.290 | 4.910 | | 4.910 |
