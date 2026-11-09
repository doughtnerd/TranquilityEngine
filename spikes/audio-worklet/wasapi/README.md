# WASAPI low-latency backend (spike)

Throwaway measurement of what a custom WASAPI backend (not cpal) could achieve on this machine. The real `myco-audio-spike` mixer (`../core`, 256 voices) runs in the render loop, the device gets zeros only. Follows `../native-out/README.md`, which found cpal is shared mode only at the device's 10 ms period, about 32 ms predicted latency.

Run: `cargo run --release` (info, then every run, 3 s each, about 20 s), or pick: `info shared-min shared-min-tight shared-def shared-def-tight excl-min[-i16|-i24] excl-def[-i16|-i24]`. Raw output: `info.txt`, `run1.txt` to `run3.txt`. Crate: `windows` 0.62.

## Method

- Per run: a new thread, COM MTA, default render endpoint (`eRender`/`eConsole`), thread boosted with `AvSetMmThreadCharacteristicsW("Pro Audio")`, event-driven (`AUDCLNT_STREAMFLAGS_EVENTCALLBACK`), 3 s, always silence (`memset 0`).
- Each wake: QPC timestamp, `GetCurrentPadding` (shared), mixer renders 128-frame quanta into a FIFO until the frames needed are there, the buffer is zero-filled and released. The mixer time (FIFO included) is QPC-timed. Intervals and mixer times drop the first 5 wakes.
- Shared: `IAudioClient3::GetSharedModeEnginePeriod`, `InitializeSharedAudioStream`, achieved period from `GetCurrentSharedModeEnginePeriod`. Two fill policies: "whole buffer" (top up to 22 ms every wake) and "tight" (prefill and write one period per wake, so only one period is ever queued; the lowest latency the policy allows).
- Exclusive: `IsFormatSupported(EXCLUSIVE)` (null closest match), `GetDevicePeriod`, `Initialize(EXCLUSIVE, EVENTCALLBACK, period, period)`; on `AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED`: `GetBufferSize`, recompute the duration as `10^7 * frames / rate`, drop the client, `Activate` a new one, `Initialize` again (this happened). Event-driven exclusive: period equals buffer, the whole buffer is refilled per wake.
- Glitch evidence: (a) `IAudioClock::GetPosition` (converted to frames) running ahead of frames written (a true underrun), (b) wake interval over 1.5 periods ("late wake", the deadline was at risk), (c) `padding == 0` at wake (shared). (c) is by design in "tight" mode (we write exactly what the engine consumes), so it is not a glitch there.
- Latency is **estimated, not measured** (no loopback hardware): see section 3.

## 1. Device and driver

Speakers (Realtek(R) Audio), HDAUDIO enumerator, mix format 48000 Hz, 2 ch, 32-bit (float). Driver: **Realtek's own** (`HDAUDIO\FUNC_01&VEN_10EC&DEV_0294`, provider Realtek Semiconductor Corp., oem13.inf, 6.0.9888.1, 2025-09-15; from `Win32_PnPSignedDriver`, not the inbox `hdaudio` driver). The laptop also has Cirrus Logic speaker amps (separate device).

## 2. Results

### Shared mode, IAudioClient3

`GetSharedModeEnginePeriod` (frames @ 48 kHz): default 480, fundamental 480, min 480, max 480 (all 10 ms). **The driver offers no smaller shared period**, so IAudioClient3 gains nothing here: "minimum period" and "default period" are identical (period 480, buffer 1056 frames = 22 ms). `GetStreamLatency` returns 0 for these streams.

| Run | Interval p50 / p95 / p99 / max (ms) | Jitter p95 / p99 / max (ms) | Mixer per wake p50 / p95 / max (us) | Late wakes | Clock underruns |
|---|---|---|---|---|---|
| min period, whole buffer | 10.00 / 10.21 / 11.87 / 17.32 | 0.33 / 6.51 / 7.32 | 1397 / 2012 / 3778 | 2 | 0 |
| min period, tight | 10.00 / 10.11 / 11.60 / 14.04 | 0.36 / 2.59 / 4.04 | 1349 / 2063 / 5017 | 0 | 0 |
| default period, whole buffer (run1) | 10.00 / 10.21 / 10.32 / 12.17 | 0.24 / 0.46 / 2.17 | 1337 / 1950 / 4864 | 0 | 0 |
| default period, tight | 10.00 / 10.10 / 10.15 / 14.55 | 0.13 / 1.56 / 4.55 | 1299 / 2064 / 6878 | 0 | 0 |

