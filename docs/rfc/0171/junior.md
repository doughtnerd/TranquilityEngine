# RFC review: ADR 0171, junior mid-level engineer lens

**Verdict: approve with changes.** Top 3 concerns:
1. The record names the level-mode ducking fields (threshold, amount, attack, release, detector) but gives no JSON shape, units or default mode (ADR:137, open question 6 at ADR:250).
2. It never says what each surface shows when it has no data (empty profiler, `-inf` loudness, unmetered bus, ducking below threshold).
3. Authored versus runtime values (ADR:126) and edit classes (ADR:128-131) are used as settled terms but are not defined anywhere a newcomer would look.

I read the record (fully), `docs/design/0171-audio-mix/goal.md`, `spikes/audio-mix/README.md`, and skimmed the `research/`, `loudness/`, `cpu-clock/`, `capture/` and `mix-core/` READMEs. I did not run anything.

## Issues

1. **major** Level-mode ducking has no schema. The existing rule is `{target, trigger, amount, attack, release}` (`src/engine/audio/settings.ts:14` in the doc comment; `samples/sound-lab/project.json:91`). In `mixer.ts:26`, `amount` is a gain multiplier the target heads for, and `attack` and `release` are time constants in seconds. The record does not say whether level-mode `amount` is still a multiplier or becomes dB, or the unit of `threshold`. Change: add one worked JSON example per mode with every field, unit and default, and say which mode `mode`-less existing rules get.
2. **major** No failure-mode section. Each surface needs a stated empty state (see Debugging). Change: a short table in §3 and §4 listing what each view shows with no data, and what a warning looks like.
3. **major** The scripting surface is named, not specified. §4 gives `Audio.bus("Master").loudness.integrated` and "can reset it" (ADR:121) with no method name. The existing `Bus` already returns 0 for a missing bus (`mixer.ts:6`) and ignores writes to one (`mixer.ts:7`). The record should say whether `loudness` on an unmetered bus throws, returns `undefined` or returns `-Infinity`.
4. **minor** The glossary (ADR:9-46) lacks: sub-block (used in ADR:116 and the loudness spike), presence mode (ADR:137), authored and runtime value, multiplier, edit class, index-stable, virtual / stolen / refused voice states, event instance (0158), Babylon fallback, tripwire, M4-0, and F-37 (goal.md:20). "Owner decision 3" (ADR:219) points to open question 3 (ADR:247) only by number.
5. **minor** Capture ring overwrite (ADR:44 glossary, ADR:92). The record does not say whether a saved capture that starts after the ring wrapped is marked as truncated, or whether the first keyframe is complete.

## Using it

**Record a capture from a game (not yet written; names from ADR:144):**

```ts
// Test build script. Names are the record's, the arguments are my guess.
Audio.capture.start();
// ... reproduce the glitch ...
Audio.capture.stop();
await Audio.capture.save("door-click-repro");   // web: download; desktop/Android: app data
```

Open question: does `save()` with nothing recorded throw, or write an empty file? The record is silent (ADR:144-148).

**Read loudness and reset it:**

```ts
const m = Audio.bus("Master").loudness;          // ADR:121
console.log(m.integrated, m.momentary, m.truePeak); // field names are my guess
m.reset?.();                                     // the record gives no method name
```

I would expect `momentary` to be empty for the first 400 ms of play (four 100 ms sub-blocks, `spikes/audio-mix/loudness/README.md` Method). The record doesn't say so.

**Set up a level-mode ducking rule in `project.json`:**

```jsonc
"ducking": [{
  "target": "Music", "trigger": "Voice",
  "mode": "level",            // ADR:137; default undecided (open question 6)
  "detector": "rms",          // name and values are my guess
  "threshold": -30,           // dBFS? the record doesn't say
  "amount": 0.4,              // multiplier, as today? or dB? (Issue 1)
  "attack": 0.05, "release": 0.4
}]
```

The trigger-before-target bus order is automatic (ADR:139), so I would not set it by hand.

**Mix live in the editor:** Project Settings > Audio, or the new Mixer panel (ADR:125). Faders, mute and solo apply at once (ADR:125). Structural edits such as re-parenting crossfade over about 20–50 ms (ADR:131). Whether a script's fade moves the editor fader is open (open question 8, ADR:252). That means a designer can see a fader that does not move while the game ducks it. The record should say which value the fader shows.

