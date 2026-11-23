# 0346. One curve model with Bézier keys everywhere, time as a parameter the core advances, and one curve editor

- **Status:** Accepted, amended by 0350 (beat-quantised lanes run as stamped gain ramps, not core bindings)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0158 (amended: curves may be keyed on time), 0060, 0157, 0306, 0342–0345, 0347, 0349

## Context

The engine has one curve type, `src/engine/core/curve.ts` (0158 §3), shared by audio automation and particles: keys
`[x, y]` or `[x, y, interp]`, interps `linear`, `step`, `smooth`, `easeIn`, `easeOut`, at most 32 keys, with a Rust
evaluator in `audio-core` held to it by a parity test. Its header says extensions may add key forms such as tangents.
In audio, X is always a parameter value; nothing is keyed on time. The editor's `CurveEditor.tsx` edits it.

The prototype uses curves on every screen through one **Curves** window (`CurveDialog.dc.html`): kinds Time (clip,
voice or sequence time), Parameter (with a histogram of the values the game sends) and Distance (0–60 m with Min/Max
handles that stretch every curve); lanes per property with a per-lane driver; key shapes linear, S-curve, ease in, ease
out, step and Bézier with mirrored or free handles; end keys that can't be deleted; presets and user presets; a dope
sheet for time curves. Its "And by" second input (morph, scale, rate, per-label tables) is switched off by every live
screen. Its result returns y normalised to 0..1, so each screen converts back, and the Playlists screen can't evaluate
the Bézier keys the dialog writes.

## Decision

We will extend the engine curve, let curves be keyed on time, and build one curve editor that every screen and the
scene editor use.

**The curve gains a Bézier key form** (`curve.ts`, and the Rust evaluator with its parity test):
`[x, y, "bezier", { "in": [dx, dy], "out": [dx, dy], "free": false }]`. The segment from a key uses the key's out
handle and the next key's in handle (a flat third-of-segment handle when the next key isn't Bézier); control x is
clamped into the segment so the curve stays a function of x, and the evaluator solves t by bisection (28 steps).
Mirrored handles are an editor rule (`free: false`), not an evaluation rule. The prototype's shape names map onto the
existing ones (`lin` → `linear`, `s`/`ease` → `smooth`, `in` → `easeIn`, `out` → `easeOut`, `hold` → `step`, `bez` →
`bezier`). The key limit rises to 64 (declared once in the parse). Values hold before the first key and after the
last, as today. Particles get Bézier keys for free.

**Units in, units out.** Keys are stored in the target's units (dB, semitones, Hz, %). A target whose catalogue
parameter has `scale: "log"` (0345) is interpolated in log space by the evaluator's caller; the curve format doesn't
change.

**Time is a parameter.** Each playing instance has three built-in time parameters the core advances per quantum:
`voiceTime` (since the voice started), `clipTime` (since the clip's start) and `sequenceTime` (the sequence playhead).
The main thread re-anchors them with stamped jumps when the sequence's state machine wraps a loop, parks at a hold
point or leaves (0343), as the music planner stamps its starts today. Automation keyed on time is then the same as
automation keyed on a parameter: a curve on a parameter slot, evaluated in the core per quantum. This is a core and
wire change (new parameter kinds, stamped re-anchor); the Babylon fallback evaluates time curves per frame on the main
thread, as it does parameter curves (`TsAutomation`).

**One curve editor** (`src/editor/ui/curves/`, exported from the SDK; replaces `CurveEditor.tsx` and `curveEdit.ts`):
a dialog with the prototype's layout and behaviour. Its props are typed: `kind: "time" | "parameter" | "distance"`,
`lanes: [{ id, name, unit, min, max, step, scale, bool, color, base, curve, input, bypass }]`, `inputs` (the
parameters a lane may be driven by), `length` (time) or `minDistance`/`maxDistance` (distance), optional backdrops
(`waveform(t)`, `histogram` of a parameter's values, `listenerDensity`) and a "now" marker. It returns curves **in
units**, with each lane's input and bypass. Editing inside the dialog is a draft with its own panel history
(`providePanelHistory`, 0145), so Ctrl+Z works inside it; Apply commits one labelled undo step to the owning document,
Cancel drops the draft. Presets: Flat, Linear, Ease in, Ease out, S-curve, and Inverse square for distance volume;
user presets are a per-user preference. The parameter histogram comes from takes (0348) when one is open.

**Not built in v1:** the "And by" second input (morph, scale, rate, per-label tables). No live screen of the prototype
uses it; a later record can add it.

## Alternatives considered

- **A second curve format for audio time automation** — two evaluators, two editors and the prototype's own drift;
  the engine curve was designed to be extended.
- **Time automation as stamped ramps from the main thread only** — works for coarse curves (music's quantised
  automation does this) but loses per-quantum accuracy and costs a stream of messages for long curves.
- **Keep normalised y in the editor's result** — every caller converts and gets it wrong (the prototype did).

## Consequences

**Positive**
- One curve type and one evaluator for audio (parameter and time), particles and anything later.
- One curve editor for the Studio and the scene editor.

**Negative / costs**
- Rust evaluator and parity tests for Bézier; the curve table grows (64 keys).
- New core parameter kinds and re-anchor messages.

## Deprecates

- `src/editor/ui/CurveEditor.tsx` and `curveEdit.ts`: replaced by the shared curve editor (its SDK exports stay as
  aliases for one release).

## Open questions

- None.

## References

- Prototype `CurveDialog.dc.html`; its uses in Samples, Playlists, Sequence, Mixer and Spatial.
- `src/engine/core/curve.ts`, `native/audio/crates/audio-core` (curve evaluator), `src/plugins/audio/runtime/events/automation.ts`.
