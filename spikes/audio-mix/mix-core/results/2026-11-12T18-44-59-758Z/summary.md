# S4 (M5 mix in the core) run 2026-11-12T18-44-59-758Z

RUNS=5 CALLS=60000; quantum = 128 frames at 48 kHz = 2,666,667 ns. Medians over runs. Times in ns per quantum (one rule, one ramping bus, one filter: stereo).

## Correctness checks (deterministic)
- native: peak detector attack = 63% at 1 ms: PASS (0.632)
- native: rms detector = A/sqrt2: PASS (0.3523 vs 0.3536)
- native: gain computer: none / max / knee midpoint: PASS (0 10.457574 0.75)
- native: duck attack 63% at 50 ms / release 37% at 400 ms (tick 128): PASS (attack 0.617 release 0.365)
- native: duck attack 63% at 50 ms / release 37% at 400 ms (tick 16): PASS (attack 0.617 release 0.366)
- native: duck attack 63% at 50 ms / release 37% at 400 ms (tick 1): PASS (attack 0.617 release 0.366)
- native: tick 128 and 16 vs per-sample: max |gain difference| dB: PASS (tick128 0.0234 dB, tick16 0.0245 dB)
- native: stamped ramp vs Ramp::next (start at quantum start): both within 1e-5 of the f64 line: PASS (stamped vs exact 5.45e-8, Ramp::next vs exact (f32 drift) 1.14e-5, stamped vs Ramp 1.14e-5)
- native: stamped ramp starting inside a quantum = exact line, ends on target: PASS (max diff 7.69e-8, last 0.1)
- wasm: peak detector attack = 63% at 1 ms: PASS (0.632)
- wasm: rms detector = A/sqrt2: PASS (0.3523 vs 0.3536)
- wasm: gain computer: none / max / knee midpoint: PASS (0 10.457574 0.75)
- wasm: duck attack 63% at 50 ms / release 37% at 400 ms (tick 128): PASS (attack 0.617 release 0.365)
- wasm: duck attack 63% at 50 ms / release 37% at 400 ms (tick 16): PASS (attack 0.617 release 0.366)
- wasm: duck attack 63% at 50 ms / release 37% at 400 ms (tick 1): PASS (attack 0.617 release 0.366)
- wasm: tick 128 and 16 vs per-sample: max |gain difference| dB: PASS (tick128 0.0234 dB, tick16 0.0245 dB)
- wasm: stamped ramp vs Ramp::next (start at quantum start): both within 1e-5 of the f64 line: PASS (stamped vs exact 5.45e-8, Ramp::next vs exact (f32 drift) 1.14e-5, stamped vs Ramp 1.14e-5)
- wasm: stamped ramp starting inside a quantum = exact line, ends on target: PASS (max diff 7.69e-8, last 0.1)

## Zipper: main-thread BUS_MIX updates vs a stamped ramp (1 kHz sine, 0.5 peak; best constant delay removed first)

`ramp` is the BUS_MIX `rampFrames`: 128 frames is the brief's premise (2.7 ms per update); `interval` is what main sends today (`clock.ts` `rampFrames`: the frame interval clamped to 5..50 ms, 800 frames at 60 fps). `jitter` = the update lands up to 3 quanta late. `delay` is the lag of the heard gain behind the true curve; error is measured after removing it.