## Tasks I could take

**Suits me (TypeScript, Preact, no DSP):**
- The Profiler panel's timeline, cursor and voice list, once the stream format is frozen (ADR:228, 7 person-weeks). I'd need the record to fix what a frame looks like, and the panel's reading of `loadPermille`.
- The Mixer panel's faders, mute, solo and snapshot buttons, if open question 5 keeps it small (ADR:249).
- The capture export option and the web download (ADR:145, 232). The desktop path through `Storage` is already allowed (`spikes/audio-mix/capture/README.md`, "Facts read from code").
- Target warnings in the meters, and the sample and guide work (ADR:233).

**Looks risky for me:**
- Anything in `native/audio/`: stamped bus ramps that must stay bit-identical for unstamped work (ADR:185), the sidechain detector and gain computer, and the K-weighting and true-peak code. The spikes' own notes call the true-peak tap "assumed within tolerance" and unverified (ADR:220).
- The recorder ring. It must allocate nothing per block (ADR:92), and the spike's encoder still allocates about 370 B per STATUS (`spikes/audio-mix/capture/README.md`). I would need a pairing partner who knows the wasm allocator.
- Index-stable BUS_CONFIG and the crossfade classes (ADR:127-131). Structural edits are where the spike's clicks were found (`spikes/audio-mix/mix-core/README.md`).

## Debugging

| Symptom | What the record says | What I'd see | Gap |
|---|---|---|---|
| Profiler shows nothing | Recording runs only while the panel is open in Play, or during a capture (ADR:92). Babylon has no CPU line (ADR:100). | Today's debug panel shows "Not playing" (`AudioDebugPanel.tsx:150`). | The profiler's empty state is unspecified. A panel closed during play records nothing, and the record should say so on screen. |
| CPU reads 0 | The figure is a 256 ms average (ADR:98). | Before the first window fills, the value is 0, as today (`counters.rs:424-425`). | The record should say the panel shows "not yet measured", not 0. Firefox rounds `Date.now` to 1 ms (`cpu-clock/README.md`, unverified). |
| Loudness reads `-inf` or nothing | Integrated gates below -70 LUFS (ADR:18). Momentary needs about 400 ms of audio. | `BusMeters.tsx:13-14` draws an empty bar for zero peak, a fair guess at what a silent meter shows. | Silence, an unmetered bus, a fresh start and Babylon are four different cases. The record needs one value or label for each. |
| Ducking does not duck | Presence mode ducks while any trigger voice plays. Level mode uses the trigger's measured level (ADR:137). | Nothing, if the trigger is below threshold. | No view shows the detector's level or the gain reduction. I'd expect a meter next to each rule. Also unstated: whether the trigger is measured before or after its own fader. |
| A cycle in ducking | "Validation refuses it" (ADR:139). | Unknown. | Where the error shows (editor or load log; today's project warnings are `console.warn` at `src/engine/core/Engine.ts:185`) and its text. |
| A live edit does not apply | Applies in the same quantum (`spikes/audio-mix/mix-core/README.md`). Script values stack on the authored value (ADR:126). | The fader and the sound disagree. | The record should say how the editor shows both values, and what it shows when an edit is refused. |
| A capture won't open | Refused with a message if the wire differs (ADR:93). | An error. | The message's content is not specified. Give the two versions in it and say "re-record with this build". |
| Capture has no Android file | The Android route is open (ADR:219). | Nothing on a release build. | Expected for now. The record should say the release route is blocked, not failing. |

Overall: the record describes how the system should work well. It doesn't yet describe what a user sees when it doesn't.

## Cheaper alternatives

- Ship presence-mode ducking as the default for new rules until level mode has a visible detector meter. This removes the "does not duck" trap for newcomers. It changes open question 6.
- Reuse the existing debug panel's "Not playing" pattern for every new view, rather than inventing empty states per panel.

## Questions for the author

1. What is the JSON for a level-mode rule: field names, units, and the default mode (open question 6)?
2. Does `Audio.bus(name).loudness` throw, return `undefined` or return `-Infinity` for an unmetered or silent bus?
3. Does `save()` with nothing recorded throw or write an empty file?
4. Does the editor fader show the authored value or the authored value times the script's multiplier (open question 8)?
5. Is a capture that starts after the ring wrapped marked as truncated?
