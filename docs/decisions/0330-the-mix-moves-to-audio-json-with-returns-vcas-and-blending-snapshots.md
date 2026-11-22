# 0330. The mix moves to `audio.json`, with returns, VCAs and blending snapshots

- **Status:** Proposed
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0097, 0171, 0172, 0173: where the audio settings live and what the mix holds)
- **Related:** 0097, 0162, 0171, 0172, 0173, 0175, 0262, 0292, 0304, 0306, 0327, 0329, 0331, 0332

## Context

The mix lives in the `audio` section of `project.json` (`src/engine/audio/settings.ts`): up to 32 buses with a linear
`volume` 0..2, `mute`, an effect chain of four types (low-pass, high-pass, compressor, and a send into one shared
reverb), `maxVoices`, beds and loudness metering; snapshots (a volume multiplier and a low-pass per bus, one active at
a time); ducking rules (presence or level); global parameters; bus automation (volume or low-pass by a global
parameter); loudness targets; and the engine's budgets (voices, clip memory, beds, occlusion, zones, Doppler, music
rings, backend). The editor's Project Settings > Audio and the Mixer panel edit it through one settings draft and
history (0173); live edits during Play go through `MixOp`s and `Mixer.apply` (0171/0172).

The prototype's Mixer adds: faders in dB (−60..+6, 0.5 dB steps); **returns** with their own inserts, fed by post-fader
sends; **VCAs** that offset member buses and everything under them; a 14-type insert chain per bus and return (0331);
automation of level, sends and any effect parameter by a game parameter; **snapshots** in folders with triggers
(base mix, from game code, never, or conditions all/any on parameters), fade in, fade out, minimum hold, a priority
and Override or Add; voice limits that inherit down the tree; bed ownership with priority; a gain-lanes breakdown;
Compare A/B; a live board of pinned buses. Its known gaps: snapshot levels can't be edited (dragging a fader in a
snapshot writes the base level and double counts), snapshots don't blend, mute has no handler, the live board has no
UI, ducking rules and a sidechain compressor duck the same bus twice.

0327 makes the Studio the only writer of audio data, and the editor's Project Settings > Audio goes away.

## Decision

We will move the whole `audio` section into its own project file, `audio.json` (`myco.audio@1`), owned by the Studio,
and extend the mix to the prototype's model.

**The file** sits at the project root beside `project.json`; one document, one history (as the section had, 0173).

```jsonc
{
  "format": "myco.audio@1",
  "settings":   { /* today's engine budgets and options, unchanged: voices, background, clipMemoryMB, clipFormat,
                     codecs, spatial, backend, limiterLookaheadMs, bed, ambisonic, occlusion, zones, doppler,
                     speedOfSound, music, rhythmMode, seed */ },
  "parameters": [ /* global parameters, numeric or labelled (0304); a boolean is labelled ["Off", "On"] */ ],
  "buses":   [{ "name": "SFX", "parent": "Master", "volumeDb": -2, "mute": false, "voiceLimit": 48,
                "bed": { "own": true, "priority": 80 }, "meter": false, "effects": [], "sends": [{ "to": "Reverb", "levelDb": -12 }] }],
  "returns": [{ "name": "Reverb", "output": "Master", "volumeDb": -3, "effects": [{ "type": "reverb" }] }],
  "vcas":    [{ "name": "Gameplay SFX", "volumeDb": 0, "members": ["Vehicles", "Footsteps", "Weapons"] }],
  "automation": [{ "on": "Music", "target": "volume", "parameter": "threat", "curve": [[0, 0], [1, -3, "easeOut"]] }],
  "ducking":  [{ "target": "Music", "trigger": "Dialogue", "mode": "presence", "thresholdDb": -20,
                 "amountDb": -6, "attackMs": 80, "releaseMs": 400, "enabled": true }],
  "snapshots": [{ "name": "Underwater", "folder": "States",
                  "start": { "kind": "conditions", "match": "all", "conditions": [{ "parameter": "depth", "op": "gt", "value": 0 }] },
                  "fadeInMs": 300, "fadeOutMs": 500, "holdMs": 0, "priority": 20, "combine": "override",
                  "buses": { "Ambience": -20, "Music": -6 },
                  "effects": { "Music": { "fx3": { "cutoff": 800 } } } }],
  "loudness": { "targets": [ /* as today */ ], "resetOnPlay": true }
}
```

- **Names are identities**, unique across buses, returns and VCAs, as today; a rename rewrites every reference
  (playlists' `output`, sends, automation, ducking, snapshots, VCA members, scenes' `AudioSource.output`) through the
  named-list module (0262). The prototype's display paths ("SFX › Vehicles") are display only.
- **Automation targets:** `volume` (adds dB), `send:<return>` (adds dB), `fx:<effectId>:<param>` (replaces the value).
  Curves are the engine curve (0332), keyed on the parameter's value; frequency parameters interpolate in log scale.

