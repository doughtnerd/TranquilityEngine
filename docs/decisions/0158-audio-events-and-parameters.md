# 0158. Audio events are data assets whose containers run on the main thread over core voices, driven by named parameters through curves

- **Status:** Proposed
- **Date:** 2026-11-10
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0157 (roadmap M2; the core, voices, `AudioHandle`, `group`), 0097 (buses, snapshots, ducking), 0074 (spatial fields), 0098 (backends), 0040 (sidecars), 0057 (particle curves), 0133 (plugins), 0134/0143 (asset kinds and formats), 0148 (rename tracking), 0046/0058 (graph editors; not used here)

## Context

M1 of 0157 is done (owner, 2026-11-10). Audio is the `myco.audio` plugin on the Rust core in an AudioWorklet, with Babylon's AudioEngineV2 as the fallback. Game code can play **clips**: `AudioSource.clip`, `Audio.playOneShot(clip, {volume, pitch, position, bus, priority, at})`, an `AudioHandle` (`playing`, `reason`, `stop`, `fade`), buses, snapshots and ducking. There is no way to say "a footstep" instead of "footstep_03.ogg": every variation, random pitch, layered sound, surface switch or intensity crossfade is script code today, and a sound designer can't change it without a programmer.

0157's roadmap names M2: event assets with random, sequence, switch, blend and layer containers; game parameters driving properties through curves; states; `Audio.play(event, params)` returning an `AudioHandle`; editor authoring in the plugin's editor half; a curve format shared with the planned animation system and not frozen by 0157. Each roadmap milestone gets its own record; this is M2's.

**What M1 left for M2** (architecture §10):
- Containers were designed to run on main and play ordinary voices. Stamped records and `rampFrames` on SET_PARAMS, FADE and BUS_MIX give automation; `at` gives sample-accurate starts.
- PLAY and the voice table carry a reserved `u16 group` (0 = none), so event instances need no wire version bump.
- The mixer wasm is 143.9 KB of its 150 KB gate, and the high preset's reserve for M2–M4 is ≈0.11 ms per quantum (design README). Anything added to the core must be small.
- Main-thread budgets: command batch ≤ 0.1 ms, voice bookkeeping ≤ 0.25 ms per frame.

**What exists to reuse:**
- Authored assets are JSON with a compound extension and a leading `"format": "myco.<kind>@N"` tag, parsed leniently by a pure engine module (e.g. `engine/sky/skyFormat.ts`), loaded at run time through `Assets.json` with a per-object cache (`sky/skyAsset.ts`), and registered in an editor plugin with `registerAssetKind` and `registerAssetFormat` (0134, 0143; `editor/sdk/contributions.ts`). Renames follow 0148.
- Particle curves are `[t, v]` keys, linear between keys, flat past the ends, `t` in 0..1 (`CurveKey` and `evalCurve` in `scene/particles.ts`), with pure editing helpers (`plugins/particles/editor/particles/curveEdit.ts`) and a Preact `CurveEditor.tsx` widget in the particles plugin. There is no other curve type, no easing type, and no animation system or record (0075 names `src/engine/animation/` as its future home).
- `seededRandom` (`render/particles/random.ts`).

**How others do it.** FMOD Studio: events with a timeline, multi/scatterer instruments, parameters (local and global, labelled, with seek speed) automating properties through curves, snapshots. Wwise: actor-mixer hierarchy of random/sequence/switch/blend containers, game parameters (RTPCs) and states/switches. Both are proprietary (0157). Our M2 takes Wwise's container vocabulary and FMOD's parameter model, without a timeline (that is M4's music grid and a later question).

## Decision

**We will add audio events as data assets, evaluated by a TypeScript event runtime on the main thread that plays ordinary core voices, with named parameters driving event and bus properties through a shared curve type. The core gains no new DSP and no new command kinds.**

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
  - **`clip`**: plays one clip; `loop`, `startOffset` seconds.
  - **`random`**: picks one child by `weight`; `avoidRepeat` n skips the last n picks; `mode: "step"` (one child per play, default) or `"continuous"` (keep picking back to back, gapless through `at`, until stopped; `gap` seconds, may be negative for an overlap with equal-power crossfade).
  - **`sequence`**: children in order; `mode: "step"` advances one child per play (the position is kept per event asset per World, `reset` after n seconds idle), or `"continuous"` plays them back to back like `random`; `loop` for continuous.
  - **`switch`**: plays the child whose `value` matches a labelled parameter (`"parameter": "Surface"`, children carry `"value": "Grass"`), else `default`. `onChange: "keep" | "restart" | "crossfade"` (seconds) for a change while playing.
  - **`blend`**: all children play; each child has a `range: [lo, hi]` on a parameter and fades in and out across its edges (equal-power, `fade` width in parameter units). Children outside their range are virtual, not stopped, so they stay in time.
  - **`layer`**: all children play together.
- **Instances.** Each `Audio.play` makes an **event instance**: its voices share an instance id carried in PLAY's reserved `group` (wrapping `u16`, 0 = none), its parameters, its position and its handle. Voices are still selected one by one by M1's selection, with the event's priority; the event `limit` acts on whole instances.

### 2. Parameters

- **Global parameters** are declared in the project's `audio` section: `"parameters": [{ "name": "Intensity", "min": 0, "max": 1, "default": 0, "seekSpeed": 0 }]`, or **labelled**: `{ "name": "Area", "labels": ["Outdoor", "Cave", "Hall"], "default": "Outdoor" }`. **States** (0157's word) are labelled global parameters; there is no separate state system.
- **Local parameters** are declared on the event and set per instance.
- **`seekSpeed`** (units per second, 0 = immediate) smooths changes so automation doesn't zipper; labelled parameters always jump.
- Unknown names, wrong types and out-of-range values warn once and clamp or are ignored, as elsewhere in audio.