| shape | fps | ramp | jitter | lag ms | error rms dB | error peak dBFS | gain-step click dBFS |
|---|---:|---|---:|---:|---:|---:|---:|
| fade | 60 | 128 frames (2.7 ms) | 0 | 10.73 | -32.9 | -36.9 | -72.6 |
| fade | 60 | 128 frames (2.7 ms) | 3 | 13.54 | -31.4 | -33.6 | -72.6 |
| fade | 60 | interval (rampFrames) | 0 | 17.92 | -49.3 | -52.9 | -86.8 |
| fade | 60 | interval (rampFrames) | 3 | 21.25 | -37.5 | -41.7 | -84.9 |
| fade | 30 | 128 frames (2.7 ms) | 0 | 19.27 | -26.6 | -30.5 | -66.6 |
| fade | 30 | 128 frames (2.7 ms) | 3 | 22.08 | -26.3 | -28.7 | -66.6 |
| fade | 30 | interval (rampFrames) | 0 | 34.69 | -40.9 | -36.6 | -88.1 |
| fade | 30 | interval (rampFrames) | 3 | 38.02 | -35.9 | -38.8 | -87.5 |
| duck: | 60 | 128 frames (2.7 ms) | 0 | 11.67 | -41.6 | -27.3 | -62.2 |
| duck: | 60 | 128 frames (2.7 ms) | 3 | 13.54 | -40.2 | -26.5 | -62.2 |
| duck: | 60 | interval (rampFrames) | 0 | 18.75 | -58.2 | -48.1 | -78.1 |
| duck: | 60 | interval (rampFrames) | 3 | 20.73 | -45.1 | -35.9 | -78.1 |
| duck: | 30 | 128 frames (2.7 ms) | 0 | 21.46 | -35.1 | -22 | -57.5 |
| duck: | 30 | 128 frames (2.7 ms) | 3 | 22.4 | -34.9 | -22.2 | -57.5 |
| duck: | 30 | interval (rampFrames) | 0 | 36.25 | -53.8 | -41.7 | -79.5 |
| duck: | 30 | interval (rampFrames) | 3 | 37.4 | -46.7 | -37.5 | -79.5 |
| fade | - | stamped linear ramp in the core | - | 0 | -79 | -88.5 | -88.5 |

Reference: the true 250 ms fade's own gain step per sample is -88.5 dBFS at 0.5 peak.

## A one-quantum-late detector (trigger bus computed after the target)

| detector | duck attack ms | release ms | depth dB | max gain difference dB | % of depth |
|---|---:|---:|---:|---:|---:|
| peak | 10 | 100 | 10.46 | 2.45 | 23.4 |
| rms | 10 | 100 | 10.46 | 2.45 | 23.4 |
| peak | 25 | 250 | 10.46 | 1.06 | 10.1 |
| rms | 25 | 250 | 10.46 | 1.06 | 10.1 |
| peak | 50 | 400 | 10.46 | 0.54 | 5.2 |
| rms | 50 | 400 | 10.46 | 0.54 | 5.2 |

## Snapshot blending of effect parameters (biquad: tones 300 Hz, 3 kHz, 9 kHz; worst over the 12 cases of each scheme)

`glitch vs own per-sample` = largest second difference around the transition over that of the same trajectory evaluated per sample (1.00: the per-quantum update adds nothing). `glitch vs exact` is against the exact log-Hz per-sample reference (trajectories differ for the lerp schemes, so only the first two are comparable).

| scheme | worst glitch vs own per-sample | worst glitch vs exact log-Hz | end-state error |
|---|---:|---:|---|
| step per quantum, linear Hz (today) | 1.19 | 1.16 | converges exactly |
| step per quantum, log Hz | 1.68 | 1.68 | converges exactly |
| coefficient lerp per sample | (is the reference) | 2.98 | converges exactly |
| coefficient lerp per quantum | 1.01 | 2.98 | converges exactly |
| hard switch (no blend) | (is the reference) | 3.50 | converges exactly |

Compressor threshold (tones 220/880/1760 Hz; `abrupt` = largest step of the difference to the unedited run over its peak: <= 0.2 smooth, 1 a jump):

| edit | scheme | abrupt | largest step dBFS | peak difference dBFS |
|---|---|---:|---:|---:|
| compressor threshold -24 -> -30 dB | hard step | 0.78 | -18 | -15.9 |
| compressor threshold -24 -> -30 dB | blend per quantum over 20 ms | 0.19 | -36.3 | -22.1 |
| compressor threshold -24 -> -30 dB | blend per quantum over 100 ms | 0.1 | -42.2 | -22.1 |
| compressor threshold -24 -> -30 dB | blend per quantum over 500 ms | 0.1 | -44.8 | -24.7 |
| compressor threshold -24 -> -40 dB | hard step | 0.78 | -7 | -4.9 |
| compressor threshold -24 -> -40 dB | blend per quantum over 20 ms | 0.23 | -27.5 | -14.8 |
| compressor threshold -24 -> -40 dB | blend per quantum over 100 ms | 0.1 | -34.9 | -14.8 |
| compressor threshold -24 -> -40 dB | blend per quantum over 500 ms | 0.1 | -37.2 | -17.1 |

