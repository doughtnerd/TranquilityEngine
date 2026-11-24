# 0352. Third-party audio effects are sandboxed WebAssembly modules that the core calls inside its chains

- **Status:** Accepted, amended by [0358](0358-plugin-glue-fuel-and-worklet-compile-rules-follow-the-b0-spike.md) (glue, fuel, budgets and worklet compile rules from the B0 spike)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0041, 0133, 0139, 0157, 0158, 0171, 0178, 0179 (extended: a seventh capability), 0342, 0343, 0344, 0345, 0346, 0348, 0349, 0351

## Context

The owner's follow-on scope (plan "Follow-on scope", 2026-11-22) asks for third-party DSP plugins, second in order
after per-platform encoding (0351), following Wwise and FMOD.

**What exists today.**
- **One effect catalogue** (0345): `src/engine/audio/effects/catalogue.ts` declares each type's parameters, levels
  (`sample`, `voice`, `instance`, `bus`; returns are buses), version and cost class; `EffectType` is a closed union, and
  a file's effect of an unknown type is dropped with one problem line. The Studio's `EffectCard` and `EffectChain` draw
  every card from the catalogue (`effectSpec`), so a declared type gets its UI for free.
- **The DSP** runs in the Rust core in an AudioWorklet (0157): `audio_dsp::fx::Effect` slots, planar stereo in place,
  at most 8 parameters (`PARAMS`; bus records carry 7), parameters glided over 20 ms, large state in the core's
  **`FxMem`** region (20 s of stereo, blocks of 16 KB), bus chains of 8 and instance submixes. The core is one wasm
  module over an imported `WebAssembly.Memory`, with plain `extern "C"` exports (ABI 4.7); a trap in `process()`
  silences the core and triggers a hard rebuild (3 a minute, then `failed`).
- **The metered gate**: `tools/audio-bench/meter.mjs` rewrites a wasm binary to count every instruction executed (a
  straight-line-segment counter, dependency-free, ≈ 380 lines); CI fails when the core's count rises more than 10%.
- **Plugins** (0133, 0139): a project folder `plugins/<name>/plugin.json` or an npm package; a runtime half (ships in
  games) and an editor half; checks before any code runs (`thirdParty.ts`); **no sandbox**, same trust as scripts.
- **The backend seam** (0179): 13 required members plus capability objects a backend has whole or not at all; the
  Babylon fallback runs no effects.

**How the reference tools do it.**
- **Wwise plugin SDK:** C++ effect plugins (`AK::IAkInPlaceEffectPlugin`) compiled into the game per platform,
  parameters declared in an XML file that drives the authoring UI and RTPCs; the plugin owns its memory through the
  provided allocator.
- **FMOD DSP plugin API:** a C ABI (`FMOD_DSP_DESCRIPTION`: create, release, reset, read/process, parameter
  descriptions of float, int, bool and data types), loaded as a dynamic library or registered statically; Studio
  builds its UI from the parameter descriptions.
- **Unity native audio plugins:** a C ABI (`UnityAudioEffectDefinition` with parameter definitions), DLLs per platform;
  generic UI from declared parameters, optional custom GUI.
- **Web Audio:** an `AudioWorkletProcessor` is JavaScript on the audio thread; a node graph hop between nodes adds no
  latency but our core is one node, so any effect outside it can only sit before or after the whole mix; WebAssembly in
  the worklet is instantiated synchronously from bytes; there is no preemption, so a runaway loop stalls the audio
  thread.

## Decision

We will let a plugin ship **DSP effects as WebAssembly modules with a small C ABI**, run in the AudioWorklet beside the
core, **each module in its own memory, with no imports**, instrumented at load with an **instruction budget** that
traps, and **called by the core from inside its effect chains** through an import the worklet shell binds. Effects are
declared in `plugin.json`, so they join the one catalogue (0345) at the levels they declare, and the Studio draws their
cards from the declaration.

### 1. Where a plugin effect runs (the choice)

| Option | Latency | Safety | Determinism | Placement | Verdict |
|---|---|---|---|---|---|
| **Separate wasm module, own memory, called through a core import** | none (inline in the chain) | wasm sandbox, no imports; fuel bounds CPU; traps caught before they reach the core | yes (wasm floats; relaxed SIMD and threads refused) | anywhere in a chain, every level, offline too | **chosen** |
| Plugin compiled into the core | none | none: a bug corrupts the core | yes | anywhere | every project would need Rust and its own core build; no distributable plugins |
| JS `AudioWorkletNode` outside the core | +0 per hop, but only before/after the whole core output | JS on the audio thread, GC pauses, no budget | no (JS `Math` differs across engines) | only master in/out; never bus, submix, voice or offline | can't be an insert |
| JS function in the worklet called by the core | none | GC on the audio thread, no budget, full worklet access | no | anywhere | the cost of JS without the sandbox |

