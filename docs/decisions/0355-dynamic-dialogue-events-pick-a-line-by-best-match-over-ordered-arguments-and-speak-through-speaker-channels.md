# 0355. Dynamic dialogue events pick a line by best match over ordered arguments, and speak through speaker channels

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0262, 0304, 0306, 0313, 0314, 0341, 0343 (extended: a `line` entry may name a dialogue event), 0348 (extended: `say` request records), 0349, 0354

## Context

The owner's follow-on scope (plan "Follow-on scope", 2026-11-22) asks for dynamic dialogue (feature 3), built in W13
after localisation and voice-over (0354), with Wwise's dynamic dialogue as the reference.

**What exists.** 0354 gives voice-over lines as keyed rows in line tables (`*.lines.json`), each with a speaker,
subtitle text per language and a file per language, played by `Audio.line(key)` or a playlist `line` entry. Playlists
(0343) pick by Queue (weights, avoid-repeat, the World's seeded generator, `playlist/picks.ts`) and by Switch (one
labelled parameter, label → entry). Labelled parameters (0304) are the engine's switch and state groups: global ones in
`audio.json` `parameters`, local ones per playlist. Takes (0348) record requests and replay them against the current
project with the recorded pick-generator state. Nothing chooses a line from several game facts at once, and nothing
stops two lines of one character overlapping.