## Micro: ns per quantum (median over runs of each run's value; per-call clock reads, so p50 includes the timer overhead row; `blk64` is the mean of 64-call blocks)

### sidechain

| case | native p50 | p99 | p99.9 | max | blk64 | wasm p50 | p99 | p99.9 | max | blk64 | wasm p50 % of quantum |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| timer-overhead | 34 | 39 | 49 | 29,155 | 71 | 53 | 65 | 132 | 140,651 | 108 | 0.002 |
| detector-peak | 555 | 578 | 6,837 | 174,984 | 593 | 402 | 607 | 4,286 | 136,885 | 460 | 0.015 |
| rule-peak-tick128 | 712 | 737 | 9,255 | 75,753 | 749 | 568 | 733 | 5,568 | 120,274 | 629 | 0.021 |
| rule-peak-tick16 | 1,064 | 1,193 | 12,780 | 459,692 | 1,104 | 991 | 1,300 | 12,287 | 130,641 | 1,050 | 0.037 |
| rule-peak-tick1 | 7,527 | 17,902 | 33,846 | 2,166,761 | 7,815 | 8,128 | 18,997 | 34,465 | 532,937 | 8,459 | 0.305 |
| detector-rms | 530 | 578 | 5,682 | 36,800 | 565 | 358 | 405 | 674 | 158,965 | 418 | 0.013 |
| rule-rms-tick128 | 598 | 725 | 5,916 | 90,367 | 631 | 505 | 603 | 5,177 | 277,015 | 565 | 0.019 |
| rule-rms-tick16 | 910 | 1,091 | 10,929 | 118,183 | 940 | 928 | 1,341 | 12,227 | 157,441 | 996 | 0.035 |
| rule-rms-tick1 | 6,673 | 12,189 | 22,706 | 1,469,529 | 7,007 | 9,115 | 20,446 | 35,210 | 711,049 | 9,435 | 0.342 |
| detector-peak-silence | 462 | 522 | 4,426 | 48,103 | 495 | 324 | 408 | 1,610 | 183,631 | 385 | 0.012 |
| copy-only-baseline | 37 | 41 | 53 | 18,859 | 67 | 71 | 84 | 245 | 33,019 | 127 | 0.003 |
| apply-curve | 54 | 59 | 72 | 18,804 | 85 | 93 | 120 | 237 | 87,910 | 150 | 0.003 |
| rules8-peak-tick128+apply | 4,590 | 8,905 | 25,408 | 563,014 | 4,733 | 5,041 | 11,424 | 32,008 | 816,848 | 5,256 | 0.189 |

### busramp

| case | native p50 | p99 | p99.9 | max | blk64 | wasm p50 | p99 | p99.9 | max | blk64 | wasm p50 % of quantum |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| apply-settled-gain | 133 | 178 | 284 | 36,281 | 164 | 221 | 364 | 599 | 193,419 | 281 | 0.008 |
| ramp-today-mid-ramp | 112 | 150 | 186 | 20,456 | 143 | 213 | 318 | 520 | 140,841 | 272 | 0.008 |
| stamped-mid-ramp | 130 | 151 | 194 | 27,094 | 160 | 111 | 177 | 340 | 114,886 | 170 | 0.004 |
| stamped-starts-at-64 | 90 | 102 | 144 | 20,985 | 120 | 105 | 154 | 290 | 105,478 | 165 | 0.004 |
| stamped-ends-at-64 | 91 | 105 | 144 | 20,064 | 121 | 111 | 151 | 273 | 102,924 | 164 | 0.004 |
| stamped-2.7ms-ramp | 131 | 165 | 211 | 28,065 | 161 | 111 | 135 | 240 | 32,484 | 170 | 0.004 |
| x8-ramp-today | 743 | 1,037 | 11,052 | 194,807 | 775 | 1,274 | 1,880 | 13,679 | 142,204 | 1,335 | 0.048 |
| x8-stamped | 938 | 1,087 | 12,515 | 121,680 | 988 | 483 | 652 | 5,276 | 122,459 | 540 | 0.018 |

