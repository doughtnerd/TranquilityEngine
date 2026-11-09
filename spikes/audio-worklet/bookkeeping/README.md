# Main-thread audio bookkeeping (spike)

What the game thread's audio work costs per frame before anything is sent to the worklet. For L logical voices it computes:
- distance attenuation (inverse, cut at max distance);
- a cone gain;
- pan;
- a priority score;

then picks the R highest and packs the R mixed voices (8 floats each) into a fresh `Float32Array` for postMessage. Two layouts:
- **typed arrays + quickselect:** one `Float32Array` per field and an O(L) selection;
- **objects + sort:** one object per voice, then `slice().sort().slice()`. This is the obvious code.

`node spikes/audio-worklet/bookkeeping/run.mjs` runs Node and Playwright Chromium, WebKit and Firefox. Results: `windows.json`, plus `linux.json` (Docker image, with Firefox).

## Results (ms per frame, Node, Windows; Linux within ~10%)

| Logical / mixed | Typed arrays p50 / p99 | Objects + sort p50 / p99 |
|---|---|---|
| 1,024 / 128 | 0.024 / 0.068 | 0.171 / 0.446 |
| 4,096 / 256 | 0.084 / 0.221 | 0.872 / 1.671 |
| 8,192 / 256 | 0.199 / 0.385 | 1.899 / 3.017 |

Chromium (0.1 ms timer) agrees: 0.1 vs 0.9 ms at 4,096 voices. WebKit and Firefox only time to 1 ms here, but agree in shape: 0 vs 1 ms, and 0 vs 2 ms at 8,192.

**Finding:** the audio system's per-voice state must live in typed arrays, one per field, with selection by quickselect. That's ~10× faster than objects plus a sort, and it keeps 4,096 logical voices at ≤0.1 ms (p99 0.22 ms) of a 16.7 ms frame. With objects, the same work takes 5–10% of the frame. This matches the hidden ECS: the voice table is data, not objects.