**How the reference tools do it.**
- **Wwise Dynamic Dialogue:** a *Dialogue Event* has an ordered list of *arguments* (switch or state groups). The game
  posts the event with one value per argument (or the argument's current state); the values form a path through a
  *decision tree* whose leaves name Sound Voice objects, with `*` (wildcard) branches. *Best match* prefers the path
  that matches exactly at the earliest arguments; *Weighted* mode picks among all matching paths by weight; each path
  has a probability. Wwise leaves queueing to the game or to Play Type rules.
- **FMOD:** no decision tree; programmer instruments with the game choosing the key (often by a table lookup in code).
- **Unreal:** Dialogue Waves with *contexts* (speaker, target), plus game-side bark systems with cooldowns and "don't
  repeat" memories; concurrency settings limit overlap.
- **Shipped bark systems** (Left 4 Dead's response rules, *The Last of Us*) add priorities, interruption, per-speaker
  serialisation, cooldowns and memory of what was said.

## Decision

We will add **dialogue events** in a new asset kind, `*.dialogue.json`: each event has ordered labelled arguments and
a path table (`argument values → weighted line keys`, with wildcards), resolved by Wwise's best match or weighted mode
with fallbacks; `Audio.say` plays the picked line through **speaker channels** with priority, interruption, queueing,
cooldowns and no-repeat memory; the Studio's Dialogue screen (0354) gains an Events tab with a test bench, audition and
coverage report; takes record each `say` with its arguments and pick.

### 1. The asset: `*.dialogue.json` (`myco.dialogue@1`)

One file holds any number of events (Wwise work units), parsed by `src/engine/audio/dialogue/format.ts` (lenient,
never throws; limits declared once, 0306: 512 events per file, 8 arguments per event, 64 labels per argument, 4,096
paths per event, 64 lines per path).

```jsonc
{
  "format": "myco.dialogue@1",
  "events": [{
    "name": "enemy_spotted",                       // unique across the project
    "arguments": [
      { "name": "speaker",  "labels": ["Guard", "Captain", "Sniper"] },   // local argument
      { "parameter": "weather" },                                        // a global labelled parameter (audio.json)
      { "name": "distance", "labels": ["Near", "Far"], "default": "Near" }
    ],
    "mode": "bestMatch",                           // bestMatch | weighted
    "paths": [
      { "path": ["Guard", "*", "Near"], "lines": [{ "key": "guard_spot_near_01", "weight": 2 },
                                                  { "key": "guard_spot_near_02" }] },
      { "path": ["Guard", "Rain", "*"], "lines": [{ "key": "guard_spot_rain_01" }], "probability": 0.5 },
      { "path": ["Sniper", "*", "*"],   "lines": [] },                     // explicit silence: snipers say nothing
      { "path": ["*", "*", "*"],         "lines": [{ "key": "generic_spot_01" }, { "key": "generic_spot_02" }],
        "weight": 1 }
    ],
    "priority": 60,                                // 0..100; absent: the picked line's table priority (0354)
    "whenBusy": "queue",                           // queue | interrupt | drop (§4)
    "interrupt": "lower",                          // never | lower | always: what this event may cut off
    "maxWait": 2.5,                                // seconds a queued say may wait before it is dropped
    "cooldown": 4,                                 // seconds since this event last spoke
    "chance": 1,                                   // 0..1 per say
    "avoidRepeat": 2,                              // 0..8: the last N lines this event spoke are skipped when possible
    "skipMissing": true,                           // a line with no file in the language chain is unavailable (§2)
    "onInterrupted": null                          // an event said (same args) when one of its lines is cut off
  }]
}
```

- **Arguments** are labelled only, as Wwise's switch and state groups. A local argument declares its labels (and an
  optional `default`, else the first); a `parameter` argument uses a global labelled parameter (0304) and its labels.
  Numeric game facts are bucketed by the game ("Near"/"Far"). A deleted or numeric global parameter is a lint, and the
  argument then only matches `*`.
- **Paths** have one entry per argument: a label or `"*"`. Each line has `key` (a 0354 line key) and `weight` (0..100,
  default 1; 0 = never). A path has `probability` (0..1, default 1) and `weight` (weighted mode only, default 1).
- **Identities.** Event names match `[A-Za-z0-9_.-]{1,64}` and are unique across the project (the Studio refuses a
  duplicate; the runtime takes the first by path order and warns). Renaming an event, an argument label or a line key
  rewrites every reference (paths, playlist entries, `onInterrupted`) through the named-list module (0262); script
  literals are linted. The asset kind (`dialogue`, registered beside `lines` in `plugins/audio/editor/studioAssets.ts`)
  reads and rewrites its line-key references (0314).

### 2. Deciding a line

`decide(event, args, ctx)` in `src/engine/audio/dialogue/decide.ts`, pure; `ctx` gives `rng` (the World's seeded
generator), `available(key)` (0354: the line exists and, with `skipMissing`, has a file in the current language's
chain, and isn't held by a line cooldown, §4) and the event's memory.

1. **Values.** Each argument's value is `args[name]` from the call; else, for a `parameter` argument, the global's
   current label; else the argument's default. A value that isn't one of its labels warns once and matches only `*`.
2. **Candidates.** The paths whose every entry equals the value or is `*`.
3. **Order.**
   - `bestMatch` (Wwise): compare candidates argument by argument from the first; at the first argument where they
     differ, an exact label beats `*`. Equal paths can't exist (the parse drops later duplicates with a problem).
   - `weighted`: one candidate drawn by path `weight`; the rest follow in best-match order (for fallback).
4. **Take the first candidate in order** that passes its `probability` draw. A path with `lines: []` is an explicit
   silence: the decision ends with nothing (reason `silence`). Otherwise draw a line among its **available** lines by
   weight, excluding the event's last `min(avoidRepeat, n − 1)` lines (the Queue pick of `picks.ts`, reused; its
   history grows from 5 to 8). No available line: **fall back** to the next candidate. No candidate left: nothing
   (reason `noMatch`, or `unavailable` when matches existed but no line was available).
5. The result is `{ key, path, pathIndex }` or `{ none: reason }`, plus a **pick path** for the profiler's "Why it
   played" (0348): the values, the candidates tried and why each was passed over.

Every random draw (weighted path, probability, line) comes from the World's seeded generator in that order, so a seed
and the same data give the same line.

### 3. Composition with lines, languages and playlists

- **Lines and languages.** Leaves are language-neutral line keys; the language is applied when the line plays (0354
  §2–§5): its table's template, bus, speaker, subtitle and lip-sync come with it. With `skipMissing` a line not recorded
  anywhere in the chain is passed over in favour of one that is, so a partly translated event still speaks; with
  `skipMissing: false` it plays as 0354 §3 says (subtitle-only by default).
- **Playlists.** 0354's playlist `line` entry gains an event form: `{ "line": { "event": "enemy_spotted" } }` (`LineEntry.line: string | null | { event: string }`).
  When picked it decides with arguments taken from the playlist instance's labelled parameters of the same name
  (local, then global), so a playlist with a Switch on `distance` can voice its own bark. A playlist entry plays as a
  voice of its playlist: it does not go through speaker channels (§4).
- **Why a separate asset, not a playlist type.** A playlist type `dialogue` would put per-call arguments, wildcard
  best-match, line availability by language, cooldown memory and speaker queueing into the playlist runtime, whose
  picks are per trigger over entries and whose Switch reads one parameter. Nested Switch playlists can't express
  wildcards with best match, and their coverage can't be reported. Dialogue events produce a line key and hand it to
  0354's line playback; the line entry is the bridge both ways.

### 4. Speaker channels, priority and interruption

`runtime/dialogue/dialogueSystem.ts`, one per World.

- **Channels.** A `say` plays on a channel: `options.channel`, else the picked line's speaker, else the event name. A
  channel speaks one line at a time (a character never talks over itself). `audio.json` `settings.dialogue` gains
  `maxVoices` (lines speaking at once across channels, default 3, 0 = no limit) and `interruptFadeMs` (default 150).
- **Priority** 0..100: `options.priority`, else the event's, else the line's table priority (0354, default 50).
- **When the channel is busy** (or `maxVoices` is reached, compared with the lowest-priority speaking line):
  - **interrupt:** allowed when the event's `interrupt` permits it (`lower`: the speaking line's priority is lower;
    `always`; `never`) and `whenBusy` isn't `drop`: the speaking line fades out over `interruptFadeMs`, its handle
    finishes `interrupted`, its event's `onInterrupted` is said (same args, same channel, after the fade; never chained
    further), and the new line starts.
  - else **queue** (`whenBusy: "queue"`): the say waits in the channel's queue (ordered by priority, then age; at most
    4 per channel, the lowest dropped when full) and is dropped once it has waited `maxWait`. The decision is made
    **when the say starts**, not when it was asked, so cooldowns and the language are current.
  - else **drop**: the handle finishes `refused` with reason `busy`.