### 3. Automation and the shared curve

- **Targets:** on events and nodes, `volume` (linear gain), `pitch` (ratio), `lowpass` (Hz, the voice's existing `lpHz`); on **buses** (project `audio.automation`, global parameters only), the bus `volume` and `lowpass`. Bus automation multiplies with snapshots and ducking (0097); it doesn't replace them.
- **When it applies:** once per frame, after scripts' `update` and before the audio system's selection. Changed values go out as SET_PARAMS or BUS_MIX with `rampFrames` covering one frame, so the core ramps between frames and there are no steps.
- **The curve type** is engine-level, not audio's: `src/engine/core/curve.ts`, `Curve = CurveKey[]` where `CurveKey = [x, y]` or `[x, y, interp]`, `interp` the shape to the next key: `"linear"` (default), `"step"`, `"smooth"` (smoothstep), `"easeIn"`, `"easeOut"`. Keys sorted by `x`, clamped outside the first and last. A particle curve is a valid `Curve` with `x` in 0..1, so 0057's data needs no migration; particles may adopt the module later. Animation can add a key form with tangents additively (`{x, y, in, out}`); `Curve` is not frozen beyond "existing forms keep their meaning".

### 4. Public API

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
}
```

- **`AudioSource`** accepts an event asset in `clip` (asset kinds `"audio"` and `"audioEvent"`), plays it as an instance that follows the node, and gains `setParameter`/`getParameter`. The field keeps its name so scenes don't migrate.
- `Audio.playOneShot` stays for clips and is unchanged.
- **Completion** stays polled (`handle.playing`, `handle.reason`), as settled in 0157. A continuous event plays until stopped. `stop(fade)` fades every voice of the instance.
- `Audio.debug()` gains `events: { id, asset, world, voices, parameters }[]`; each voice row gains `event` (instance id or null). The Audio Debug panel groups voices by instance.

### 5. Runtime and the core

- **Where:** `src/plugins/audio/runtime/events/` (asset parse, instance tree, parameters, automation), behind the backend interface (0098), so **events work the same on the Babylon fallback**. Only voices are backend-specific; per-voice `lowpass` is not available on Babylon (it warns once, as bus effects already do).
- **The core is unchanged** except that `group` gains its meaning in STATUS's voice section for debugging. No ABI change; no mixer wasm growth expected. If an M2 need does reach the core (a per-instance gain stage, say), it gets a minor ABI version and must fit the 150 KB gate.
- **Timing.** Steps and switch picks happen on main at the frame the play or change arrives; continuous containers schedule each next clip with `at` from known clip lengths and the heard clock, a frame or more ahead, so they are gapless and sample-accurate. A clip whose length isn't known yet (still loading or streaming) starts the next on its end, one frame late, and the debug panel counts it.
- **Randomness** is seeded per World from `audio.seed` (default: random each run); tests and goldens set it.
- **Budget:** event evaluation and automation ≤ 0.15 ms per frame at 256 active instances on the lab VM (measured in the M2 bench, added to the main-thread table). Core cost per voice is unchanged; a layered event costs its voices.

### 6. Editor authoring (M2b)

- **An Event editor** in the audio plugin's editor half opens `*.audioevent.json`: the container tree on the left (add, reorder, drag clips in from the asset browser), the selected node's properties on the right, and the event's parameters with sliders for auditioning. Preact, as every editor panel; it's a tree, not a node graph, so no xyflow.
- **The curve widget:** the particles plugin's `CurveEditor.tsx` and `curveEdit.ts` move to `src/editor/ui/` and gain an arbitrary x range and per-segment interpolation; the particle inspector keeps using it (its x range is 0..1). Theme tokens only.
- **Audition** plays the event in the editor through the running audio host, with the parameter sliders live and a small per-instance voice list.
- **Project Settings > Audio** gains Parameters (global, labelled) and bus Automation.
- **New Event** in the asset browser's create menu; a clip's context menu gains "Create event from clips".

### 7. Phasing and checks

- **M2a, runtime:** curve module, asset format and parser, containers, parameters, automation, `Audio.play`, `AudioSource` events, debug output, docs ("Sound events" guide page). Tests: Vitest for parsing, container picks (seeded), step positions, switch and blend transitions, automation on a fake backend, instance limits and cooldown; wasm goldens for a layered, a blend and a continuous event; one `@slow` spec playing a sample event set.
- **M2b, editor:** Event editor, curve widget, audition, settings sections, create menu. Playwright specs for authoring and audition.
- **A sample:** `samples/sound-lab` gains an events page (footsteps by surface, an engine loop blended by RPM, a music intensity bus automation), which is also M2's listening-pass material.
- Exit: the tests above, the metered gate unchanged (+10%), the M2 bench under 0.15 ms, and the owner's listening pass of the sample events.

## Alternatives considered

- **Containers in the core (Rust).** Sample-accurate parameter changes and no main-thread cost, but the mixer has ≈6 KB of headroom in its size gate, the design keeps policy on main (selection already is), and it would duplicate the work for the Babylon fallback. Frame-rate automation with per-frame ramps is what FMOD and Wwise do for game-driven parameters too.
- **Node-graph authoring (xyflow) like the shader and particle graphs.** Events are trees with a few dozen nodes; a graph adds wiring without adding expressiveness. A graph view can be added later if events grow logic.
- **A separate state system alongside parameters (Wwise).** Labelled global parameters cover it with one concept and one API.
- **A timeline per event (FMOD).** Powerful for cinematic sound, but it is most of FMOD's authoring tool. Left for M4 (music grid) or a later record; `delay` per node covers simple timing.
- **Events as components or prefabs** instead of assets. An event must be playable without a node (`Audio.play` from any script) and shared between scenes; an asset fits, as particle effects do.
- **Freeze a full animation-curve format now** (tangents, wrap modes). Animation has no record; a small superset of particle curves serves M2 and leaves animation free.

## Consequences

**Positive**
- Sound designers author variation, layering, switching and intensity in data, audition in the editor, and programmers call `Audio.play("sfx/footstep", { parameters: { Surface: "Gravel" } })`.
- No core change: the size gate, the metered gate and the audio-thread budget are untouched, and events work on both backends.
- One curve type for audio now, particles and animation later.

**Negative / costs**
- Parameter changes take effect at frame rate (ramped over the frame), not sample-accurately; a 30 fps game hears ≈33 ms automation steps smoothed by ramps.
- The main thread takes up to 0.15 ms more per frame.
- The editor half (tree editor, curve widget, audition) is likely larger than the runtime. Estimate: M2a ≈ 4 person-weeks, M2b ≈ 5, plus the sample and listening pass.
- `AudioSource.clip` now accepts two asset kinds, which the inspector and docs must make clear.

## Deprecates

Nothing. `Audio.playOneShot` and clip-based `AudioSource` stay.

## Open questions

- **Sustain points and cues** (FMOD key-off, Wwise exit cues: a loop that plays a tail when released). Likely wanted for engines and weapons; deferred unless the owner wants it in M2.
- **Parameter-driven snapshots** (a snapshot's intensity from a global parameter) beyond bus volume and lowpass automation.
- **Effects per event** (an event's own filter or send) would need core work; deferred to M3 with reverb zones.
- **Whether particles' `evalCurve` moves onto `core/curve.ts`** in M2 (cheap: same data, linear keys) or when animation lands.

## References

- `docs/decisions/0157-audio-runs-on-an-engine-owned-rust-core-in-an-audioworklet.md` (Roadmap, M2); `docs/design/0157-audio-core/architecture.md` §10 and `api-and-models.md` §4.2 (`group`, SET_PARAMS, `rampFrames`).
- `src/plugins/audio/runtime/Audio.ts`, `AudioSource.ts`, `backend.ts` (the M1 API this extends).
- `src/engine/scene/particles.ts` (`CurveKey`, `myco.particles@1`).
- Wwise containers and RTPCs; FMOD Studio parameters and seek speed (concepts only; neither is a dependency).
