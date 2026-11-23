# 0362. The UI fidelity pass adds playback pause, clip envelopes, reverse, second-input curves, occlusion curves and Studio format fields

- **Status:** Accepted
- **Date:** 2026-11-23
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0171 decision 4, 0346's "And by: not built in v1", 0347's occlusion controls)
- **Related:** 0097, 0162, 0171, 0341, 0342, 0343, 0344, 0345, 0346, 0347, 0348, 0349

## Context

The owner compared the Audio Studio with their prototype canvas and written spec (`docs/design/audio-studio/owner-spec.md`)
and found it far from both. A UI pass (decision log D71, `docs/design/audio-studio/ui-pass/`) rebuilt the screens to the
prototype. Several controls the prototype and spec draw need engine or format support the records don't give: a pause
for auditions, the Amp envelope effect on clips (0345 lists it; nothing runs it), reverse clips (drawn, played
forwards), sequence marker colour and note, curves shaped by a second parameter (0346 left "And by" out of v1),
occlusion volume and low-pass curves (0347 has only per-material losses), and Studio bookkeeping such as empty snapshot
folders. The owner chose, on 2026-11-23, to build all of them before the pass merges.

## Decision

All additions are optional and backward compatible: files without the new fields read as before, and writers emit a
field only when it differs from its default.

1. **Pause.** The handle `Audio.play` returns gains `pause()` and `resume()` (and a read-only `paused`). A paused
   playback holds its voices, timers, sequence clock and pending picks; `resume()` continues from the same position.
   Pausing a playback twice, or resuming one that isn't paused, does nothing. Stopping a paused playback stops it.
   The Studio's audition Pause uses it.
2. **Amp envelope on clips.** The catalogue's `envelope` effect runs on clip chains (0345's clip level): attack, hold,
   decay, sustain, release over the clip instance's own time, release on the clip's key-off. The format stops flagging
   it as unrunnable at clip level.
3. **Reverse.** A clip with `reverse: true` plays its span backwards (loops run backwards inside the span). Decoded
   PCM is read backwards by the voice; streamed sources are decoded whole for reversed clips.
4. **Sequence markers** gain optional `colour` (a theme token name or `#rrggbb`) and `note` (text). Sample sidecars
   gain the same two fields on reserved ranges (Trim, Pickup, Tail), and folder colours live in the project's Studio
   settings, not in audio files.
5. **Second-input curves ("And by").** A curve lane may carry `by: { input, mode, ... }` where `mode` is `morph`
   (a low and a high curve blended by the second input), `scale` (the result multiplied by a curve of the second
   input), `rate` (time lanes only: the second input scales the clock) or `labels` (one curve per label of a labelled
   input, with a default). Stored on playlist voice curves, sequence clip/track automation lanes, and Mixer bus and
   bus-effect automation lanes. The runtime evaluates `by` wherever it evaluates the lane today.
6. **Occlusion curves.** A test scene's and the project's spatial settings gain optional occlusion curves mapping
   how blocked a path is (0..1, from the rays and the materials' losses) to a volume and a low-pass cutoff. Without
   them the 0347 per-material losses apply as today. The Curves window edits them (Distance mode's sibling,
   "Occlusion").
7. **Studio fields in `audio.json`.** `snapshotFolders` (empty snapshot folders, kept), `Bus.colour`, parameter
   `type: "bool" | "text"` (labelled parameters underneath, so the core is unchanged), and trigger condition ops
   `contains` and `starts` (case-insensitive, on text parameters). Test-scene emitters gain an optional `output` bus.
8. **Loudness targets.** Default targets are console −24, PC/web −18, mobile −16 LUFS, each ±2 LU with a −1 dBTP
   ceiling (amends 0171 decision 4); projects with their own list keep it.

## Alternatives considered

- **Leave the controls drawn but inert** — the owner's complaint was exactly controls that look built and don't work.
- **Pause by silencing (the pass's stop-gap)** — time keeps running, so a resumed sequence jumps; not a pause.
- **"And by" as separate lanes the author combines by hand** — the prototype and spec make it one lane's property;
  separate lanes don't express per-label curves.
- **Occlusion curves instead of the material table** — the materials still decide how much each obstacle blocks; the
  curves map the total to sound, so both stay.

## Consequences

**Positive**
- Every control the prototype draws in these areas does what it shows.
- Formats stay readable by older code paths that ignore unknown optional fields.

**Negative / costs**
- Public API grows (`pause`, `resume`, `paused` on the playback handle).
- Reversed streamed clips cost a whole decode.
- More format surface to lint and migrate later.

## Deprecates

The Playlists screen's silence-only Pause stop-gap (replaced by item 1).

## Open questions

- A live game link for the Game session pill (decision log D71; take replay stands in until then).
- Per-voice version and distance in captures (needs a capture-format change; not part of this record).

## References

- `docs/design/audio-studio/owner-spec.md` §2.7, §4.2.9, §4.4.7, §5.1; the prototype canvas "Audio Design Studio –
  Prototype UI v2".
- `docs/design/audio-studio/ui-pass/decisions.md`, `shared-requests.md`; decision log D71.