- **Cooldowns and memory** (`DialogueMemory`, per World): event `cooldown` (since it last spoke), event `chance`, the
  event's avoid-repeat history, and per line `cooldown` in its line table row (0354 gains an optional per-line
  `cooldown`, seconds, default 0, and `once: true`: never again this session). A say refused by cooldown or chance
  finishes `refused` with reason `cooldown` or `chance`. Memory is kept for the World's life and can be saved by the
  game (§5).
- **Positions.** `options.position` or `options.node` place the line; else the enabled **`AudioSpeaker`** component
  whose `speaker` matches the line's speaker (nearest to the listener when several) places and follows it; else it is
  flat. `AudioSpeaker` (`speaker: string`) also offers `say(event, options)`, which adds `node: this.node` and, when
  the event has an argument named `speaker`, that argument's value.

### 5. Public API

```ts
Audio.say(event: string, options?: SayOptions): AudioLineHandle      // 0354's handle
interface SayOptions extends LineOptions {          // position, node, volume, bus… (0354)
  args?: Record<string, string>;
  channel?: string;
  priority?: number;                                // 0..100
  whenBusy?: "queue" | "interrupt" | "drop";        // overrides the event's
}
// AudioLineHandle gains:
//   readonly state: "queued" | "playing" | "ended";
//   readonly event: string | null;  readonly path: readonly string[] | null;   // the matched path
Audio.dialogue: {
  speaking(channel: string): boolean;
  stop(channel?: string, fadeSeconds?: number): void;   // stops the line and clears the queue (all channels if omitted)
  memory(): DialogueMemory;                             // plain JSON: cooldown times relative to now, histories, once-lines
  restore(memory: DialogueMemory): void;
}
class AudioSpeaker extends Component { speaker: string; say(event: string, options?: SayOptions): AudioLineHandle }
```

- `Audio.say` never throws; an unknown event returns an inert handle with reason `unknownEvent`. `AudioReason` gains
  `unknownEvent`, `busy`, `cooldown`, `chance`, `silence`, `noMatch`, `unavailable`. `finished` resolves `refused` for
  every refusal and `interrupted` for a cut-off line. `Audio.onLine` (0354) fires for said lines as for played ones,
  with `event` added to `AudioLineEvent`.
