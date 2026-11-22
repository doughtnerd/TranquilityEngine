# Interactive music

Music is authored as [playlists](playlists.md) (ADR 0329): samples that carry a tempo, loops and markers (the Audio Studio's Samples screen), **Sequences** that lay them out on a timeline with a tempo, **Switch** rules that wait for a beat, a bar or an Exit marker, and **stingers**. The music events of ADR 0166 (`segment`, `playlist`, `musicSwitch` in `*.audioevent.json`) migrate to these; see [the end of this page](#from-music-events).

## The musical clock

A playing instance has a musical clock when its **playing entry** has a tempo: a Sequence with `tempo: { bpm, meter }` (on its playhead), or a Clip whose sample has a tempo in its sidecar (on its voice, loops included). Containers pass the question down to the entry that plays. Everything timed to a beat, a bar or an Exit marker asks this clock; with no tempo, `beat` and `bar` act at once (the Studio lints it) and `exit` still waits for an Exit marker or a loop's end.

```ts
const h = Audio.play("audio/music/world.playlist.json", { parameters: { State: "explore" } });
h.music?.bar;            // where the music is as it is heard: bar, beat, beatFraction (0..1)
h.music?.tempo;          // bpm; beatsPerBar, beatUnit
h.music?.segment;        // the playlist (a sequence) or the sample (a clip) whose clock it is
h.music?.nextGrid("bar");                       // { time, bar, beat, segment }: the next bar line, heard time
h.music?.nextGrid({ every: "bar", n: 4 });      // every fourth bar
h.music?.positionAt(event.timeStamp);           // an input's place on the beat: offset, judged (offset - calibration)
h.music?.seek("9:1:0");                         // a Sequence jumps there (5 ms fades); { ok, time } or { ok: false, reason }
h.onMusic("beat", (e) => {});                   // beats and bars of this instance; returns an unsubscribe function
```

`h.music` is `undefined` while the playing entry has no tempo. A behaviour on the node of the `AudioSource` that plays the playlist hears `onMusicBeat(e)` and `onMusicBar(e)`; beats arrive in late update on the first frame whose heard clock has passed them, and a gap of more than a beat coalesces into one call with `e.missed`. `e.handle` is the handle `Audio.play` returned. Cues are markers here (below): `onMusic("cue")` and `onMusicCue` hear nothing for a playlist.

The `Audio` clock members serve rhythm games: `Audio.time` (the heard clock), `Audio.horizon` (the earliest time a stamped start is exact), `Audio.timeAt(performanceTime)`, `Audio.calibration` (seconds, per output device; `Calibration.fromTaps(offsets)` computes one) and `Audio.latency`.

## Switch rules

A Switch on a labelled parameter plays the entry its `map` names for the current label. When the label changes, the best-matching rule decides how:

```jsonc
"switch": {
  "parameter": "State",
  "map": { "explore": 0, "combat": 1, "calm": 2 },
  "onChange": { "when": "bar", "how": "crossfade", "length": { "beats": 1 } },   // no rule matched
  "rules": [
    { "from": "explore", "to": "combat", "when": "bar", "how": "cut", "length": { "beats": 0 } },
    { "from": "calm", "to": "combat", "when": "bar", "how": "transition", "length": { "beats": 1 },
      "transition": { "playlist": "audio/music/riser.playlist.json" } },
    { "from": "*", "to": "calm", "when": "exit", "how": "crossfade", "length": { "ms": 2000 } }
  ]
}
```

- **Matching:** each side scores 2 for its exact label and 0 for `"*"`; the highest total wins and the first listed breaks a tie. No match uses `onChange`.
- **When:** `now`, `beat`, `bar` (the playing entry's clock), `exit` (its next Exit marker, else its loop's end, else its end) or `nextTrigger` (the new label waits for the next play).
- **How:** `crossfade` over `length` (equal power), `cut`, or `transition`: the old entry leaves at the boundary, the transition playlist plays, and the new entry enters at the transition's Exit marker (or its end), each hand-over crossfaded over `length`.

## Sequences

A Sequence has a `length`, an optional `tempo`, **tracks** (audio tracks hold sample clips, playlist tracks hold playlist clips, each with volume, pan, output bus, mute, solo, effects and automation), **loops** and **markers**.

- **Sync clips** (`sync: true`, the default for music samples in the Studio) are locked to the playhead: when a sequence loop wraps, their audio starts again from the loop's start, sample-exact. Stems are sync clips on parallel tracks; where sync loops overlap, the higher track drives the playhead and the others follow.
- **Async clips** run their own voice clock and loop only by their sample's own loops; they aren't cut when the playhead leaves them.
- **Loops** wrap while active (`always`, `held` until `release()`, or bound to a parameter: `"binding": { "parameter": "Loop", "op": "<", "value": 0.5 }`). An inactive loop is left by its `exit` (`finish` plays the pass out, `jump`, `crossfade`); `reentry: "reenter"` jumps back in when it turns active again. A loop under 1 ms long is a **hold point**: the playhead parks there while it is active.
- **Markers:** `cue` markers report to the game, `exit` markers are where Switch rules timed `exit` and sync clips may leave.
- **Hot reload:** saving a playing sequence swaps it at the next bar (at once without a tempo), continuing at the same time when the tempo is unchanged.

`untilStopped` in `playback` keeps a music instance alive after the playhead ends until the game stops it.

## Stingers

```jsonc
"stingers": [{ "trigger": "hit", "playlist": { "playlist": "audio/music/hit.playlist.json" }, "at": "beat", "ifLate": "nextGrid", "dontRepeat": 0.25 }]
```

`h.trigger("hit")` plays the stinger over the music without touching its clock, at `now`, the next `beat` or `bar`, the next `exit`, or `hit` (the stinger sample's Hit marker lands on the next bar). `ifLate` says what happens when the point is too close to stamp: `nextGrid` (the point after), `playNow` or `skip`. `dontRepeat` drops a trigger within that many seconds of the last one; at most four stingers sound at once per instance (a fifth steals the oldest). `trigger` returns whether the stinger was accepted.

## Markers

`h.onMarker(type, fn)` hears the Cue, Exit and Hit markers of the playing samples and a sequence's `cue` and `exit` markers as they pass (`{ type, name, sample, time }`, `time` exact on the heard clock), delivered on the first frame after; `onAudioMarker(e)` on the `AudioSource`'s node hears every type.

## From music events

The migration (`npm run audio:migrate`, or on opening the project) maps each music event once, and lists what it couldn't keep:

| Music event (ADR 0166) | Playlist |
| --- | --- |
| `segment` with its tempo | Sequence with the tempo; each stem a sync audio track; alternatives a Queue on a playlist track |
| cues; `entry`/`exit` | sequence markers; Exit markers |
| regions with `while` | loops bound to the parameter; a whole-segment loop an `always` loop |
| music `playlist` | continuous round-robin Queue (`rounds` are not kept: it plays until stopped) |
| `musicSwitch` and its transition rules | Switch; exit `beat`/`bar`/`exitCue` → `when`, fades → `length`, bridge → `transition` |
| stingers | stingers |

Not kept (each noted per file): fade curves (crossfades are the runtime's equal power), a region's `tailBeats`, quantised automation (curves follow the parameter continuously), finite region counts, and the bridge's own fades.