**Gain.** A bus's level in dB is the sum of its lanes, and its parent's level is added on top, so the linear gain is
the product down the tree, as the engine's lanes are today (0172): authored fader, runtime (scripts), snapshot, **VCA**
(new: the sum of VCAs whose members include the bus or an ancestor), monitor (solo and Compare; never saved; taints
meters), dip, duck, automation. The Studio's Gain lanes panel draws exactly these lanes. **Mute** silences the bus and
its sends; solo is exclusive and keeps Master, returns, and the soloed bus's ancestors and descendants audible.

**Returns** are buses fed only by post-fader sends, with their own insert chain, routed to a bus (default Master). A bus
may send to any return; Master can't send. The old single shared reverb becomes a return named "Reverb".

**Snapshots blend.** A snapshot holds per-bus level offsets and, optionally, overrides of any bus or return effect
parameter (`effects: { bus: { effectId: { param: value } } }`; owner decision 2026-11-22). Any number can be active.
Per bus, Override snapshots resolve by priority (equal priority: the one started last wins) and Add snapshots stack
their level offsets on top; an effect parameter takes the winning snapshot's value (Add snapshots don't override
parameters). Each fades in and out over its times as a linear ramp
in dB and stays at least `holdMs`. Start kinds: `base` (always on), `code` (`Audio.snapshot(name).start()` and
`.stop()`; `Audio.snapshot(name, fade)` and `clearSnapshot` stay as shorthands), `never` (audition only), `conditions`
(evaluated on the main thread when a named parameter changes; ops `lt le eq ne ge gt between` on numbers, `is not` on
labels). **Editing a snapshot:** with a non-base snapshot selected, faders edit that snapshot's offset for the bus and
the base level shows as a ghost tick; with the base selected they edit the base level.

**Ducking** is the post-fader duck lane, as today; a Sidechain compressor is a pre-fader insert (0331). The Studio lints
a bus that is ducked by both from the same trigger.

**Voice limits** cap a bus and every bus below it; a bus without one shares the nearest ancestor's. Stealing and
virtual voices follow the engine's priority-based selection (0157). **Beds:** a bus may own a bed with a priority;
Master always has one; the `settings.bed.maxBeds − 1` highest priorities get the rest; others share the nearest bed
above them (the engine's rule, now with the priority shown).

**Live mixing.** Edits made while the Studio's runtime plays (an audition or a take replay, 0334) go through `MixOp`s
and `Mixer.apply` and are kept, as Play-mode edits are today; Compare A/B, monitor controls and meter taint keep their
rules (0172). `mixOps.ts` gains ops for returns, VCAs, mute and snapshot edits. The live board's pins (up to 8) are a
per-user Studio preference, not project data.

**Migration** (with 0329's, same confirmation): the `audio` section moves out of `project.json` into `audio.json`;
volumes convert to dB; a `reverb` effect becomes a send to a created "Reverb" return; snapshot multipliers convert to dB
offsets and a snapshot `lowpass` becomes an override of a low-pass effect created on that bus (bypass-neutral at
20 kHz outside the snapshot); bus automation keeps its curves with target `volume` (or `fx:` on that low-pass effect
for low-pass automation). The engine reads `audio.json`; a `project.json` that still has an `audio` section is migrated, not read.

## Alternatives considered

- **Keep the mix in `project.json`** — the editor and the Studio would both write `project.json`; with the Studio as
  the only audio writer, a separate file keeps ownership clean.
- **A file per snapshot or per bus** — more files and cross-file edits for one mix; the prototype's snapshot folders
  are a folder path on each snapshot.
- **Stable bus ids instead of names** — would make renames trivial, but buses are named in scripts (`Audio.bus(name)`)
  and in scenes; the engine already rewrites names on rename.
- **One active snapshot (today)** — the prototype's triggers, priorities and Add mode need several at once.

## Consequences

**Positive**
- The mix is the prototype's: returns, VCAs, rich inserts, parameter-driven automation, blending snapshots.
- One file, one history, one owner.

**Negative / costs**
- Core work: returns as send-fed buses with inserts, VCA lane, mute, more effects per bus, snapshot ramps.
- The Babylon fallback can't run most of this; it degrades with one warning per feature (0179's rule).
- Every reader of the `audio` section (`audioSection.ts`, live keys, capture META, the settings handle) moves to
  `audio.json`.

## Deprecates

- The `audio` section of `project.json` (migrated), Project Settings > Audio (`AudioSettingsSection.tsx`,
  `audioSettingsModel.ts`, `audioDraft.ts`), the `reverb` send effect type.
- Snapshots' `volumes` (multipliers) and `lowpass` maps: migrated (see Open questions for low-pass).

## Open questions

- ~~Snapshot scope~~: level offsets plus any bus effect parameter (owner, 2026-11-22).
- Whether users can add more returns in v1 (the prototype shows a list but seeds one).

## References

- Prototype Mixer screen (`Mixer.dc.html`), Journeys j8, j10.
- `src/engine/audio/settings.ts`, `mixer.ts`, `mixOps.ts`, `busCapability.ts`, `audioSection.ts`;
  `src/plugins/audio/editor/mix/`; guides `audio-mixer.md`, `audio-mixing.md`, `audio-mix-api.md`.
