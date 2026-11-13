# 0158. Audio events are data assets; main picks their voices when something happens, and the core runs everything continuous: parameters, curves, blends and sustain loops

- **Status:** Accepted, amended by 0166 and 0167 (`myco.audioevent@1` gains music nodes: segment, playlist, musicSwitch, transition rules, stingers; its handle gains `music`, `onMusic` and `trigger`)
- **Date:** 2026-11-10
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0157 (size gates become tripwires, not design constraints; the mixer's is raised to 256 KB)
- **Related:** 0157 (roadmap M2; the core, voices, `AudioHandle`, `group`), 0097 (buses, snapshots, ducking), 0074 (spatial fields), 0098 (backends), 0040 (sidecars), 0057 (particle curves), 0133 (plugins), 0134/0143 (asset kinds and formats), 0148 (rename tracking), 0046/0058 (graph editors; not used here)

## Context

M1 of 0157 is done (owner, 2026-11-10). Audio is the `myco.audio` plugin on the Rust core in an AudioWorklet, with Babylon's AudioEngineV2 as the fallback. Game code can play **clips**: `AudioSource.clip`, `Audio.playOneShot(clip, {volume, pitch, position, bus, priority, at})`, an `AudioHandle` (`playing`, `reason`, `stop`, `fade`), buses, snapshots and ducking. There is no way to say "a footstep" instead of "footstep_03.ogg": every variation, random pitch, layered sound, surface switch or intensity crossfade is script code today, and a sound designer can't change it without a programmer.

0157's roadmap names M2: event assets with random, sequence, switch, blend and layer containers; game parameters driving properties through curves; states; `Audio.play(event, params)` returning an `AudioHandle`; editor authoring in the plugin's editor half; a curve format shared with the planned animation system and not frozen by 0157. Each roadmap milestone gets its own record; this is M2's.

**What M1 left for M2** (architecture §10):
- Containers were designed to run on main and play ordinary voices. Stamped records and `rampFrames` on SET_PARAMS, FADE and BUS_MIX give automation; `at` gives sample-accurate starts.
- PLAY and the voice table carry a reserved `u16 group` (0 = none), so event instances need no wire version bump.
- The mixer wasm is 143.9 KB of its 150 KB gate. The owner rates that gate arbitrary (2026-11-10): download size is not a goal worth bending the design for. The high preset's audio-thread reserve for M2–M4 is ≈0.11 ms per quantum (design README); that budget still matters.
- Loops today are whole-clip only (PLAY `flags` bit0, gapless through the decoder for streams). There is no loop region inside a clip and no way to let a looping sound play out its tail.
- Main-thread budgets: command batch ≤ 0.1 ms, voice bookkeeping ≤ 0.25 ms per frame.

**What exists to reuse:**
- Authored assets are JSON with a compound extension and a leading `"format": "myco.<kind>@N"` tag, parsed leniently by a pure engine module (e.g. `engine/sky/skyFormat.ts`), loaded at run time through `Assets.json` with a per-object cache (`sky/skyAsset.ts`), and registered in an editor plugin with `registerAssetKind` and `registerAssetFormat` (0134, 0143; `editor/sdk/contributions.ts`). Renames follow 0148.
- Particle curves are `[t, v]` keys, linear between keys, flat past the ends, `t` in 0..1 (`CurveKey` and `evalCurve` in `scene/particles.ts`), with pure editing helpers (`plugins/particles/editor/particles/curveEdit.ts`) and a Preact `CurveEditor.tsx` widget in the particles plugin. There is no other curve type, no easing type, and no animation system or record (0075 names `src/engine/animation/` as its future home).
- `seededRandom` (`render/particles/random.ts`).

**How others do it.** FMOD Studio: events with a timeline, multi/scatterer instruments, parameters (local and global, labelled, with seek speed) automating properties through curves, snapshots. Wwise: actor-mixer hierarchy of random/sequence/switch/blend containers, game parameters (RTPCs) and states/switches. Both are proprietary (0157). Our M2 takes Wwise's container vocabulary and FMOD's parameter model, without a timeline (that is M4's music grid and a later question).

## Decision

**We will add audio events as data assets, with named parameters driving event and bus properties through a shared curve type. The work is split by when it happens:**
- **Main does only event-driven work, never per-frame work for a running instance:** when a script plays an event (walk the tree, make the random, sequence and switch picks, send PLAYs), when a script sets a parameter (send the new value), and when a continuous container's clip starts (schedule the next one). An instance whose parameters aren't changing costs main nothing per frame.
- **The core does everything continuous, per quantum:** parameter smoothing (`seekSpeed`), curve evaluation, blend weights, the resulting voice and bus gain, pitch and low-pass, and sustain loops and their release.
- **Main keeps owning the voice table and selection (0157):** every voice an event plays is an ordinary voice main created, so priority, limits, stealing, handles and `Audio.debug()` work unchanged.

### 1. Event assets

- **File:** `*.audioevent.json`, `"format": "myco.audioevent@1"`. The pure parser lives in the engine (`src/engine/audio/eventFormat.ts`, lenient, problems not throws); the runtime reads it with `Assets.json` and caches per object, as sky assets do. The audio plugin's editor half registers asset kind `"audioEvent"` and its format (0134/0143). Clips inside are asset paths, found by the exporter and kept up to date on rename (0148) like any other reference.
- **Shape:**

```jsonc
{
  "format": "myco.audioevent@1",
  "bus": "SFX",                          // default Master; unknown: Master plus the existing warning
  "volume": 1, "pitch": 1,               // base multipliers
  "volumeRandom": [0, 0],                // dB added per play, uniform in the range
  "pitchRandom": [0, 0],                 // semitones added per play
  "priority": 128,
  "spatial": { "enabled": true, "minDistance": 1, "maxDistance": 30, "rolloff": "inverse" }, // absent: flat
  "limit": { "maxInstances": 4, "steal": "oldest" },  // "oldest" | "quietest" | "none" (refuse the new one)
  "cooldown": 0.05,                      // seconds; plays sooner than this after the last one are refused
  "parameters": [{ "name": "Speed", "min": 0, "max": 10, "default": 0, "seekSpeed": 20 }], // local parameters
  "automation": [{ "parameter": "Speed", "target": "volume", "curve": [[0, 0.5], [10, 1]] }],
  "root": { "type": "random", "avoidRepeat": 2, "children": [
    { "type": "clip", "clip": "sfx/step_01.ogg", "weight": 1 },
    { "type": "clip", "clip": "sfx/step_02.ogg" }
  ]}
}
```

- **Containers** (a tree; every node may also carry `volume`, `pitch`, `volumeRandom`, `pitchRandom`, `delay` seconds and its own `automation`):
  - **`clip`**: plays one clip; `loop`, `startOffset` seconds. `loopRegion: [start, end]` seconds loops only that part of the clip (default: the clip's own loop points, §4, else the whole clip). With `"sustain": true` the region loops until the instance is **released**, then the voice plays on through the rest of the clip (its tail) and ends.
  - **`random`**: picks one child by `weight`; `avoidRepeat` n skips the last n picks; `mode: "step"` (one child per play, default) or `"continuous"` (keep picking back to back, gapless through `at`, until stopped; `gap` seconds, may be negative for an overlap with equal-power crossfade).
  - **`sequence`**: children in order; `mode: "step"` advances one child per play (the position is kept per event asset per World, `reset` after n seconds idle), or `"continuous"` plays them back to back like `random`; `loop` for continuous.
  - **`switch`**: plays the child whose `value` matches a labelled parameter (`"parameter": "Surface"`, children carry `"value": "Grass"`), else `default`. `onChange: "keep" | "restart" | "crossfade"` (seconds) for a change while playing.
  - **`blend`**: all children play; each child has a `range: [lo, hi]` on a parameter and fades in and out across its edges (equal-power, `fade` width in parameter units). Children outside their range are virtual, not stopped, so they stay in time.
  - **`layer`**: all children play together.
  - **`sustain`**: three children, `start` (optional), `loop` and `end` (optional), for sounds authored as separate files. `start` then `loop` play back to back, gapless through `at`; `loop` repeats until release; on release `end` plays, `release: "now"` (crossfade, `fade` seconds) or `"loopEnd"` (at the end of the current loop pass, sample-accurate). Any node can sit in each slot, so the loop can itself be a blend or a random container.
- **Instances.** Each `Audio.play` makes an **event instance**: its voices share an instance id carried in PLAY's reserved `group` (wrapping `u16`, 0 = none), its parameters, its position and its handle. Voices are still selected one by one by M1's selection, with the event's priority; the event `limit` acts on whole instances.

### 2. Parameters

- **Global parameters** are declared in the project's `audio` section: `"parameters": [{ "name": "Intensity", "min": 0, "max": 1, "default": 0, "seekSpeed": 0 }]`, or **labelled**: `{ "name": "Area", "labels": ["Outdoor", "Cave", "Hall"], "default": "Outdoor" }`. **States** (0157's word) are labelled global parameters; there is no separate state system.
- **Local parameters** are declared on the event and set per instance.
- **`seekSpeed`** (units per second, 0 = immediate) smooths changes so automation doesn't zipper; labelled parameters always jump.
- Unknown names, wrong types and out-of-range values warn once and clamp or are ignored, as elsewhere in audio.

### 3. Automation and the shared curve

- **Targets:** on events and nodes, `volume` (linear gain), `pitch` (ratio), `lowpass` (Hz, the voice's existing `lpHz`); on **buses** (project `audio.automation`, global parameters only), the bus `volume` and `lowpass`. Bus automation multiplies with snapshots and ducking (0097); it doesn't replace them.
- **Where it runs: in the core.** At play, main sends each voice's automation bindings (parameter slot, curve id, target) after its PLAY; curves are uploaded once per event asset when it loads, global parameter slots once from the project. `Audio.setParameter` and `handle.setParameter` send one PARAM command (scope: global or the instance's `group`, slot, value). Each quantum the core moves every parameter toward its target at its `seekSpeed`, evaluates the bound curves once (control rate, 2.67 ms) and ramps the result linearly across the quantum, so automation is smooth and independent of the game's frame rate.
- **Selection still sees it.** When a parameter changes, main evaluates the affected curves once at the target value (the same TypeScript `curve.ts`) to update those voices' audibility scores; smoothing in the core makes the heard value trail by at most the seek time, which selection's hysteresis absorbs.
- **Commands (ABI minor 1.4, no wire major bump):** CURVES (upload a curve table), AUTOMATE (a voice's bindings), PARAM (set a parameter's target and seek speed), BUS_AUTOMATE (bus bindings to global parameters). Byte layouts go in the design doc.
- **The curve type** is engine-level, not audio's: `src/engine/core/curve.ts`, `Curve = CurveKey[]` where `CurveKey = [x, y]` or `[x, y, interp]`, `interp` the shape to the next key: `"linear"` (default), `"step"`, `"smooth"` (smoothstep), `"easeIn"`, `"easeOut"`. Keys sorted by `x`, clamped outside the first and last. A particle curve is a valid `Curve` with `x` in 0..1, so 0057's data needs no migration; particles may adopt the module later. Animation can add a key form with tangents additively (`{x, y, in, out}`); `Curve` is not frozen beyond "existing forms keep their meaning".

### 4. Sustain and release

- **Release** is a key-off: `handle.release()` (and `AudioSource.release()`). Every `sustain` clip and `sustain` container in the instance leaves its loop and plays its tail; nodes without sustain are unaffected. A released instance ends when its last voice ends. `stop(fade)` still stops at once. Releasing twice, or an instance with no sustain, is a no-op.
- **In the core:** a new command **SET_LOOP** (`0x08`: `u32 loopStartFrame; u32 loopEndFrame; u32 flags` with bit0 looping), stamped like every voice command, so a release can land on an exact frame. PLAY's loop flag keeps meaning "the whole clip", so old batches mean what they did. Release is SET_LOOP with bit0 clear: the voice finishes its current pass and plays on to the clip's end. ABI minor version 1.4; no wire major bump.
- **Streams** loop a region through the decoder worker's existing gapless-loop path, which seeks to `loopStart` at `loopEnd` and prefetches from it.
- **Loop points in files:** the decoder reads WAV `smpl` loop points and Ogg/Opus `LOOPSTART`/`LOOPLENGTH` comments (a common game-audio convention). A clip's sidecar (0040) can set `loopStart`/`loopEnd` seconds, which win over the file.
- **Babylon fallback:** `AudioBufferSourceNode.loopStart`/`loopEnd`, and release clears `loop`; streamed clips there loop whole (warns once).

### 5. Public API

```ts
// New, in the audio plugin's public surface (re-exported from "myco" as today):
Audio.play(event: string, options?: EventOptions): AudioEventHandle;   // an event asset, or a clip (wrapped as a one-clip event)
Audio.setParameter(name: string, value: number | string): void;       // global
Audio.getParameter(name: string): number | string | undefined;

interface EventOptions { volume?: number; pitch?: number; position?: Vec3Like; bus?: string; priority?: number; at?: number;
  parameters?: Record<string, number | string>; }

interface AudioEventHandle extends AudioHandle {   // M1's four members keep their meaning
  setParameter(name: string, value: number | string): void;
  getParameter(name: string): number | string | undefined;
  position: Vec3Like | null;                       // move a spatial instance; null for flat
  release(): void;                                 // key-off: sustain loops play their tails (§4)
}
```

- **`AudioSource`** accepts an event asset in `clip` (asset kinds `"audio"` and `"audioEvent"`), plays it as an instance that follows the node, and gains `setParameter`/`getParameter` and `release()`. The field keeps its name so scenes don't migrate.
- `Audio.playOneShot` stays for clips and is unchanged.
- **Completion** stays polled (`handle.playing`, `handle.reason`), as settled in 0157. A continuous event plays until stopped. `stop(fade)` fades every voice of the instance.
- `Audio.debug()` gains `events: { id, asset, world, voices, parameters }[]`; each voice row gains `event` (instance id or null). The Audio Debug panel groups voices by instance.

### 6. Runtime and the core

- **Main:** `src/plugins/audio/runtime/events/` (asset loading, the instance tree and its picks, parameter bookkeeping, scheduling continuous containers), behind the backend interface (0098).
- **Core:** a parameter table (global slots plus per-instance slots keyed by `group`), a curve table, per-voice and per-bus bindings, and SET_LOOP (§4). `group` also gains its meaning in STATUS's voice section for debugging.
- **Babylon fallback:** there is no core, so a TypeScript port of the same smoothing and curve evaluation runs once per frame on main and drives voices through SET_PARAMS-equivalent calls. This is the only case where events cost main per-frame work, and the fallback is already the degraded path. A parity test runs the same scenes through the Rust and TypeScript evaluators. Per-voice `lowpass` is not available on Babylon (it warns once, as bus effects already do).
- **Size gates (amends 0157).** The build still checks sizes, as a tripwire against accidents (a dependency dragging in formatting code, say), not as a design constraint: the mixer's gate goes from 150 KB to 256 KB (`MIXER_LIMIT` in `native/audio/build.mjs`); the decoder gates stay. Raising a gate is a one-line change with a line in the build log saying why. Review entry 22's pinned `wasm-opt` is no longer needed for headroom.
- **Timing.** Steps and switch picks happen on main at the frame the play or change arrives; continuous containers schedule each next clip with `at` from known clip lengths and the heard clock, a frame or more ahead, so they are gapless and sample-accurate. A clip whose length isn't known yet (still loading or streaming) starts the next on its end, one frame late, and the debug panel counts it.
- **Randomness** is seeded per World from `audio.seed` (default: random each run); tests and goldens set it.
- **Budget (lab VM, measured in the M2 bench):** main ≈ 0 per frame for steady instances; ≤ 5 µs per `Audio.play` of a typical event and per `setParameter`. Core: automation ≤ 0.03 ms p99.9 per quantum at 256 voices with 3 bindings each, taken from the M2 share of the 0.5 ms reserve; it joins the metered benchmark scenes. A layered event costs its voices, as before.

### 7. Editor authoring (M2b)

- **An Event editor** in the audio plugin's editor half opens `*.audioevent.json`: the container tree on the left (add, reorder, drag clips in from the asset browser), the selected node's properties on the right, and the event's parameters with sliders for auditioning. Preact, as every editor panel; it's a tree, not a node graph, so no xyflow.
- **The curve widget:** the particles plugin's `CurveEditor.tsx` and `curveEdit.ts` move to `src/editor/ui/` and gain an arbitrary x range and per-segment interpolation; the particle inspector keeps using it (its x range is 0..1). Theme tokens only.
- **Audition** plays the event in the editor through the running audio host, with the parameter sliders live and a small per-instance voice list.
- **Project Settings > Audio** gains Parameters (global, labelled) and bus Automation.
- **New Event** in the asset browser's create menu; a clip's context menu gains "Create event from clips".

### 8. Phasing and checks

- **M2a, runtime:** curve module, asset format and parser, containers, parameters, automation, `Audio.play`, `AudioSource` events, debug output, docs ("Sound events" guide page). Tests: Vitest for parsing, container picks (seeded), step positions, switch and blend transitions, automation on a fake backend, instance limits and cooldown, release; `cargo test` for SET_LOOP (region loops, release on the frame, streams); WAV `smpl` and Ogg loop-comment parsing; wasm goldens for a layered, a blend, a continuous and a sustained-then-released event; one `@slow` spec playing a sample event set.
- **M2b, editor:** Event editor, curve widget, audition, settings sections, create menu. Playwright specs for authoring and audition.
- **A sample:** `samples/sound-lab` gains an events page (footsteps by surface, an engine loop blended by RPM with a sustain and an engine-off tail, a music intensity bus automation), which is also M2's listening-pass material.
- Exit: the tests above, the Rust–TypeScript automation parity test, the metered gate (+10%, with new automation scenes), the M2 bench within the budgets above, and the owner's listening pass of the sample events.

## Alternatives considered

- **Everything on main, evaluated per frame** (this record's first draft). Simplest, one implementation, and it works the same on the fallback, but it puts recurring work on the game's thread and makes automation step at frame rate (≈33 ms at 30 fps). The owner wants main loaded no more than necessary.
- **Containers in the core too** (the core makes the picks and starts voices itself). It would take the play-time picks off main, but those are microseconds once per play, and voices born in the core would be invisible to main's voice table: selection, limits, stealing, handles and debugging would need a second policy implementation in Rust. Not worth it for work that isn't recurring.
- **Sustain on main** (stop the loop voice and start the tail with `at`). Works for three-file sounds, which the `sustain` container does, but a loop region inside one clip would need a seek inside a playing voice; SET_LOOP is simpler and also gives authored loop points from files.
- **Node-graph authoring (xyflow) like the shader and particle graphs.** Events are trees with a few dozen nodes; a graph adds wiring without adding expressiveness. A graph view can be added later if events grow logic.
- **A separate state system alongside parameters (Wwise).** Labelled global parameters cover it with one concept and one API.
- **A timeline per event (FMOD).** Powerful for cinematic sound, but it is most of FMOD's authoring tool. Left for M4 (music grid) or a later record; `delay` per node covers simple timing.
- **Events as components or prefabs** instead of assets. An event must be playable without a node (`Audio.play` from any script) and shared between scenes; an asset fits, as particle effects do.
- **Freeze a full animation-curve format now** (tangents, wrap modes). Animation has no record; a small superset of particle curves serves M2 and leaves animation free.

## Consequences

**Positive**
- Sound designers author variation, layering, switching and intensity in data, audition in the editor, and programmers call `Audio.play("sfx/footstep", { parameters: { Surface: "Gravel" } })`.
- Sustained sounds (engines, weapons, charge-ups, held notes) loop and release cleanly, and loop points authored in WAV and Ogg files are honoured, also for plain `AudioSource` loops.
- Main does no per-frame work for running events; automation is smooth at the quantum (2.67 ms) whatever the frame rate.
- Events behave the same on both backends; the voice table, selection and debugging are unchanged.
- One curve type for audio now, particles and animation later.

**Negative / costs**
- Curve evaluation and smoothing exist twice, in Rust for the core and TypeScript for the fallback and for selection scores; the parity test keeps them together.
- Automation spends ≈0.03 ms of the audio thread's 0.5 ms reserve, which M3 also wants.
- Five new core commands (CURVES, AUTOMATE, PARAM, BUS_AUTOMATE, SET_LOOP) and the tables behind them.
- A parameter change still reaches the core with the next frame's command batch (up to a frame late); only the smoothing after it is at audio rate.
- The editor half (tree editor, curve widget, audition) is likely larger than the runtime. Estimate: M2a ≈ 6 person-weeks (sustain and the core automation add two), M2b ≈ 5, plus the sample and listening pass.
- `AudioSource.clip` now accepts two asset kinds, which the inspector and docs must make clear.

## Deprecates

Nothing. `Audio.playOneShot` and clip-based `AudioSource` stay. 0157's 150 KB mixer gate is replaced by the 256 KB tripwire.

## Open questions

- **Named cues beyond release** (several sustain points per event, FMOD-style, stepped through by repeated key-offs). One release per instance covers M2.
- **Parameter-driven snapshots** (a snapshot's intensity from a global parameter) beyond bus volume and lowpass automation.
- **Effects per event** (an event's own filter or send) would need core work; deferred to M3 with reverb zones.
- **Whether particles' `evalCurve` moves onto `core/curve.ts`** in M2 (cheap: same data, linear keys) or when animation lands.

## Amendment (0166, 0167): music nodes in the event format

Interactive music is part of the event format, not a new asset kind. `myco.audioevent@1` is unchanged for every existing file; what is added is below. Nothing in this record's `clip`, `layer`, `random`, `switch`, `blend` and `sequence` nodes changes.

- **Three new node types.** A `segment` (audio with a tempo map, cues, loop regions and stem tracks), a `playlist` (children in `sequence`, `random` or `shuffle` order, `rounds`, `avoidRepeat`) and a `musicSwitch` (children keyed by `value`, chosen by a labelled parameter). An event's `root` may be any of the three. A playlist or switch may hold the same three types, nested to depth 16 at most; a music node may not sit under a 0158 container and a 0158 node may not sit under a music container (the node is dropped with a problem). The event keeps its 1,024-node cap, and the `library` segments count in it.
- **A required node id.** Every music node has an `id` (`^[A-Za-z0-9_-]{1,48}$`, unique in the event). `NodeBase` gains an optional `id` so that rules, scripts and the debug panel can name a node; 0158 nodes need none.
- **Containers carry the arrangement.** `transitions` (up to 256 rules per container, chosen by specificity in four tiers, with exit rule, enter rule, fades with `linear`, `sCurve` or `equalPower` curves, and an optional bridge), `stingers` (up to 32, started on a grid point or cue by `handle.trigger(name)`) and `library` (up to 64 segments per event, used by bridges and stingers and not children).
- **Music ignores part of the node model.** `pitch`, `pitchRandom`, `delay`, `range` and `fade` on a music node are read and ignored with one problem each; a `pitch` automation on a stem is an error (0167 §3 decision 2; a fixed rate is what the beat clock and loop prediction need). `volume`, `volumeRandom` and `weight` still apply, and `plays` and `value` are new. `limit`, `priority`, `bus` and `parameters` on the event are read as for any event; a stem's `bus` overrides the event's for that stem.
- **Parameters.** A `musicSwitch` reads a labelled parameter, local or global, and a change asks for a transition instead of switching at once. A stem's `automation` (`volume` and `lowpass` only) may carry `quantize: "beat" | "bar"`: main reads the parameter on that grid point and stamps a 20 ms ramp, instead of the core following the parameter continuously. A region's `while` condition reads a parameter once per pass, at the commit point just before the loop end.
- **The handle.** `Audio.play` on a music event returns the same `AudioEventHandle`, now also a `MusicEventHandle`: `handle.music` (position, tempo, `transition`, `nextGrid`, `positionAt`, `seek`; `undefined` for a non-music event), `handle.onMusic(kind, fn)` for beat, bar and cue callbacks (0167 §3 decision 3) and `handle.trigger(name)`. `EventOptions.at` is the heard time of the entry cue. `handle.stop(fade)` fades all stems together and is not quantised.
- **Components.** `GameBehavior` gains the hooks `onMusicBeat`, `onMusicBar` and `onMusicCue`, delivered from the built-in system `engine.AudioMusic` in `update`, before `engine.UpdateScripts` (0093's messages; 0167 §2).
- **Lenient parse, as before.** The music parser follows this record's rule: a bad entry is dropped or clamped and reported, never thrown. Music-specific lint (stem length, rate and channels, MP3 without a length header, ring need, tail longer than the loop) is a separate pass, `validateMusic`, run at the first play and live in the editor.
- **Size gates.** This record's rule that wasm size gates are tripwires still holds; the mixer module grew with music to 318,306 B, past the 300 KB warning and under the 320 KB gate, which did not move (each step in the build log, `docs/design/0166-audio-music/build-log.md`).

The reference for the format and the API is `docs/guide/interactive-music-api.md`.

## References

- `docs/decisions/0157-audio-runs-on-an-engine-owned-rust-core-in-an-audioworklet.md` (Roadmap, M2); `docs/design/0157-audio-core/architecture.md` §10 and `api-and-models.md` §4.2 (`group`, SET_PARAMS, `rampFrames`).
- `src/plugins/audio/runtime/Audio.ts`, `AudioSource.ts`, `backend.ts` (the M1 API this extends).
- `src/engine/scene/particles.ts` (`CurveKey`, `myco.particles@1`).
- Wwise containers and RTPCs; FMOD Studio parameters and seek speed (concepts only; neither is a dependency).

## Amended by ADR 0172 (M5), 2026-11-13: bus automation is one gain lane

Section 3 says bus automation "multiplies with snapshots and ducking (0097); it doesn't replace them". That holds, and M5 names the place it multiplies (0172 §1.3; [0171 change 15](0171-audio-profiler-loudness-metering-and-live-mixing.md)).

- **Automation is the core's `automation` lane**, one of a bus's seven gain lanes (see 0097's amendment). It stays in the core, evaluated per quantum as before; the `BUS_AUTOMATE` command and the curves are unchanged. A bus's volume curve is not a stamped ramp: the core follows the parameter's smoothed value, as section 3 says.
- **It is a separate lane, so** a fade, a duck, a snapshot and an automation curve on one bus no longer share a value. `bus.effectiveGain` is still their product with the parents' gains.
- **Only the Babylon fallback changes:** it multiplies the lanes on main (0171 change 15).
- The Profiler shows the automation factor beside the others at the cursor (a later M5 task).

The build is in `bus.rs` and its tests, see the [build log](../design/0171-audio-mix/build-log.md) (B1a, Wave 2).
