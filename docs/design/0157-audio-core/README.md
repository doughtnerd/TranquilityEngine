# 0157 audio core: technical design (M1)

The technical design for [ADR 0157](../../decisions/0157-audio-runs-on-an-engine-owned-rust-core-in-an-audioworklet.md), the engine-owned audio core. **Status: approved by the owner (2026-11-09).** ADR 0157 revision 3 carries its decision-level changes.

| Document | Owner | Covers |
|---|---|---|
| [architecture.md](architecture.md) | architect | components and channels, lifecycles (state diagrams), interactions (sequence diagrams), threading and the clock, memory, the performance model, HRTF (§2.4), failure handling, observability, the platform matrix, extension points |
| [api-and-models.md](api-and-models.md) | senior engineer | the public TypeScript API, `project.json` settings, the voice table and other data models, byte-exact wire formats, the Rust crates and C ABI, the file layout, editor changes, the test plan, the M1 task breakdown and estimate |
| [review-log.md](review-log.md), [review-round2-architect.md](review-round2-architect.md), [review-round2-senior.md](review-round2-senior.md) | both | the cross-reviews |

## How it was made

1. **Round 1:** the architect (Opus) and the senior engineer (Sonnet) drafted in parallel and exchanged contracts (C1–C11).
2. **Round 2, review:** each reviewed the other's document.
3. **Round 2, revision:** each revised their own, under the coordinator's rulings on the points they disagreed about.
4. **Coordinator review:** checked the code citations, consistency between the documents, and the 13 Mermaid diagrams (all render under Mermaid 11.4.1), and fixed problems directly.
5. **Owner review:**
   - Q&A on open-source reuse: a research pass, plus a microfft build checked by the coordinator;
   - a comparison with Howler and Babylon's audio;
   - approval, with the choices below.
6. **Round 3:** both documents updated for those choices; the coordinator aligned the remaining conflicts.

## Owner's choices

| Topic | Choice |
|---|---|
| Fallback backend | **Babylon's AudioEngineV2** instead of Howler, internal behind 0098 and never public. Howler is deleted when it lands. Coordinator rule: when the core can't load (an old engine, a failed load), the host switches to Babylon **automatically** with one warning; a core that loaded and then exhausts its recoveries stays silent. Babylon stays after M1 as the permanent fallback |
| HRTF | **In M1:** a port of Chromium's HRTF panner with its Composite HRIR data for the nearest 16 spatial voices (`audio.voices.hrtf`, `audio.spatial`), matching today's Web Audio sound. Gated on clearing the data licence first (task H0); the fallbacks are SADIE II data with the same code, or equal-power |
| Reuse | **Port** Chromium's Web Audio code (BSD, notices kept): biquad, dynamics compressor, staged convolver, HRTF panner, equal-power panner, distance and cone. **Adopt** microfft (MIT; 14 KB of wasm for 256/4096 real FFTs plus the inverse). **Borrow designs** from Kira, Firewheel and SoLoud |
| Sound quality | A manual listening pass **run by the owner**, backed by automated objective checks (sweeps, THD+N, null tests, loudness, goldens) |
| Platforms | The **editor** targets desktop and the web browser only. **Published games** target web, desktop and **Android** (Tauri builds intended; an export record extending 0041 is still to come). On Android the core runs in the system WebView |
| Low-end device | A **starting point, not an absolute**: if the core shows significant performance gaps, the low end moves to a more capable device class. It's an **Android phone** on the lowest Android version Google Play accepts for publishing apps, running the web build in Chrome/WebView. It defines the "low" preset and is part of the soak gate. If its WebView lacks AudioWorklet or `simd128` (checked in A0.6), it runs the Babylon fallback |
| Estimate | **155 person-days, about 31 person-weeks**, including a 10% reserve; roughly 15–17 calendar weeks with one senior, two mid-level and one junior engineer (estimate) |

**How the estimate moved from the 136 days shown at approval:**

| Change | Days |
|---|---|
| Ports and microfft (filters, compressor, convolver, distance and cone, parity tuning) | −5 |
| Ports intake (notices, `PORTS.md`) | +1 |
| HRTF in M1 (licence check, panner port, HRIR asset and loader, integration, parity tests), replacing the equal-power task | +15 |
| Babylon backend (it replaces Howler; Howler's deletion is folded in) | +6 |
| Reserve | +2 |

The table is in api-and-models §9.

**Open owner items:** none.

## Coordinator review: problems found and fixed

| # | Problem | Fix |
|---|---|---|
| 1 | Reverb: the architecture replaced 0097's convolver with Freeverb, using a *uniform* convolver's cost | Keep the convolver: the non-uniform design costs 0.07 ms average, ~0.3 ms p99.9, so there's no behaviour change. It's now Chromium's staged convolver, ported |
| 2 | The FFT library (rustfft) would break the 150 KB mixer gate | microfft (14 KB), measured |
| 3 | The clip arena differed between the documents | 4 size classes per octave (≤25% waste) |
| 4 | Reverb memory and cost were understated | ~2.7 MB; charged to the reserve. With HRTF, the high preset totals 1.19 ms of 1.3 at p99.9 |
| 5 | Stale owner decisions | removed or marked settled |
| 6 | The `group` field | a reserved `u16`, so M2 needs no wire version bump |
| 7 | The memory `maximum` | fixed regions plus the clip ceiling |
| 8 | Round 3: automatic fallback to Babylon (API doc) vs silent (architecture) | automatic at load, silent after recoveries are exhausted mid-session (see above) |
| 9 | Round 3: the API doc had Babylon's unlock UI doing the unlocking | the host's unlock layer serves both backends; Babylon's own resume-on-interaction and unmute UI are off |

## Notes for the build

- **The reserve is nearly spent.** The high preset's budget leaves ~0.11 ms for M2–M4. M3's ambisonic bed will need its own budget, or fewer HRTF voices.
- **HRTF data provenance** (task H0) blocks the HRTF tasks, not the rest of M1.
- **Wasm size:** the mixer is estimated at 110–130 KB, under the 150 KB gate. If HRTF breaks the gate, it moves to a lazy second module sharing the imported memory.
