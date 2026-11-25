# Animation performance

How fast the animation system is, how it compares with Babylon.js's own animation, and how to measure it yourself. The animation system evaluates every character in one call into a Rust core compiled to WebAssembly with SIMD (ADR 0370); see [Animation](animation.md) for what it does. All numbers below are from November 2026 (commit `3a512a527`) unless a row says otherwise.

## The reference machine

| | |
| --- | --- |
| CPU | AMD Ryzen AI Max+ 395 (16 cores, 32 threads) |
| GPU | Radeon 8060S (WebGPU: RDNA 3; WebGL2 through ANGLE on Direct3D 11) |
| OS | Windows, default power settings unless a row says otherwise |
| Runtime | Node 26.10; Chromium 156 (headless, hardware GPU) |

Every result is the median of 3 to 5 runs. Between runs of the same build, timings in the browser vary by about 5 to 10%, so smaller differences mean nothing.

## The scenarios

The character scenarios share one synthetic humanoid: **80 bones**, with idle, walk and run clips (1 s, 30 Hz, compressed).

| Scenario | What runs |
| --- | --- |
| One clip | 100 characters, each playing walk |
| Crossfade | 100 characters, walk and run blended |
| Locomotion | 100 characters: a state machine with a 2D blend space of three clips (synced and speed-scaled), an upper-body slot and inertialization |
| Locomotion + rig (**the budget scenario**) | Locomotion plus a two-foot grounder (IK with ground rays) and a look-at on the neck and head |
| 300 clips | 300 characters, each playing walk |
| Motion matching | 20 characters on a synthetic 30-minute database (54,000 frames, 180 clips), searching every 6 frames with a KD-tree |
| Tweens | 1,000 endless tweens: half eased vec3 yoyos, half quaternion slerps |
| Timeline | one looping timeline driving 100 nodes with 200 vec3 tracks |

ADR 0370 sets a budget for three of them: **1.5 ms** for locomotion + rig, **0.6 ms** for motion matching, **0.2 ms** for the tweens. The budgets are tripwires that catch regressions, not hard limits.

## The core alone

The WebAssembly core in Node, frames run back to back (`bench_budgets.mjs`). This is the animation work itself, with nothing else on the thread.

| Scenario | 60 bones | 80 bones | Budget |
| --- | --- | --- | --- |
| One clip | 0.59 ms | 0.67 ms | |
| Crossfade | 0.74 ms | 0.86 ms | |
| Locomotion | 1.04 ms | 1.20 ms | |
| Locomotion + rig | 1.30 ms | **1.45 ms** | 1.5 ms (met) |
| Motion matching, KD-tree | | **0.15 ms** | 0.6 ms (met) |
| Motion matching, brute force (reference only) | | 1.34 ms | |
| Tweens: linear / eased / vec3 + quaternion | | 0.03 / 0.03 / **0.07 ms** | 0.2 ms (met) |

So the budget scenario costs about **14.5 µs per character**: sampling, blending, the state machine, IK and the look-at for 80 bones, on one thread.

## In a game

The same scenarios in an exported game, in Chromium with the reference machine's GPU (`npm run bench:anim -- --gpu --count --profile`). **Gather** reads the game's inputs, **evaluate** is the core, **apply** writes the results back, and **animation** is all three.

| Scenario | Gather | Evaluate | Apply | Animation | Whole frame |
| --- | --- | --- | --- | --- | --- |
| Characters (locomotion + rig), skinned meshes drawn | 0.52 | 2.09 | 0.08 | **2.70 ms** | 6.46 ms |
| Characters, same meshes drawn static | 0.60 | 2.16 | 0.09 | 2.86 ms | 5.51 ms |
| Characters, nothing drawn | 0.50 | 2.16 | 0.08 | 2.74 ms | 4.14 ms |
| Locomotion only, no meshes | 0.28 | 1.85 | 0.06 | 2.21 ms | 4.15 ms |
| 300 clips, no meshes | 0.22 | 2.86 | 0.09 | 3.17 ms | 5.09 ms |
| Motion matching | 0.19 | 0.34 | 0.05 | **0.60 ms** | 2.96 ms |
| Tweens | 0.02 | 0.10 | 0.15 | **0.26 ms** | 2.44 ms |
| Timeline | 0.00 | 0.04 | 0.06 | 0.10 ms | 2.37 ms |

**Skinning** 100 characters on the GPU (WebGPU compute) costs **1.94 ms** of main-thread time a frame, 1.33 ms of it the skinning itself. A frame takes one compute pass with about 100 dispatches, about 100 draws and two buffer writes (383 KB of bone matrices).

### Why the game is slower than the core alone

In a game, the core's evaluate takes about twice as long as in the back-to-back test (2.1 ms against 1.45 ms). The cause isn't the engine's code. Between frames the main thread sleeps, and on this machine a thread that has just woken runs at about half speed for a while. The core alone, run with the same gap between frames, shows the same thing:

| Before each frame (locomotion + rig, core alone) | Evaluate |
| --- | --- |
| Nothing (back to back) | 1.46 ms |
| **16 ms of busy work, never sleeping** | **1.44 ms** |
| A 16 ms sleep | 2.99 ms |
| A 16 ms sleep, then 3 ms or 15 ms of busy work | 2.98 ms |
| A 16 ms sleep, then one untimed evaluate | 3.02 ms |
| A 16 ms sleep, the process pinned to one core | 2.85 ms |
| A 16 ms sleep, Armoury Crate's Turbo mode | 3.00 ms |
| A 16 ms sleep, **core idle states disabled** (`powercfg IDLEDISABLE 1`) | **2.08 ms** |
| As above, plus minimum processor state 100% | 2.05 ms |

- Time between frames costs nothing as long as the thread never sleeps.
- About 60% of the slowdown is the cores' deep idle sleep. The rest is still unexplained; it isn't Windows' minimum clock, and moving between cores accounts for little of it.
- None of it can be switched off by a page or a game. Idle states are a system-wide setting only an administrator can change.

So on this machine at default settings, the realistic cost of 100 fully rigged characters in a game is about **2.7 ms**; the 1.5 ms budget holds for the core on a core that stays awake.

## Compared with Babylon.js

The same 80-bone humanoid and the same idle, walk and run keys, played by Babylon.js 9.32's own animation system in Node (`npm run bench:anim:babylon`). Each character is a Babylon `Skeleton` of `Bone`s with one `AnimationGroup` per clip; a frame is `scene.animate()` plus `prepare(true)` on every skeleton, which computes the same final bone matrices our core does. The setup favours Babylon: it gets the keys uncompressed, channels that never change are left out, the `Animation` objects are shared by every character, and nothing is drawn.

| Scenario | Babylon.js 9.32 | Myco core | Myco is |
| --- | --- | --- | --- |
| 100 characters, one clip | 10.24 ms | 0.67 ms | **15× faster** |
| 100 characters, crossfade of two clips | 41.45 ms | 0.86 ms | **48× faster** |
| 100 characters: Babylon three weighted clips, Myco the full locomotion graph | 53.61 ms | 1.20 ms | **45× faster** |
| 300 characters, one clip | 45.91 ms | not yet measured on this machine | |

Babylon's time splits into its animation update and the matrix step:

| Scenario | Animate | Prepare (matrices) | Animation objects |
| --- | --- | --- | --- |
| One clip | 6.93 ms | 3.28 ms | 13,500 |
| Crossfade | 36.84 ms | 4.69 ms | 25,700 |
| Three weighted clips | 48.57 ms | 5.00 ms | 37,900 |
| 300 characters, one clip | 31.84 ms | 14.07 ms | 40,500 |

Babylon creates one animation object per animated channel per bone and walks them all in JavaScript every frame. Each extra weighted clip adds a full set of them plus a blending pass, which is why blending costs it the most. The IK rig, motion matching and tweens aren't compared, because Babylon's animation system has nothing equivalent.

## How it got here

The budget scenario and the in-game numbers across the November 2026 performance passes, on the reference machine:

| After | Core alone, locomotion + rig | Characters in a game, nothing drawn | 100 skinned characters, whole frame | Motion matching in a game | Tweens in a game |
| --- | --- | --- | --- | --- | --- |
| First measurement | 2.42 ms | 5.08 ms | 11.84 ms | 1.16 ms | 1.03 ms |
| Host-overhead and skinning passes | 2.42 ms | 3.99 ms | 8.93 ms | 1.04 ms | 0.29 ms |
| Core pass | 1.49 ms | 2.76 ms | 6.09 ms | 0.84 ms | 0.27 ms |
| Follow-ups pass | 1.45 ms | 2.74 ms | 6.46 ms | 0.60 ms | 0.26 ms |

The last row's skinned frame is within the run-to-run spread of the row above it. Details of each pass are in the animation build log (`docs/design/animation/build-log.md`).

## Measuring it yourself

The core alone (needs the Rust toolchain once, to generate its fixtures):

```shell
node native/anim/crates/anim-wasm/bench_budgets.mjs
```

Add `--gap 16` to sleep 16 ms before each frame as a game does, `--busy MS` to keep the CPU busy before each frame, or `--only locomotion_rig_80` for one scenario.

In an exported game in Chromium (`--gpu` uses your hardware GPU and stops if it falls back to software):

```shell
npm run bench:anim -- --gpu --count --profile
```

Against Babylon.js:

```shell
npm run bench:anim:babylon
```

For the 300-character case of the core, to compare with Babylon's:

```shell
node native/anim/crates/anim-wasm/bench_budgets.mjs --only one_clip_80 --characters 300 --max-instances 512 --max-bones 256
```