- `Audio.debug()` gains `dialogue: { channels: [{ channel, speaking: key | null, priority, queue: [{ event, waited }] }], refusals: { busy, cooldown, chance, silence, noMatch, unavailable } }`.
- Engine-native types only (0010).

### 6. Determinism and takes (0348)

- A new request record **`say`**: `{ t, instance, event, args, options, picked: { key, pathIndex } | { none: reason } }`
  where `args` holds the resolved value of every argument (including those read from globals and defaults), so replay
  doesn't depend on the order globals changed in. Queued says are recorded when asked (`state: queued`) and again when
  they start or are dropped (a `sayState` record), and interruptions as `stop` with reason.
- **Replay** re-decides each `say` from its recorded args against the current project, with the World generator
  restored from the recorded state (0348 keyframes), so unchanged data picks the same line. When the current data picks
  differently, the Take screen marks the instance "picked X, recorded Y" and the inspector shows both pick paths. A Take
  toolbar toggle **Replay recorded picks** plays the recorded keys instead (for reviewing the run as it was).
- Unit test: record a scripted run on the fake backend, replay it against the same data: identical keys, states and
  times; change one path's weights: the differing instances, and only those, are marked.

### 7. The Studio: Events tab of the Dialogue screen

0354's Dialogue screen gains an **Events** tab (`src/studio/screens/dialogue/events/`), from the kit (0349):

- **Event list** (by file, search), add, duplicate, rename, delete (refused-or-next edits, 0313).
- **Path table editor:** one column per argument (header: name, local labels or the linked global parameter, drag to
  reorder, which reorders every path), a Lines column of weighted chips (drag keys from the Lines tab or type with
  completion; a chip shows recorded/missing for the preview language), probability and (weighted mode) weight
  columns. Each cell is a label menu with `*`. **Group by argument** shows the same table as a collapsible tree (Wwise's
  view) without a second model. Lints inline: unknown labels or keys, duplicate paths, a path reached only as a fallback (every label under
  its `*` is taken by a more specific path).
- **Test bench:** a value picker per argument (and "from global"), language from the header chip. It highlights the
  path best match would take and the fallbacks in order, with each one's reason; **Say** auditions through the Studio
  runtime's dialogue system (channels and cooldowns included; **Reset memory** clears them); **Roll ×50** shows the
  pick distribution as a bar per line.
- **Coverage report** (`coverage.ts`, pure, in a worker): the argument combinations with no line, as compact patterns
  rather than an enumerated product: walk the arguments in order, at each level split by label (a `*` path belongs to
  every branch), and report a prefix with no candidates as `Captain · * · *`; a branch whose candidates are all silent
  is listed as intended silence. **Per language:** combinations whose every candidate line is missing in that language
  (and would play subtitle-only or nothing). Also lines in no event ("unused lines") and events no script or playlist
  names (best effort over readable script literals). CSV export.
- **Changing an argument** (removing a label, unlinking a global) shows the paths it affects before applying.

## Alternatives considered

- **A playlist type** — see §3: it would load the playlist runtime with dialogue-only semantics and still lack
  wildcards, best match and coverage.
- **Dialogue events inside line tables** — fewer files, but tables are per chapter or speaker and events cut across
  them (a guard bark uses generic lines), and translators receive tables, not logic.
- **One file per event** — Wwise-like objects but hundreds of tiny files; a file of events, like a line table of lines,
  keeps related barks together and renames tracked by identity.
- **A rule system with arbitrary criteria (Left 4 Dead response rules)** — more expressive (numeric comparisons,
  memory facts), but harder to author and to report coverage for; ordered labelled arguments are Wwise's proven model,
  and numeric facts bucket into labels.
- **Deciding when asked rather than when a queued say starts** — the line could be stale (a cooldown or language
  changed while waiting); deciding at start matches what is heard.
- **Replaying recorded keys by default** — hides the effect of edits, which is what replay against the current
  project is for (0348); kept as a toggle.
- **Leaving queueing to the game (Wwise)** — every game re-implements speaker serialisation and cooldowns; shipped bark
  systems all have them.

## Consequences

**Positive**
- Barks and contextual lines choose themselves from game facts with weights, fallbacks and language awareness.
- Characters don't talk over themselves; important lines cut off lesser ones; repeats and spam are controlled.
- The Studio shows which line a situation plays, why, and which situations have no line in which language.
- Takes reproduce dialogue picks and show where edits changed them.