### blend

| case | native p50 | p99 | p99.9 | max | blk64 | wasm p50 | p99 | p99.9 | max | blk64 | wasm p50 % of quantum |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| lowpass-settled | 663 | 771 | 10,377 | 55,678 | 692 | 827 | 942 | 12,176 | 258,138 | 884 | 0.031 |
| lowpass-step-recompute-per-quantum | 691 | 802 | 9,996 | 67,382 | 744 | 842 | 963 | 12,583 | 515,914 | 908 | 0.032 |
| lowpass-coef-lerp-per-sample | 696 | 771 | 9,946 | 111,764 | 729 | 855 | 967 | 11,431 | 129,689 | 913 | 0.032 |
| lowpass-coef-lerp-per-quantum | 688 | 741 | 8,696 | 53,006 | 722 | 828 | 992 | 13,099 | 117,551 | 887 | 0.031 |
| lowpass-exact-recompute-per-sample | 9,995 | 20,790 | 38,022 | 1,286,804 | 10,302 | 11,276 | 23,212 | 50,357 | 998,315 | 11,605 | 0.423 |
| compressor-settled | 3,471 | 6,541 | 31,032 | 599,814 | 3,005 | 5,296 | 11,591 | 33,287 | 309,880 | 4,872 | 0.199 |
| compressor-threshold-blend-per-quantum | 3,020 | 12,993 | 27,245 | 245,873 | 4,545 | 5,351 | 16,706 | 28,226 | 248,026 | 6,825 | 0.201 |

Timer overhead p50: native 34 ns, wasm 53 ns. Copy-only baseline (the per-call refresh of the target buffer, in cases that process in place), net of the timer: native 3 ns, wasm 18 ns. Subtract the matching one from a case's p50 for the work itself.

## Metered wasm: instructions per quantum (p50 of per-call counter deltas / 1000; includes the timer's own few instructions: see `timer-overhead`)

| group | case | instructions |
|---|---|---:|
| sidechain | timer-overhead | 11 |
| sidechain | detector-peak | 6,019 |
| sidechain | rule-peak-tick128 | 8,114 |
| sidechain | rule-peak-tick16 | 14,603 |
| sidechain | rule-peak-tick1 | 126,427 |
| sidechain | detector-rms | 4,733 |
| sidechain | rule-rms-tick128 | 6,828 |
| sidechain | rule-rms-tick16 | 14,171 |
| sidechain | rule-rms-tick1 | 140,635 |
| sidechain | detector-peak-silence | 6,000 |
| sidechain | copy-only-baseline | 40 |
| sidechain | apply-curve | 976 |
| sidechain | rules8-peak-tick128+apply | 90,859 |
| busramp | apply-settled-gain | 6,703 |
| busramp | ramp-today-mid-ramp | 5,408 |
| busramp | stamped-mid-ramp | 1,796 |
| busramp | stamped-starts-at-64 | 1,692 |
| busramp | stamped-ends-at-64 | 1,701 |
| busramp | stamped-2.7ms-ramp | 1,802 |
| busramp | x8-ramp-today | 43,236 |
| busramp | x8-stamped | 14,154 |
| blend | lowpass-settled | 10,305 |
| blend | lowpass-step-recompute-per-quantum | 10,675 |
| blend | lowpass-coef-lerp-per-sample | 13,193 |
| blend | lowpass-coef-lerp-per-quantum | 10,278 |
| blend | lowpass-exact-recompute-per-sample | 115,573 |
| blend | compressor-settled | 79,051 |
| blend | compressor-threshold-blend-per-quantum | 67,030 |

## Bus order vs sidechain order in the samples (`ordering.mjs`)