**The call.** The core imports one module, `myco_ext`, with `process(handle, l, r, frames, p0, p1, flags) -> i32`
(pointers into the core's memory). The worklet shell's glue (`src/plugins/audio/runtime/worklet/effectGlue.ts`)
resolves `handle` to a plugin instance, copies `l` and `r` (2 × 128 floats) into the instance's I/O block in the
plugin's memory, sets the instance's fuel, calls the plugin's `myco_fx_process`, checks and copies the result back.
Measured cost to confirm in spike B0: two 512-byte copies, a JS-to-wasm call and a 256-sample finiteness scan, well
under 1 µs per call. The glue pre-creates every typed-array view at registration and allocates nothing per call.

### 2. The DSP ABI (1.0)

A plugin module exports exactly these (anything else exported is ignored; **any import refuses the module**):

```c
uint32_t myco_fx_abi(void);                                   // 0x0100 (major << 8 | minor)
uint32_t myco_fx_create(uint32_t kind, float sample_rate, uint32_t max_frames); // state handle, 0 = refused
void     myco_fx_destroy(uint32_t kind, uint32_t state);
void     myco_fx_reset(uint32_t kind, uint32_t state);         // clear tails and history, keep parameters
uint32_t myco_fx_io(uint32_t kind, uint32_t state);            // -> { float l[max_frames]; float r[max_frames];
                                                              //      float p0[16]; float p1[16]; }
int32_t  myco_fx_process(uint32_t kind, uint32_t state, uint32_t frames, uint32_t flags);
         // in place on io.l / io.r; p0 = parameters at the block's start, p1 at its end (ramp between them);
         // flags: 1 parameters changed, 2 input silent; returns 0 ok, 1 output silent (tail finished)
uint32_t myco_fx_tail_frames(uint32_t kind, uint32_t state);   // optional: frames of tail after input stops
/* and the module's own exported `memory` */
```

- `kind` indexes the effects one module provides (a module may hold several, e.g. a tremolo and an auto-pan).
- **Memory** is the plugin's own. `create` may allocate (it runs in the worklet's `onmessage`, never in `process`);
  `process` must not grow memory (the glue checks the buffer identity after the call and counts a growth as a fault).
  The manifest's `memoryMB` (default 4, at most 64) sets the module's maximum pages; it is reported in the profiler and
  counted against a project tripwire (`audio.json settings.plugins.memoryMB`, default 64).
- **Parameters**: up to 16 numbers. The core glides them as it glides built-ins (20 ms, frequencies in octaves) and
  passes block-start and block-end values, so a plugin can ramp per sample without its own smoother; parameters
  declared `smooth: false` (switches and choices) step at the block's start.
- **Stereo, planar, 128-frame blocks** (shorter blocks happen; `max_frames` is 128 in the core, larger offline).
- **Zero latency in v1.** A plugin can't report latency; look-ahead effects aren't compensated (open question).
- **The SDK** (`native/audio/fx-sdk/`): a Rust crate `myco-fx` with a trait and an `export_effects!` macro that
  writes these exports, and a C header `myco_fx.h` for C, C++ and Zig authors. Any language that emits
  wasm32 with these exports works (AssemblyScript included).

```rust
pub trait Effect: Sized {
    fn new(sample_rate: f32, max_frames: usize) -> Self;
    fn reset(&mut self);
    fn process(&mut self, l: &mut [f32], r: &mut [f32], p0: &[f32; 16], p1: &[f32; 16], flags: Flags) -> Status;
    fn tail_frames(&self) -> u32 { 0 }
}
myco_fx::export_effects!(Tremolo);
```

### 3. The manifest

`plugin.json` gains an `audio` section, read without running plugin code (like `assetKinds`), so the editor, the
Studio, the exporter and the player agree before anything loads:

```jsonc
{
  "name": "example.tremolo", "version": "1.0.0", "sdk": "^1.0.0", "title": "Tremolo",
  "audio": {
    "abi": 1,
    "modules": { "dsp": { "wasm": "dsp/tremolo.wasm", "memoryMB": 1 } },
    "effects": [{
      "type": "example.tremolo",            // must start with the plugin's name; unique across the project
      "module": "dsp", "kind": 0,
      "label": "Tremolo", "version": "1.0.0",
      "levels": ["sample", "instance", "bus"],
      "cost": "light",
      "budget": { "instructionsPerFrame": 300 },  // default 1,000, at most 20,000
      "maxInstances": 32,                    // default 16; pre-created at registration
      "params": [
        { "name": "rate",  "label": "Rate",  "min": 0.1, "max": 20, "step": 0.01, "unit": "Hz", "default": 5, "scale": "log" },
        { "name": "depth", "label": "Depth", "min": 0, "max": 100, "step": 1, "unit": "%", "default": 50, "scale": "linear" },
        { "name": "shape", "label": "Shape", "choices": ["Sine", "Triangle", "Square"], "default": 0, "smooth": false }
      ]
    }]
  }
}
```

- `runtime` and `editor` become optional when `audio` is present: a **DSP-only plugin runs no JavaScript at all**.
- `levels` is a subset of the catalogue's levels. `voice` costs an instance per voice and is allowed only when
  declared; when `maxInstances` is reached, further voices play without the effect and the profiler says why
  (`pluginInstances`).
- `params` use the catalogue's `EffectParamSpec` (0345), plus two optional keys the catalogue gains for everyone:
  `choices` (labels; the value is the index; the card shows a menu) and `smooth` (default true; false for `bool` and
  `choices`).
- Validation (`thirdParty.ts` and `effects/pluginEffects.ts`, before code runs): names, unique types, `kind` within
  the module, at most 16 params, defaults within ranges, budgets within limits, the wasm file present. A bad effect
  refuses the plugin, as other manifest errors do (0139).

### 4. The catalogue and data

- `EffectType` widens to built-in names plus namespaced plugin types (`` `${string}.${string}` ``).
  `catalogue.ts` stays pure; `effectSpec(type)` answers from the built-ins, then from specs registered by
  `registerPluginEffects(specs)` (the audio plugin calls it from the manifests it is given; the player from
  `game.json`).
