# beat-clock results: 1 runs x 10 s, latencyHint interactive (baseLatency 0.010 s, outputLatency 0.032 s), sr 44100, limiter D = 66 frames, frame interval 16.665 ms (60.006 Hz)

render-clock fit: -0.220 ppm vs nominal, residual p99 5.042 ms; K (heard minus render clock) median 34.974 ms; STATUS period 17.426 ms

## Q2 clock error vs the audio clock (ms; offset removed; steady frames; per run then median over runs)
| estimator | const offset ms | p50 | p99 | p99.9 | max | f2f jitter std | f2f |d| p99 | drift ms/min |
|---|---|---|---|---|---|---|---|---|
| ClockMap | -0.002 | 0.003 | 0.063 | 0.088 | 0.088 | 0.005 | 0.009 | 0.153 |
| getOutputTimestamp (raw, per frame) | -0.001 | 0.003 | 0.085 | 0.908 | 0.908 | 0.062 | 0.241 | 0.139 |
| currentTime (raw, no latency comp.) | 36.934 | 2.596 | 4.869 | 6.871 | 6.871 | 4.825 | 7.963 | 2.513 |

ClockMap backwards steps per run: 0; reanchors: 1; rejected: 0

## Q2 hitches (error in the first frame after the long frame / worst in 14 frames / frames to settle within 1 ms; median over runs)
| hitch | estimator | first ms | worst ms | settle frames |
|---|---|---|---|---|
| 100 ms | ClockMap | -0.007 | -0.007 | 0.000 |
| 100 ms | getOutputTimestamp (raw, per frame) | -0.011 | -0.011 | 0.000 |
| 100 ms | currentTime (raw, no latency comp.) | 3.277 | -4.681 | 15.000 |
| 200 ms | ClockMap | 0.007 | 0.008 | 0.000 |
| 200 ms | getOutputTimestamp (raw, per frame) | 0.002 | 0.011 | 0.000 |
| 200 ms | currentTime (raw, no latency comp.) | 3.362 | -4.596 | 15.000 |
| 300 ms | ClockMap | 0.006 | 0.006 | 0.000 |
| 300 ms | getOutputTimestamp (raw, per frame) | 0.004 | -0.010 | 0.000 |
| 300 ms | currentTime (raw, no latency comp.) | 2.701 | 5.696 | 15.000 |

## Q1 beat callbacks: error vs the ideal frame (|distance| of the callback frame start from the "window" (0, frame interval] before the beat is heard; ms)
| design | bucket | beats/run | in-window | early | late | off=0 | off=-1 | off=+1 | other | |err| p50 | p99 | p99.9 | max | lead std |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | steady | 8.000 | 8.000 | 0.000 | 0.000 | 8.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 2.225 |
| A | transition | 13.000 | 13.000 | 0.000 | 0.000 | 13.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 2.961 |
| A | hitch | 7.000 | 5.000 | 1.000 | 1.000 | 5.000 | 1.000 | 1.000 | 0.000 | 0.000 | 77.504 | 77.504 | 77.504 | 33.140 |
| A0 | steady | 8.000 | 0.000 | 0.000 | 8.000 | 0.000 | 0.000 | 8.000 | 0.000 | 6.672 | 10.919 | 10.919 | 10.919 | 2.223 |
| A0 | transition | 13.000 | 0.000 | 0.000 | 13.000 | 0.000 | 0.000 | 13.000 | 0.000 | 10.602 | 15.253 | 15.253 | 15.253 | 2.961 |
| A0 | hitch | 7.000 | 0.000 | 0.000 | 7.000 | 0.000 | 0.000 | 7.000 | 0.000 | 10.813 | 77.504 | 77.504 | 77.504 | 25.211 |
| Braw_imm | steady | 8.000 | 0.000 | 8.000 | 0.000 | 0.000 | 7.000 | 0.000 | 1.000 | 9.993 | 22.416 | 22.416 | 22.416 | 5.404 |
| Braw_imm | transition | 13.000 | 0.000 | 13.000 | 0.000 | 0.000 | 12.000 | 0.000 | 1.000 | 6.379 | 22.682 | 22.682 | 22.682 | 5.399 |
| Braw_imm | hitch | 7.000 | 1.000 | 5.000 | 1.000 | 1.000 | 2.000 | 0.000 | 4.000 | 22.522 | 94.169 | 94.169 | 94.169 | 47.859 |
| Bheld_imm | steady | 8.000 | 8.000 | 0.000 | 0.000 | 8.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 2.225 |
| Bheld_imm | transition | 13.000 | 13.000 | 0.000 | 0.000 | 13.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 2.961 |
| Bheld_imm | hitch | 7.000 | 6.000 | 0.000 | 1.000 | 6.000 | 0.000 | 0.000 | 1.000 | 0.000 | 94.169 | 94.169 | 94.169 | 37.808 |
| Braw_status | steady | 8.000 | 1.000 | 7.000 | 0.000 | 1.000 | 7.000 | 0.000 | 0.000 | 5.964 | 10.058 | 10.058 | 10.058 | 5.452 |
| Braw_status | transition | 13.000 | 4.000 | 9.000 | 0.000 | 4.000 | 9.000 | 0.000 | 0.000 | 2.727 | 9.933 | 9.933 | 9.933 | 7.403 |
| Braw_status | hitch | 7.000 | 1.000 | 5.000 | 1.000 | 1.000 | 4.000 | 0.000 | 2.000 | 5.884 | 94.169 | 94.169 | 94.169 | 45.152 |
| Bheld_status | steady | 8.000 | 8.000 | 0.000 | 0.000 | 8.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 2.225 |
| Bheld_status | transition | 13.000 | 13.000 | 0.000 | 0.000 | 13.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 2.961 |
| Bheld_status | hitch | 7.000 | 6.000 | 0.000 | 1.000 | 6.000 | 0.000 | 0.000 | 1.000 | 0.000 | 94.169 | 94.169 | 94.169 | 37.808 |

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
| immediate port message | 34.062 | 31.259 | 31.259 |
| in STATUS (every 6 quanta) | 31.249 | 20.317 | 20.317 |

## Q5 input mapping error vs the audio clock (ms, abs; median over runs)
| events | mapping | n/run | p50 | p99 | p99.9 | max |
|---|---|---|---|---|---|---|
| synthetic | ClockMap offset applied to event.timeStamp | 89.000 | 0.002 | 0.082 | 0.082 | 0.082 |
| synthetic | Audio.time as of last frame | 89.000 | 9.682 | 16.720 | 16.720 | 16.720 |
| synthetic | raw getOutputTimestamp at the event | 89.000 | 0.003 | 0.044 | 0.044 | 0.044 |
| synthetic | handler delay (now - event.timeStamp) | | 0.010 | 0.060 | | 0.060 |
| cdp | ClockMap offset applied to event.timeStamp | 18.000 | 0.002 | 0.033 | 0.033 | 0.033 |
| cdp | Audio.time as of last frame | 18.000 | 7.338 | 15.438 | 15.438 | 15.438 |
| cdp | raw getOutputTimestamp at the event | 18.000 | 0.002 | 0.021 | 0.021 | 0.021 |
| cdp | handler delay (now - event.timeStamp) | | 0.290 | 1.745 | | 1.745 |