Padding at wake in whole-buffer mode: 576 frames (12 ms) every time, so 1056 frames (22 ms) queued after each fill.

### Exclusive mode

`GetDevicePeriod`: default 10.000 ms, minimum 3.000 ms. `IsFormatSupported(EXCLUSIVE)`, 48 kHz stereo: **float32 not supported** (`AUDCLNT_E_UNSUPPORTED_FORMAT`), **int16 supported**, **int24-in-32 supported**. The 3 ms minimum was rejected with `BUFFER_SIZE_NOT_ALIGNED`; the realign gave **240 frames = 5.000 ms** (this driver's real floor).

| Run | Period = buffer | `GetStreamLatency` | Interval p50 / p95 / p99 / max (ms) | Jitter p95 / p99 / max (ms) | Mixer p50 / p95 / max (us) | Late wakes | Clock underruns |
|---|---|---|---|---|---|---|---|
| min, int24-in-32 | 240 f (5 ms) | 5.0 ms | 5.00 / 5.06 / 5.09 / 7.59 | 0.06 / 0.33 / 2.63 | 766 / 1233 / 2632 | 1 | 0 |
| min, int16 | 240 f (5 ms) | 5.0 ms | 5.00 / 5.05 / 5.08 / 8.12 | 0.05 / 0.25 / 3.13 | 681 / 1191 / 3725 | 2 | 0 |
| default, int24-in-32 | 480 f (10 ms) | 10.0 ms | 10.00 / 10.05 / 10.12 / 11.09 | 0.06 / 0.99 / 1.09 | 1376 / 2004 / 3486 | 0 | 0 |

Exclusive wake-ups are far tighter than shared (p99 within 0.1 ms of the period), with an occasional single 2.5 to 3 ms late wake in 600 (7.6 and 8.1 ms intervals against 5 ms).

## 3. Estimated end-to-end output latency

Estimate = frames queued ahead of a newly written sample (buffer or padding, in ms) + the audio engine's own mixing delay in shared mode (one period) + wake-up wait. Fixed driver/DAC delay (about 1 to 2 ms on HDA) is not measured and not included. Cross-check: whole-buffer shared gives 22 + 10 = 32 ms, matching cpal's predicted 32 ms, so the formula reproduces the earlier number.

| Mode | Buffer / period | Estimated output latency |
|---|---|---|
| Browser (earlier spike) | 10 ms engine | about 50 ms (measured) |
| cpal shared (earlier spike) | 10 ms period, 22 ms buffer | about 32 ms (predicted) |
| WASAPI shared, IAudioClient3 min (= default) period, whole buffer | 10 / 22 ms | about 32 ms |
| WASAPI shared, tight (1 period queued) | 10 / 10 ms | about 20 ms |
| WASAPI exclusive, default period, int24 | 10 ms | about 10 to 15 ms (`GetStreamLatency` 10) |
| **WASAPI exclusive, 5 ms (240 f)** | 5 ms | **about 5 to 10 ms** (`GetStreamLatency` 5; upper bound if the driver double-buffers) |

## 4. Caveats

- No loopback or audio analyser: latencies are computed from buffer/stream numbers, not heard. `IAudioClock` and `GetStreamLatency` do not include driver DSP or DAC delay.
- Silence only: no underrun was audible or even checkable by ear; glitch counters are the only evidence. Late wakes of 7.6 to 8.1 ms at the 5 ms period would have cost a glitch if the buffer were not double-buffered by the driver; none showed on `IAudioClock`.
- At the 5 ms period the mixer's worst wake (2.6 to 3.7 ms for 256 voices, from 0.7 ms p50) is 50 to 75% of the period: thin headroom. Fewer voices, SIMD (the core has a SIMD build) or a safety period of 10 ms would be needed.
- Exclusive mode takes the device from every other app (including the browser and the editor's own audio) for the stream's lifetime, and needs int16 or int24 output conversion here (float32 is not accepted). Whether other machines' Realtek, inbox HD Audio, USB or Bluetooth devices support small periods, or IAudioClient3 below 10 ms, is per driver: this driver's shared minimum is 10 ms. Inbox drivers often offer 2.67 to 3 ms shared minimums; untested here.
- One machine, 3 s runs, one run per row (max columns are noisy; p50/p95 are stable). The 5 ms exclusive min was a single realign result; the driver's 3 ms minimum was not accepted for 4-byte (int16) or 8-byte (int24-in-32) frames.