- **sound-lab** (10 buses, depth 1); every ordered bus pair: 45 trigger-first, 36 delayed one quantum, 9 trigger-is-ancestor (cycle); all rules reorderable at BUS_CONFIG: true
  - rule SFX -> Music (attack 50 ms, amount 0.3): DELAYED one quantum (2.67 ms) under today's order; reorderable: true
- **stress** (32 buses, depth 2); every ordered bus pair: 496 trigger-first, 438 delayed one quantum, 58 trigger-is-ancestor (cycle); all rules reorderable at BUS_CONFIG: true
  - rule Bus01 -> Mix0 (attack 50 ms, amount 0.7): no delay (trigger deeper or earlier); reorderable: true

## Live edits through the real core (Node loopback, committed myco_audio.wasm; worst of 8 edit phases)

`abrupt` = largest sample-to-sample step of (edited - unedited output) over its peak (<= 0.23 is what a smooth change of these tones can give; above 0.3 is a click); `step dBFS` = that largest step in absolute terms; `onset` = frames from the batch to the first changed sample.

| edit | abrupt | verdict | click step dBFS | peak change | onset frames | settle ms |
|---|---:|---|---:|---:|---:|---:|
| control: no-op (BUS_CONFIG + BUS_MIX resent unchanged) | 0 | identical | -200 | 0 | -1 | - |
| control: bus gain jump, rampFrames 0 | 0.59 | CLICK | -23.7 | 0.1107 | 0 | 138.7 |
| bus volume 0.8->0.4, rampFrames 800 (60 fps) | 0.1 | smooth | -39.1 | 0.1107 | 0 | 138.7 |
| bus volume 0.8->0.4, rampFrames 128 | 0.1 | smooth | -39.1 | 0.1107 | 0 | 138.7 |
| lowpass cutoff 8000->1200 Hz | 0.15 | smooth | -33.1 | 0.1465 | 0 | - |
| lowpass cutoff 8000->300 Hz, Q 12 dB | 0.1 | smooth | -31.4 | 0.3243 | 0 | - |
| compressor threshold -24->-30 dB | 1 | CLICK | -24.2 | 0.0711 | 0 | 138.7 |
| compressor threshold -24->-50 dB | 1 | CLICK | -6.4 | 0.5554 | 0 | 138.7 |
| add effect: highpass 400 Hz after the lowpass | 0.05 | smooth | -39.2 | 0.2122 | 0 | - |
| remove effect: lowpass 8000 off the bus | 0.6 | CLICK | -39.7 | 0.0174 | 0 | - |
| remove the first of two effects (LP+HP -> HP) | 0.8 | CLICK | -19.3 | 0.148 | 0 | - |
| insert an effect before the lowpass (HP 150, LP 8000) | 0.75 | CLICK | -19.4 | 0.144 | 0 | - |
| add a bus at the end (empty, unity) | 0 | identical | -200 | 0 | -1 | - |
| add a bus at the end and move the SFX voice to it | 0.98 | CLICK | -13.9 | 0.2059 | 0 | - |
| change parent: SFX moves under Music (gain 0.8, lowpass 8000) | 1 | CLICK | -16.8 | 0.1441 | 0 | 138.7 |
| insert a bus in the middle (indices shift, voices re-routed) | 1 | CLICK | -12.8 | 0.2435 | 0 | - |
| reverb send 0.3->0.8 (reverb already on) | 0.1 | smooth | -47.2 | 0.0435 | 0 | 138.7 |
| add the first reverb send (convolver off -> on) | 0.1 | smooth | -47.2 | 0.0435 | 0 | 138.7 |
| remove the last reverb send (convolver on -> off, tail mid-flight) | 0.25 | smooth | -39.7 | 0.0419 | 0 | 138.7 |

{"edit":"reverb tail when the last send is removed (dry stopped), then the send returns 20 quanta later","tailRingingInReference_q64to70":0.0386,"tailAfterRemoval_q64to70":0,"outputWhileSendIsBack_afterReAdd_q80to88":0.0411,"referenceSameWindow":0.0423,"verdict":"tail cut to silence in one quantum","staleTailReplaysOnReAdd":true}

Run took 0.7 min.