**Negative / costs**
- A second asset kind and screen tab to maintain, and more public API (`Audio.say`, `Audio.dialogue`, `AudioSpeaker`,
  `SayOptions`, `DialogueMemory`, seven reasons).
- Arguments are labels only; games bucket numbers themselves.
- Speaker channels apply to `Audio.say` only; lines played by `Audio.line` or inside playlists can still overlap a
  channel (documented; the lint can't see script calls).

## Deprecates

Nothing.

## Open questions

- Numeric arguments with ranges, if bucketing proves awkward.
- Conversations (scripted exchanges between speakers with turn-taking) as a later layer over channels.

## References

- Wwise: Dynamic Dialogue, Dialogue Events, arguments, Best Match and Weighted modes, path probability. FMOD:
  programmer instruments. Unreal: Dialogue Waves and contexts, sound concurrency. Elan Ruskin, "AI-driven Dynamic
  Dialog through Fuzzy Pattern Matching" (GDC 2012, Left 4 Dead response rules).
- ADR 0354; `src/engine/audio/playlist/picks.ts`, `parameters.ts`, `take/types.ts`; `src/plugins/audio/runtime/Audio.ts`,
  `playlists/`; `src/plugins/audio/editor/studioAssets.ts`.

## Build plan

| # | Milestone | Contents | Files (owner) |
|---|---|---|---|
| D1 | Format and decision | `myco.dialogue@1` types, parse, writer, limits; `decide` (values, candidates, best-match order, weighted, probability, silence, fallback, avoid-repeat via `picks.ts` with history 8); pick paths; references and renames (keys, labels, events); lint; coverage patterns; line table `cooldown`/`once`; `LineEntry` event form; asset kind; unit tests (best-match ordering table, wildcard positions, weighted distribution over a seeded generator, fallback past missing languages, explicit silence, coverage patterns on a 3×3×2 event, rename rewrite) | `src/engine/audio/dialogue/**`, `src/engine/audio/localisation/lines/format.ts`, `src/engine/audio/playlist/types.ts` + `format.ts`, `src/plugins/audio/editor/studioAssets.ts` |
| D2 | Runtime | dialogue system per World (channels, `maxVoices`, priority, interrupt with fade and `onInterrupted`, queue with `maxWait`, cooldowns, chance, memory); `Audio.say`, `Audio.dialogue`, `AudioSpeaker`; playlist event entries with args from parameters; reasons; `settings.dialogue`; debug rows; `src/myco.ts` exports; tests on the fake backend with a fake clock (interrupt lower/never, queue expiry, decide at start, `maxVoices`, memory round trip) | `src/plugins/audio/runtime/dialogue/**`, `AudioSpeaker.ts`, `Audio.ts`, `backend.ts` (reasons), `playlists/nodes.ts`, `src/engine/audio/project/types.ts` + `format.ts` (settings), `src/myco.ts` |
| D3 | Takes | `say` and `sayState` records (writer, reader, minor version), recorder in `takeTap.ts`, replay re-decides with restored generator, "picked differently" marks, Replay recorded picks toggle; the determinism test of §6 | `src/engine/audio/take/**`, `src/plugins/audio/runtime/capture/takeTap.ts`, `src/studio/shell/replay.ts`, `src/studio/screens/take/**` |
| D4 | Studio Events tab | event list, path table with tree grouping, argument editing with impact preview, test bench with Say and Roll ×50, coverage report and CSV; stories with `play` tests | `src/studio/screens/dialogue/events/**` (+ the tab hook in the screen, single writer with 0354 L5) |
| D5 | Docs and e2e | `docs/wiki/guide/dynamic-dialogue.md`; e2e: in the Studio, a test-bench pick highlights the expected path and coverage lists a gap | `docs/wiki/guide/**`, `tests/e2e/studio-dialogue-events.spec.ts` |

D1 needs 0354's L1 (line table format and `LineEntry`); D2 needs 0354's L2; D3 after D2; D4 after 0354's L5 and D1;
D5 last. Shared single-writer files with 0354 are listed in 0354's build plan.