- Effects in files keep the 0345 shape: `{ "id": "fx4", "type": "example.tremolo", "on": true, "params": { "rate": 6 } }`.
  **A plugin type whose plugin is off or missing is kept**, not dropped: it round-trips untouched, passes signal through
  at runtime with one warning, and the Studio shows a greyed card "Tremolo (plugin example.tremolo is off)". Unknown
  non-namespaced types are still dropped (0345's rule).
- Parameters are addressed by name everywhere (automation `fx:<id>:<param>`, 0344; snapshot overrides; 0346 curves);
  the TypeScript side maps a name to its index. A param a newer plugin version removed is ignored; a new one takes its
  default. Authors keep names stable across versions; the guide says so.

### 5. The core and the wire (ABI 5.0)

- **Records widen to 16 parameters.** Bus effect records (`BUS_CONFIG`, `BUS_SLOT`) and submix effect records carry
  `p[16]`; `audio_dsp::fx::PARAMS` becomes 16. A stride change, so the ABI major rises to **5.0**; wire vectors and
  goldens are regenerated once (the built-ins' output must stay bit-identical; a test proves it).
- **Plugin kinds.** Effect kinds `0x100 + e` name registered plugin effect `e` (0..255). The host assigns `e` when it
  registers an effect and, after a hard rebuild, replays the registrations before
  0178's replay (clips, then configurations). A plugin kind's `Effect` slot keeps its parameters and glide as built-ins do, plus the instance handle; it
  needs no `FxMem` (its state is in its own module).
- **Acquiring an instance** happens where effects are configured (`onmessage`): the core calls a second import,
  `myco_ext.acquire(e) -> handle` (0 = pool empty; the slot passes through and counts `pluginInstances`), and
  `release(handle)` when the slot is freed or swept (`fxmem::rebuild`'s sweep releases too).
- **New core module** `native/audio/crates/audio-core/src/ext.rs`: the import declarations (`#[link(wasm_import_module
  = "myco_ext")]`), a native stub for `cargo test` (a registry of Rust closures), and the chain hook. The core's
  instantiation always supplies `myco_ext` (pass-through stubs when no plugin is registered), so projects without
  plugins pay one predictable branch per slot.
- **Why not `FxMem`?** Giving a plugin the core's memory would let a bug corrupt the core, and copying its state in and
  out per block costs more than its I/O. Plugin state lives in the plugin's memory, budgeted by `memoryMB`.

### 6. Safety and failure isolation

- **Validation at load** (main thread, `src/plugins/audio/runtime/effectPlugins/validate.ts`): the module must parse
  with the meter pass's decoder (which throws on instructions it doesn't know, so relaxed SIMD, threads, atomics and
  shared memory are refused), import nothing, export the ABI with matching signatures, and report a supported ABI
  (major 1; minor ≤ the engine's).
- **Instruction budget (fuel).** The meter pass (`tools/audio-bench/meter.mjs`) moves to a library module,
  `src/engine/wasm/meter.js` (+ `.d.ts`), used by both `build.mjs` and the runtime, and gains a `fuel` mode: each
  straight-line segment subtracts its count from an exported global and executes `unreachable` when it goes negative.
  Before each call the glue sets fuel to `instructionsPerFrame × frames`. The same counts give the profiler each
  plugin's exact instructions per quantum. Instrumented code runs slower (expected 20–50% on tight loops; B0 measures
  it); if the loss passes 50%, the pass checks only at loop headers and function entries, as wasmtime's fuel and
  Parity's gas metering allow.
- **Faults**, detected by the glue: a trap (including fuel exhaustion), a non-finite sample, a sample beyond ±64
  (+36 dBFS), or memory growth in `process`. On a fault the block's output is the **dry input** (pass-through), the
  instance is reset at the next `onmessage` (destroyed and re-created; after a trap the whole module is re-instantiated,
  since its memory may be corrupt, and its other instances pass through until then). Three faults within one second
  disable the instance until its configuration changes or the Studio's **Reset plugin** is pressed.
- **Reporting.** The glue posts rate-limited shell events (`pluginFault { plugin, type, instance, reason }`) on the
  worklet's port, never STATUS bytes. Main turns them into one warning per plugin and reason, `Audio.debug().plugins`
  (per effect: instances, faults by reason, instructions per quantum, memory), and capture events (0348).
- **The core never sees a plugin trap**: the glue catches it before it unwinds into the core's frames, so the hard
  rebuild (0157) stays for core faults only.
- **Trust.** Plugins remain trusted code (0139: no sandbox for the JavaScript halves, and the guide says so). The DSP
  module itself is sandboxed: no imports means no network, files, clock or DOM, and the budget and fault rules bound
  what it can do to the mix. A DSP-only plugin therefore carries no code with host access. Turning a plugin off in
  Project Settings > Plugins removes its effects everywhere (they pass through, data kept).
- **Determinism.** The same inputs give the same bits on every engine (wasm floats; NaN payloads aside, which the fault
  rule removes), so take replays (0348), golden tests and the offline render cache hold for plugin effects.

### 7. Levels, offline render and the backend seam

- **Bus and return inserts, instance submixes, voice chains**: the core's chains call plugin slots in order with the
  built-ins.
- **Sample (offline)**: the offline renderer (0342/0345, W9-B) imports the same `myco_ext` functions; its worker loads
  the same instrumented modules through the same glue, with `max_frames` 4,096. A runaway plugin there is caught by
  fuel too; the worker also has a 10 s watchdog. The render cache key (0342) adds each plugin's name, version and wasm
  hash, so a plugin update re-renders.
- **Capability** (0179): `effectPlugins: AudioEffectPlugins` — `register(module: EffectPluginModule):
  Promise<EffectPluginLoad>` (bytes already validated and instrumented, specs, `e` indices), `unregister(name)`,
  `reset(type)`, `health(): readonly EffectPluginHealth[]`. Core: yes. Babylon: none (plugin effects pass silently, one
  warning per type, as built-ins do there). Pending: none; the main-side host (`effectPlugins/host.ts`) keeps the
  registry and registers when the core is ready and after every rebuild. Fake: yes, recording registrations.

### 8. Loading, editor, exports

- **Editor and Studio**: when the plugin set is planned (0275), the audio plugin reads each enabled plugin's `audio`
  section, registers the specs in the catalogue, fetches each module's bytes, validates and instruments them (once per
  content hash, cached in memory), and calls `effectPlugins.register`. Saving a module's wasm or `plugin.json` reloads:
  the worklet swaps the module, instances are re-created with their current parameters (a short gap, like a script
  reload).
- **Exports** (0041, 0296): the build plan copies each enabled plugin's module files (`project/plugins/...` for project
  plugins; `code/deps/plugins/<name>/...` for npm ones) and writes `game.json`'s `audioEffects: [{ plugin, version,
  module, url, hash, effects: [...specs] }]`. The player registers them before `Engine.create`, so the first scene's
  chains find them. A disabled plugin isn't shipped; its effects pass through. The dedicated server never loads them.
- **Where effect modules can't load** (no AudioWorklet, the Babylon fallback): as for built-in effects.

### 9. The Studio

- **EffectChain's Add effect** menu lists plugin effects allowed at the level under a **Plugins** group, by plugin
  title.
- **EffectCard** draws plugin cards like built-ins (from the spec) with a plugin chip (title and version), a menu for
  `choices` params, and a status line when the instance isn't healthy (`faulted: over budget`, `pass-through: plugin
  off`, `no free instance`) with **Reset plugin**.
- **Profiler**: the effects-cost track (0345) gets a row per plugin effect from the exact instruction counts, plus
  fault marks.
- **Project Settings > Plugins** shows each plugin's effects, modules, memory and budget.

### 10. The reference plugin and docs

- `samples/fx-tremolo/`: a small sample project with `plugins/tremolo/` (`plugin.json`, `dsp/` Rust source on the
  SDK, the committed `dsp/tremolo.wasm`), a playlist using the tremolo on an instance submix and on a bus, built by
  `npm run build:fx-examples` (needs only Rust and `wasm32-unknown-unknown`).
- `docs/wiki/guide/audio-effect-plugins.md`: writing an effect in Rust (the trait) and C (the header), the ABI, the
  manifest, budgets and faults, testing an effect natively (`cargo test` over the trait) and in the Studio, versioning
  and stable parameter names, shipping in a project or an npm package. `docs/wiki/guide/plugins.md` gains a short "Audio
  effects" section linking it.

## Alternatives considered

- **Compile plugins into the core** (Wwise's static linking) — needs Rust and a per-project core build in every export
  and editor, and a plugin bug becomes a core crash; kept for Myco's own effects only.
- **A JS AudioWorkletNode chain outside the core** — can only touch the final mix, not bus, return, submix, voice or
  offline chains; JS on the audio thread brings GC pauses and engine-dependent maths.
- **Plugins as JS functions the core calls** — same placement as the chosen design, but no budget, no sandbox and
  non-deterministic maths.
- **Share the core's memory with plugins (multi-memory or an imported core memory)** — a plugin could corrupt the
  core; multi-memory isn't in every target engine.
- **Wall-clock budgets** — the worklet has only `Date.now()` (milliseconds), and wall time isn't deterministic; fuel is
  exact and doubles as the profiler's measure.
- **The WebAssembly component model / WASI** — not in browsers.
- **Custom plugin UIs in v1** (Wwise and FMOD allow them) — generated cards cover the common case; an editor-half
  contribution point for a custom card can follow (open question).

## Consequences

**Positive**
- Third-party effects run inline at every level with no added latency, the same in the editor, the Studio, game
  builds and offline renders.
- A misbehaving plugin can't crash or stall the audio core: it passes through and is reported.
- Plugin effects get the catalogue's automation, snapshots, curves, profiler rows and generated UI with no extra code.
- DSP-only plugins carry no host-access code.

**Negative / costs**
- A wire major bump (5.0) and regenerated vectors and goldens; every effect record is twice as wide.
- Fuel instrumentation slows plugin code (to be measured); the per-call glue costs a little per plugin slot.
- No latency compensation and no custom UIs in v1.
- A second wasm instance per plugin module in the worklet, with its own memory (budgeted by `memoryMB`).
- Moving the meter pass into `src/engine/wasm/` makes it engine code with its own tests, not only a CI tool.

## Deprecates

- The rule that an unknown effect type is dropped, for namespaced (plugin) types: they are kept and pass through.
- `tools/audio-bench/meter.mjs` as the pass's home (it re-exports `src/engine/wasm/meter.js`).

## Open questions

- Latency reporting and compensation for look-ahead plugins.
- A custom card view contributed by a plugin's editor half.
- Sidechain inputs for plugin effects (a key bus, as the built-in sidechain compressor has).
- Non-stereo (ambisonic bed) processing.

## References

- Audiokinetic Wwise SDK: effect plugins, plugin XML; FMOD Core API: `FMOD_DSP_DESCRIPTION`, DSP plugin
  registration; Unity: Native Audio Plugin SDK; W3C Web Audio API: AudioWorklet; wasmtime fuel; Parity
  `wasm-instrument` gas metering.
- `src/engine/audio/effects/`, `src/studio/components/EffectCard.tsx`, `effectChainModel.ts`;
  `native/audio/crates/audio-dsp/src/fx/mod.rs`, `audio-core/src/fx.rs`, `fxmem.rs`, `audio-wasm/src/lib.rs`;
  `src/plugins/audio/runtime/worklet/coreDriver.ts`, `processor.ts`; `src/plugins/thirdParty.ts`;
  `tools/audio-bench/meter.mjs`; `docs/wiki/guide/plugins.md`.

## Build plan

**Spike first (B0, ≤ 3 days, results in `docs/design/0352-audio-effect-plugins/spikes.md`):** a tremolo and a
biquad-heavy test effect, measured in V8, JavaScriptCore and SpiderMonkey: the glue's per-call cost, fuel overhead
(segment checks against loop-header checks), synchronous module compile inside the worklet scope, and a trap caught in
the glue leaving the core running.

| # | Milestone | Contents | Files (owner) |
|---|---|---|---|
| B1 | SDK, meter, validator | `myco-fx` crate and `myco_fx.h`; meter pass moved to `src/engine/wasm/meter.js` with the `fuel` mode and unit tests (counts unchanged in `count` mode; fuel traps at the budget); validator; the tremolo sample and `npm run build:fx-examples` | `native/audio/fx-sdk/**`, `src/engine/wasm/**`, `tools/audio-bench/meter.mjs`, `native/audio/build.mjs` (one line), `samples/fx-tremolo/**`, `package.json` script, `src/plugins/audio/runtime/effectPlugins/validate.ts` |
| B2 | Manifest and catalogue | `audio` manifest section, parse and checks; optional `runtime`/`editor`; `EffectType` widened; `registerPluginEffects`; `choices` and `smooth` on `EffectParamSpec`; keep-namespaced-unknowns parse; tests | `src/plugins/thirdParty.ts`, `src/plugins/manifest.ts`, `src/engine/audio/effects/**` |
| B3 | Core and wire | ABI 5.0 (16 params, plugin kinds, `acquire`/`release`/`process` imports), `ext.rs` with native stub, chain hooks in bus, submix and voice chains, sweep releases; goldens proving built-ins bit-identical; regenerated vectors | `native/audio/crates/audio-wire/**` (wire single writer), `audio-core/src/{ext,fx,submix,chain,fxmem}.rs`, `audio-dsp/src/fx/mod.rs`, `audio-wasm/src/lib.rs`, `src/plugins/audio/runtime/wire.generated.ts` |
| B4 | Worklet glue and host | `effectGlue.ts` (dispatch, copies, fuel, fault checks, events), `coreDriver.ts` import object, `effectPlugins/host.ts` (fetch, validate, instrument, register, replay after rebuild, reload on save), the `effectPlugins` capability on core, Babylon (none) and the fake; `Audio.debug().plugins`; capture events; tests with a trapping, NaN-producing, looping and growing test module | `src/plugins/audio/runtime/worklet/**`, `src/plugins/audio/runtime/effectPlugins/**`, `backend.ts`, `core/coreBackend.ts`, `testing.ts`, `debugTypes.ts`, `capture/**` |
| B5 | Exports and offline | plan copies module files and writes `audioEffects`; player registers them; offline renderer imports `myco_ext` and loads modules; render cache key; tests in `buildWriter.test.ts` and the offline render suite | `src/export/webBuild.ts`, `src/export/format.ts`, `src/player/main.ts`, the offline renderer's worker (W9-B's files) |
| B6 | Studio | Plugins group in Add effect, plugin chip, choices menu, status and Reset plugin on `EffectCard`, Profiler rows, Plugins settings details; stories with `play` tests | `src/studio/components/EffectCard.tsx`, `EffectChain.tsx`, `effectChainModel.ts`, `src/studio/screens/profiler/**`, `src/editor/ui/` Plugins settings view |
| B7 | Docs and e2e | `docs/wiki/guide/audio-effect-plugins.md`, `plugins.md` section; `@slow` spec: the tremolo sample exported for web plays with the tremolo's modulation visible in a capture's bus meter; a Studio spec adding the tremolo to a bus | `docs/wiki/guide/**`, `tests/e2e/audio-plugins.spec.ts` |

B1 and B2 run in parallel; B3 after 0351's wire change in the same wave (the wire and `audio-wasm/src/lib.rs` have one
writer per wave); B4 needs B1 and B3; B5 and B6 need B2 and B4.
