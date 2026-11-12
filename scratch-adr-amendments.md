# Amendment text for ADR 0158 and ADR 0097 (task D5)

For the coordinator to paste. Neither record is rewritten: each gets a dated section appended before its `## References`, and its `Status` line already names 0166 (add 0167 to it, shown below). No other file under `docs/decisions/` needs a change for this. Where 0166 and 0167 disagree, 0167 wins; this text follows 0167 and what merged.

---

## For `docs/decisions/0158-audio-events-and-parameters.md`

**Status line**, replace the parenthesis with:

`Accepted, amended by 0166 and 0167 (`myco.audioevent@1` gains music nodes: segment, playlist, musicSwitch, transition rules, stingers; its handle gains `music`, `onMusic` and `trigger`)`

**Section to append** (before `## References`):

```markdown
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
- **Size gates.** This record's rule that wasm size gates are tripwires still holds; the mixer module grew with music and its gate was moved with the reason in the build log (`docs/design/0166-audio-music/build-log.md`).

The reference for the format and the API is `docs/guide/interactive-music-api.md`.
```

---

## For `docs/decisions/0097-audio-mixer-buses.md`

**Status line**, replace the parenthesis about 0166 with:

`and 0166 and 0167 (presets gain the music ring pool and the rhythm-mode setting)`

**Section to append** (before `## References`):

```markdown
## Amendment (0166, 0167): the presets gain music settings

The bus graph, snapshots and ducking are unchanged: music plays on the `Music` bus (or the bus a stem names) like any sound, and ducks, fades and snapshots with it. What changes is the voice preset.

- **`audio.music.rings`.** Each voice preset carries a music ring pool, the streamed stems a music instance can hold open at once, including those of the next segment while it is prepared: **low 8, default 12, high 16** (the project value is a whole number 0 to 16, written in `project.json` and edited in Project Settings > Audio > Playback > Music; the preset comparison includes it, and a value that differs from the preset's makes the preset read `custom`). The rings are the last entries of the core's stream table, so general streams and music streams cannot take each other's slots. Each ring is a buffer of about 300 KB, so a preset's stream memory grows by `rings x 300 KB` (low 3.69 MB, default 6.14 MB, high 9.83 MB in all with the general streams).
- **Music voices count inside the preset's mixed-voice cap** (0166 owner decision 3). A stem is a voice and is selected by priority like any other; no voice is added to a preset for music, and the per-preset worst-case allowances were re-set in 0167 §1 item 3.
- **`audio.rhythmMode`** (default `false`), also in Project Settings > Audio > Playback > Music. While it is true the audio context is built with `latencyHint: 0`. It is a project-wide mixer setting, not a per-bus one; a change at run time rebuilds the context, and the music re-enters on the next bar (0167 §2). It refuses nothing.
- **Ducking and the music bus.** Beat callbacks are timed on the heard clock, so a bus fade, snapshot or duck on `Music` never moves a beat. The Flappy sample dips the `Music` bus to 35% over 0.4 s on game over with `Audio.bus("Music").fadeTo`, which is the intended use of this record's API on music.
```

---

## Notes for the coordinator

- Wording to confirm against your merge: "the mixer module grew with music" (build log C1: mixer 266,732 to 269,544 B, under the 300 KB warning); change it if a later task moved the gate.
- `docs/README.md`'s index row for 0158 and 0097 should read "amended by 0166 and 0167" if it names 0166 only; this task does not edit it.
- `docs/architecture/implementation-status.md` is yours; the D5 guide changes make no claim it does not already hold.
