<!-- The owner's Audio Studio spec (from Myco-Audio-Studio-Spec.docx, 2026-11-23), converted to Markdown unedited. A requirement source alongside the prototype canvas; accepted ADRs and the decision log record where the build differs. -->

Status: prototype complete, ready to build. Written 2026-11-22 from the
interactive prototype "Audio Design Studio – Prototype UI v2" (claude.ai
design canvas), its project notes, and the design decisions recorded
during its development.

# Contents

# 0. How to read this document

## 0.1 Purpose and audience

- This document describes everything the Audio Studio is: every screen,
  panel, control, data model, behaviour and rule. It covers both what
  the prototype already shows and what it only implies.

- It is written so an implementing agent (or engineer) can build the
  real product from it without having seen the prototype.

- Where the prototype fakes something (meters, CPU numbers, audio
  analysis), the document says what the real behaviour must be.

## 0.2 Status tags used throughout

- **\[Proto\]**: built and interactive in the prototype. The behaviour
  described is the intended product behaviour.

- **\[Sim\]**: shown in the prototype with fake or canned data (meters,
  analysis results, game values, captures). The UI is final; the data
  source must be built.

- **\[Planned\]**: decided, but not built in the prototype at all. Must
  be built.

- **\[Open\]**: not decided yet. Listed in section 11.

## 0.3 Source of truth

- Canvas artifact: https://claude.ai/artifact/P6vFYUbDXpg4jg5k5KY5TY
  (slug b2fc9617-dfc4-413a-9f6c-7044a526dccb), page "Studio".

- Final screen set on the Studio page: Samples (File.dc.html), Playlists
  (Playlists.dc.html, which embeds Sequencer.dc.html for sequences),
  Mixer (Mixer.dc.html), Spatial (Spatial2.dc.html), Take
  (Main.dc.html), Profiler (Profiler.dc.html), and the shared Curves
  sub-window (CurveDialog.dc.html).

- Superseded boards live on the canvas "Archive" page (section 12). A
  "Workflow Trials" page holds the empty-project test boards (section
  9).

# 1. Product overview

## 1.1 What it is

- The Audio Studio is the sound-design and mixing tool inside the Myco
  Engine editor (a cross-platform, open-source, AAA-quality game engine
  and editor). Its job is comparable to FMOD Studio or Wwise, but built
  into the engine's editor and following the engine's editor
  conventions.

- It combines DAW and film-editing style timelines (samples, clips,
  tracks) with game-audio logic (randomisation, switching, blending by
  game parameters, snapshots, spatialisation, profiling).

- The runtime audio core is written in Rust and runs at 48 kHz in the
  prototype's status bar ("Rust core · 48 kHz"). The studio talks to a
  running game ("game session") so edits can be heard live.

## 1.2 The six screens, grouped

The top navigation groups the screens into three groups. Each screen has
a keyboard shortcut.

- **Author**

  - **Samples** (Ctrl/⌘+1): the audio assets. Import, organise in
    folders, trim, loops, markers, tempo, root note, loudness,
    non-destructive sample effects, snippets, forks, WAV metadata
    round-trip.

  - **Playlists** (Ctrl/⌘+2): what plays when the game asks for a sound.
    Playlists of six kinds (Clip, Queue, Switch, Blend, Layer,
    Sequence). A Sequence is a playlist whose content is a multi-track
    timeline.

- **Mix**

  - **Mixer** (Ctrl/⌘+3): the bus routing tree, levels, effects, sends,
    ducking, ambisonic beds, voice limits, VCAs, loudness metering,
    snapshots with triggers, A/B compare, automation by game parameters.

  - **Spatial** (Ctrl/⌘+4): test scenes for 3D sound: emitters, moving
    emitters, listeners, obstacles, audio zones, reverb zones, 2D
    sounds, height (elevation), occlusion, attenuation, HRTF / panned /
    ambisonic-bed rendering.

- **Run**

  - **Take** (Ctrl/⌘+5): a recorded gameplay run you can replay. Its
    recorded game values drive your current sounds, so you can mix and
    tune against real gameplay.

  - **Profiler** (Ctrl/⌘+6): debugging view of a capture: voices, load,
    effects instances, bus gain, loudness, message log, "Why it played"
    graph, "You hear" gain chain.

## 1.3 Core design principles (user decisions; apply everywhere)

- **Terminology** (strict):

  - **Sample** = an audio asset (a file plus its project-side settings).
    The screen is called Samples, never "File".

  - **Clip** = one use of a sample (in a sequence track or as a Clip
    playlist). Inherits the sample's settings and can override them.

  - **Track** = the lane (row) that holds clips in a sequence. Not an
    FMOD-style instrument.

  - **Sequence** = a playlist whose content is a timeline of tracks.
    Replaces the older word "Event".

  - **Event** = only a call from game code (e.g. "game event Land
    fired"). Never an authored container.

  - **Take** = a recorded gameplay run only. (Do not use "take" for
    variations inside a playlist.)

  - **Snippet** = a piece produced by razor cuts on a sample ("Razor
    snipping"). Not "split".

  - **Bus** = mix routing node. **Return** = a bus fed by sends. **VCA**
    = a level control over several buses with no audio through it.

- **No inline helper text.** Explanations live in tooltips (title text),
  not paragraphs on screen. Empty states are the exception (one short
  line). Prefer icon buttons over text buttons; every icon button has a
  tooltip and an accessible name.

- **Lists and outlines are alphabetical**: categories and the items
  inside them.

- **Every slider has a typed value field** next to it, in the control's
  own unit, kept in sync, clamping out-of-range input. Fields align in a
  column.

- **Typed fields** (names, times, lengths, tempo) hold a draft and
  commit on Enter or blur; Esc reverts. Sliders and number fields are
  live; one undo step per gesture.

- **Docking everywhere.** Every panel on every screen is resizable,
  dockable, movable, collapsible, and the layout persists. The screen
  should never make the window overflow; panels fill the space.

- **Floating curve editor.** Curves are edited in one shared floating
  sub-window (Curves), never docked.

- **Bus routing is edited only in the Mixer.** Other screens show and
  pick output buses but don't change the tree.

- **Structural edits during Play apply to the next instance** of a sound
  (playing copies keep the old version until restarted).

- **Non-destructive audio**: source audio never changes; edits are data;
  renders are disposable caches.

- **Touch and small screens are first-class**: everything must work on a
  tablet / foldable phone (tested on a Google Pixel Fold). Context-menu
  alternatives ("Move to…") are preferred over replacing native
  drag-and-drop when drag is unreliable on touch.

- **Theme tokens only** (Myco Editor design system; light and dark
  themes). No hard-coded colours.

- **Prototype screens are disposable drafts**: when direction changes,
  the newest decision wins. Engine limits are never assumed unless
  stated.

## 1.4 Glossary (quick reference)

- **Active (loop)**: whether a loop keeps repeating. Always / While held
  / Parameter.

- **Ambisonic bed**: a shared surround sound field hosted on a bus;
  distant sounds are mixed into it and decoded once.

- **Base mix**: the snapshot every other snapshot is applied on top of
  (in the demo, "Gameplay").

- **Capture**: a Profiler recording. A capture is a take with debug
  data.

- **Change rule**: a Switch playlist rule (From / To / When / How) for
  moving between labels.

- **Exit marker**: a marker where music may leave (for transitions).

- **Game parameter**: a named value the game sends (number, true/false,
  enum state, text).

- **Game session**: the running game the studio is linked to; it keeps
  running across screens.

- **Hit point**: a marker where a stinger beat lands on the change.

- **Hold point**: a zero-length loop; the playhead parks there while it
  is active.

- **Cue marker**: a marker whose name is sent to the game when playback
  passes it.

- **Pickup / Link / Tail**: the parts of a sample around its loops
  (before the first loop, between loops, after the last loop).

- **Snapshot**: a stored set of bus level changes that applies while its
  trigger is true.

- **Voice**: one playing instance of a clip.

- **Voice time**: a clock that starts at 0 each time a playlist is
  triggered.

# 2. Data model

This section defines every authored object, its fields and its rules.
Screen sections refer back here.

## 2.1 Project

- A project contains: samples (in a folder tree), playlists and
  sequences (in a folder tree), the bus graph (buses, returns, VCAs),
  snapshots (in a folder tree), game parameter definitions, test scenes
  (in a folder tree), takes (in a folder tree), captures (in a folder
  tree), saved colours, curve presets, project settings (timecode
  display, max beds, loudness targets, calibration per device).

- Every folder tree in the studio behaves the same way (section 3.9):
  nested folders, alphabetical, rename, delete moves contents up a
  level, drag to move, "Move to…" dialog, "Move to top level", search
  showing each item's folder path.

- **\[Planned\]** Project persistence. The prototype keeps each screen's
  state in memory (plus localStorage for dock layouts, review playhead,
  and the trial project). The real product stores everything in the
  project on disk and shares it between screens.

## 2.2 Sample (asset)

- **Identity**: name, folder path in the project, the file on disk
  (relative path), import date.

- **Audio facts** (from the file, read-only): sample rate (e.g. 48 kHz),
  channels (mono/stereo), length, bit depth.

- **Source versions** (re-import history): list vers\[\] of imported
  versions v1, v2, … each with id, import time, length, and a "flat"
  flag when it was created by Flatten. A **current version** selector
  srcV. A re-import adds a version and switches to it; switching is an
  ordinary undoable edit. Flipping versions keeps the current edits; the
  edit graph rebuilds on the selected source.

- **Trim**: start and end (seconds). Audio outside the trim never plays.
  Defaults to full length. "Reset to full length" restores it.

- **Loops** (zero or more, ordered in time). See 2.3.

- **Markers** (zero or more). See 2.4.

- **Snippets**: pieces produced by razor cuts (2.5).

- **Tempo**: BPM (optional) + meter (default 4/4; meter can't be
  detected reliably). Source: from the WAV (acid chunk), detected by
  analysis, or typed / tapped by the user. Decided: no variable tempo
  maps on a sample. A varying tempo is handled by snipping and saving
  the snippet as its own sample with its own tempo.

- **Root note**: note and octave (e.g. C3, F#2, Bb4) plus fine tune in
  cents. Source: WAV sampler chunk, detected, or typed. "Pitch default
  when used in a Sound".

- **Loudness**: measured integrated LUFS and peak dBFS (always measured
  from the audio). **Normalize** setting: Off ("Play at the recorded
  level") / Loudness ("Match a target loudness (integrated LUFS)", with
  Target) / Peak ("Bring the loudest sample to a target level", with
  Target). Plus Gain. Normalize is applied last, after the effects.
  Peaks over 0 dBFS show red ticks on the waveform.

- **Sample effects chain** (baked, non-destructive; see 2.10 and 4.1.7).

- **Freeze** flag (render pinned as fixed audio), render cache state.

- **Music settings**: "Can leave at" (Exit markers / Any bar / Every 2
  bars / Loop end only), Tags (e.g. Stinger), Timecode display start
  offset ("Timecode display starts here").

- **Import settings**: Load (Decode on load / Stream), Format (Original
  WAV / Vorbis / AAC), Sample rate (Keep 48 kHz / Downsample to 24 kHz).

- **Lineage**: Root, or "Fork of X" / "Split of X" (snippet saved as a
  sample), with a link to the parent. Fork dependency mode Follow / Pin
  (2.11). Lists its forks and snippets-saved-as-samples.

- **Used by**: list of playlists and sequences that use the sample (with
  how: "entry in Bike impact (Switch · Metal)", "audio clip · holds in
  Loop · while held", "change rule leaves at Exit markers"). Empty
  state: "Not used by any playlist or sequence yet".

- **WAV metadata tracking** (2.12): each imported item (cue, loop,
  tempo, root) remembers its value in the file, so the studio can show
  "differs from file", revert, detect "changed on disk", and write back.

- **Detached** flag: "Detach from file" stops tracking the WAV for the
  whole sample; values become project-only.

- **Colour**: user-facing colour (from the shared palette).

## 2.3 Loop model (sample loops, sequence loops, clip overrides)

One loop model is shared by sample loops (Samples screen), sequence
loops (sequence timeline Loops row) and per-clip overrides of sample
loops.

- **Range**: start and end. A zero-length loop (start = end) is a **hold
  point**: the playhead parks there while it is active. A hold point can
  be dragged open into a loop.

- **Repeats** (sample loops): "Until it stops being active" (∞; smpl
  play count 0) or **Times** (plays a set number of times, then moves on
  to the next link, loop or the tail).

- **Active**:

  - **Always** (∞ icon): repeats until the voice stops.

  - **While held** (hand icon): repeats while the game holds the voice /
    the sequence key is held.

  - **Parameter** (boxed P icon): a game parameter turns it on and off.
    On samples this is "bound per clip in its sequence (Playlists)": the
    binding (parameter, \> or \<, threshold) lives on the clip, not the
    sample.

- **Exit** (what happens when it stops being active):

  - **Jump now**: leave the loop at once, from wherever the playhead is.

  - **Finish pass**: play on to the loop end, then carry on. For music,
    leaves at the next Exit marker inside the loop if there is one, else
    at the loop end. If the loop turns active again first, it keeps
    looping. Exit markers switched off on a clip are skipped.

  - **Crossfade**: crossfade out of the loop into what follows, with
    **Exit fade** in ms.

  - Hold points have no Exit setting.

- **Re-entry**: **Ignore** (once the playhead has left the loop, turning
  it active again does nothing) or **Re-enter** (turning it active again
  after the playhead left jumps back into the loop).

- **Direction** (sample loops; maps to the WAV smpl loop type): Forward
  ("Jump from loop end back to loop start"), Alternating ("Play back and
  forth between the points"), Backward ("Play the loop in reverse").

- **Crossfade at the seam** (ms): smooths the jump from loop end to loop
  start (tuned in the Loop seam panel, 4.1.8).

- **Structure of a sample with loops**: Pickup (trim start → first loop
  start, plays once) → Loop 1 → Link (between loops, plays once) → Loop
  2 → … → Tail (last loop end → trim end, plays once). Playback plays
  the pickup, each loop as its Active setting says, then the tail. With
  no loops the sample plays once from trim start to trim end.
  Double-clicking the pickup, a link or the tail adds a loop there.

- **Per-clip override** (in sequences): each sample loop shows as
  **Inherited** or **Override** (with a reset button "Use the sample's
  settings"); overriding exposes the full loop controls and the
  Parameter binding (parameter, Condition \> / \<, Threshold slider +
  field).

- A sustain is not a separate concept: it is a loop whose Active state
  is driven by being held or by a parameter.

## 2.4 Markers

- Types (on samples):

  - **Note**: annotation only; free name and colour; can be a point or a
    range ("Convert to range: gives it an end so it marks a span").

  - **Exit**: "Music may leave here for a transition". Fixed name "Exit"
    and fixed colour (accent2 / green). Drawn green on clips.

  - **Hit point**: "Stinger: this beat lands on the change". Fixed name
    and colour.

  - **Cue** (formerly "Event"): "Sends this cue name to the game when
    playback passes it". Editable name, fixed colour; label prefixed
    with ↯. Example: "Game spawns tyre smoke on this cue".

- Fields: id, type, name (when editable), time (or range start/end),
  colour (only when not fixed), note text (shown on hover).

- Imported markers carry a file badge and track their file value (2.12).

- Sequence markers: a Markers row on the sequence timeline (double-click
  to add). Clip-level: sample markers can be switched off per clip ("Use
  \<marker\> in this clip"); Cue markers tell the game when the clip
  passes them; Exit markers say music may leave there.

- Marker rows auto-pack: labels are measured; overlapping labels move to
  a free row or a new row; at most 3 visible rows, then the marker area
  scrolls.

## 2.5 Snippets (razor)

- Razor snipping (tool, key C; or S at the playhead) cuts the sample's
  timeline into snippets. Clicking a snippet selects it.

- Snippet actions (right-click): **Save as…** (Save this snippet as a
  new sample; creates a sample with lineage "Split of X"), **Tape** to
  the snippet on the left / right (rejoin), **Delete** ("Remove this
  snippet and slide everything after it up to the snippet in front").

- **Close gap**: "slide everything after it up to the snippet in front".

- Snippets appear in the Outline panel.

## 2.6 Playlist (the core runtime container)

- A playlist is a container of **entries** plus a **mode**. Entries are
  only playlists or sequences; samples live only in Clip playlists. (In
  the UI, dropping samples into a non-Clip playlist creates Clip
  playlists for them: "Samples become a new Clip playlist.")

- Common fields: id, name, folder path, mode, entries e\[\], effects
  chain (on the mixed output), playback rules (2.6.7), voice envelope,
  owner (own, for nested playlists that live inside another playlist),
  linked-copy relationships, notes.

- **No cycles**: a playlist or sequence can never contain itself,
  directly or through other playlists/sequences. Pickers disable cyclic
  choices ("it contains this sequence").

### 2.6.1 Modes

- **Clip** (badge C): "One use of a sample with its own trim, loop and
  voice settings; usable anywhere a playlist is". Holds one sample clip:
  trim start/end (drag edges on a mini waveform), Loop setting (use the
  sample's own loop points / off), gain (dB, relative to the level
  prepared in Samples), pitch (st), variation per trigger (random gain ±
  dB, random pitch ± st), property curves over voice time, Clip effects
  (per voice).

- **Queue** (badge Q): "Plays one entry per trigger, picked at random,
  shuffled or in order (round robin)". **Pick**: Random ("Independent
  draw each time"), Shuffle ("Every entry once, then reshuffle"), Round
  robin. **Avoid repeating the last N** (Avoid last). Each entry has a
  **Weight** ("Relative chance of being picked"). Queue and Layer
  entries can be reordered by drag and via Move up / Move down in the
  context menu.

- **Switch** (badge D): "A discrete parameter picks the entry". **Switch
  by** a discrete (labelled) game parameter, e.g. Surface. Each label
  row: label, what it plays (entry picker menu: a playlist or sequence),
  per-label voice/gain button (curves), live "now" bar, Open. **When it
  changes**: Crossfade ("Fade from the old entry to the new one", with
  Crossfade ms), Next trigger ("The new label applies to the next
  voice"), Cut ("Switch immediately"), Next bar ("Switch on the next bar
  (music)"). **Change rules** table (see 2.6.2).

- **Blend** (badge S or T): "Scalars or time crossfade the entries".
  **Dimensions**: 1D ("one input sets the weights") or 2D ("two inputs
  set the weights"). **X input** (and **Y input** in 2D): a scalar game
  parameter or **time** (voice time, with **Time length (s)**). **Blend
  mode**: Crossfade ("Neighbouring entries crossfade") or Layer
  ("Entries fade in and stay"). **Gain curve**: Linear ("Gains follow
  the weights") or Equal power ("Gains are √weight: no dip
  mid-crossfade"). **While playing**: Follow ("The playing voice follows
  the value as it moves, smoothed by Glide") or Hold ("keeps the value
  it was triggered with; changes apply to the next voice"). **Glide ms**
  ("how quickly a playing voice catches up when the input jumps; 0 =
  instantly"). Per entry: position on X (and Y), **At weight 0**: Stop
  ("Stops at weight 0; starts again from the top when its weight
  returns") or Continue ("Keeps time silently at weight 0 and comes back
  mid-sound").

  - 1D: entries are nodes on a lane; weights are overlapping triangles
    between neighbours (linear weights). Drag nodes to place them; arrow
    keys nudge (Shift for bigger steps). Click or drag empty space to
    move the test value (cursor). Polygons show each entry's weight
    region; the live weights show as "Health 70% + …".

  - 2D: nodes on a plane of two inputs; weights by distance to
    neighbouring nodes (inverse-distance; weight 0 = silent); a
    triangulation (edges, spokes, active triangle) is drawn; halos scale
    with weight. Example: time × impact velocity.

  - A time axis is bounded to clip or sequence time.

- **Layer** (badge L): "Plays every entry at once". Entries reorderable;
  each has gain/curves.

- **Sequence** (badge SEQ): "Tracks of clips on a timeline, with loops,
  markers and automation". Its content is a timeline (2.7). Picking
  Sequence on another mode builds a timeline from the entries; picking
  another mode on a sequence rebuilds entries from the timeline.

- Mode summaries shown in tree, inspector and player bar: "Queue · 3
  entries", "Sequence · 4.0 s · 2 tracks", "Clip · 0.70 s · 1 effect"
  (always "N entries", never a bare number).

### 2.6.2 Switch change rules

- Table columns: **From**, **To**, **When**, **How**, **Fade / clip**,
  remove.

- A default row "Any → Any" always exists, set by "When it changes"
  (labelled "(default)").

- **From / To**: Any or a specific label. **When**: e.g. immediately /
  next beat / next bar / at Exit markers. **How**: Crossfade (with
  **Fade length** in ms or beats for music), Cut, or Transition clip
  (pick a transition clip from a menu).

- **Most specific rule wins** (exact From+To beats Any).

- This replaces the old separate Transitions screen.

### 2.6.3 Entry properties (any mode)

- Gain in this playlist (dB, relative). Gains add up along the playlists
  that contain this one; the Mixer bus comes after. 0 dB = the level
  prepared in Samples.

- Pitch (st). Pan. Low-pass / high-pass.

- **Property curves over voice time** (gain, pitch, pan, low-pass,
  high-pass), from when the entry starts. Opened in the Curves
  sub-window. Curves can be copied, pasted and reset (right-click on the
  voice button). Pasting curves for a different kind of target is
  refused.

- Weight (Queue), position (Blend), at-weight-0 (Blend), label mapping
  and label gain (Switch).

- Open (for nested playlists and sequences).

### 2.6.4 Linked copies vs independent copies

- Adding an existing playlist into another can be done **linked** ("Use
  the shared playlist itself: edits to it show everywhere it is used")
  or as a **copy** ("Add an independent copy that lives inside this
  playlist"). The picker has "Add playlists as: Linked / Copy".

- In the tree, a linked copy is drawn dashed ("Linked copy (dashed):
  edits here change the original and every other link. Delete removes
  only this link."); the original is solid ("Original (solid): linked in
  …").

- Actions: "Make shared" (give a nested playlist its own place in the
  playlist list so others can use it), "Turn this linked copy into its
  own playlist inside X" (unlink), delete link only vs delete original.

### 2.6.5 Nesting and the playlist tree

- Playlists can be nested (a playlist owned by another appears under it
  in the tree). The tree shows folders, playlists, nested playlists,
  linked copies, mode badges, meta lines, and per-row output-bus and
  link indicators.

- New playlist: "nested inside the open playlist (or in the selected
  folder when you last clicked a folder)".

### 2.6.6 Voice envelope

- An ADSR envelope applied to each voice, timed from the moment it is
  triggered ("Runs on voice time: it starts at 0 each time the playlist
  is triggered"). Envelope mode selectable (none = "entries play as
  recorded"). Looping entries are held until released (Trigger again to
  release). The preview lane: "Click or drag to preview the level at a
  moment · double-click to clear". Release marker shown.

### 2.6.7 Playback rules ("When a trigger plays, how often, and what happens at the voice limit")

Shared by every playlist and sequence (Inspector › Playback; collapsed
row with a one-line summary).

- **Output**: the Mixer bus this plays into. Inherited "from its
  folder's default" unless overridden ("Pick a bus to override"). "Open
  \<bus\> in the Mixer" link. Every playlist type can define its output
  bus (decided).

- **Plays**: Once ("Plays to the end of the sequence, then stops") /
  Until stopped ("Keeps the voice alive until the game stops it").

- **Max instances** (1–32) and **When full**: Steal oldest / Steal
  quietest / Steal farthest / Don't play ("What happens when Max
  instances are already playing").

- **Cooldown** (0–5 s): "Ignore triggers that come sooner than this
  after the last one".

- **Chance**: "Chance that a trigger plays at all".

- **Delay** (0–2000 ms): "Wait this long after the trigger before
  playing".

## 2.7 Sequence (timeline)

- A Sequence playlist holds: tracks, sequence loops and hold points,
  markers, length (sequence end), tempo (BPM + meter, optional; "No
  tempo"), parameters used, a whole-sequence effects chain, playback
  rules, plus "held" state support.

- **Tracks**: **Audio track** ("A track of clips, each one use of a
  sample") or **Playlist track** ("A track that plays a playlist (its
  clips trigger the playlist)"). Fields: name, colour, enabled, mute,
  solo, volume, pan, output, effects chain, automation lanes, track-type
  badge.

- **Clips** on audio tracks: sample reference, start time in the
  sequence, length, sample offset ("Where in the sample the clip starts
  playing"), trim start (drag), enabled, gain, pitch (−12…+12 st), pan
  (−100…+100), direction (Forward / Reverse), **timing** Sync / Async
  (2.7.1), loop overrides (2.3), marker on/off per clip, volume
  envelope, property automation, effects chain (per voice), colour.

- **Playlist clips** on playlist tracks: reference a playlist; show its
  name and mode badge; while the playhead is inside, show what it picked
  ("re-resolved each time it starts"). Double-click opens the playlist.
  Audio-track drops of playlists and cycles are refused with a toast.

- **Overlapping clips** on a track get an automatic crossfade over the
  overlap (X shape drawn).

- **Sequence end**: past-the-end area dimmed; drag the end handle on the
  ruler; typed Length field. "Sequence end · until stopped" when Plays =
  Until stopped (the sequence waits at the end until Stop).

- **Sequence stays alive** past its end while async voices still play.

### 2.7.1 Clip timing: Sync vs Async (user decision)

- Default: **Sync** for music samples, **Async** for everything else.

- **Sync**: "Locked to the sequence playhead: when this clip loops,
  leaves at an Exit marker or skips to its tail, the playhead moves with
  it". Loop decisions move the playhead: loop back at the last pass end
  while active; skip remaining passes to the tail when inactive (Finish
  pass); leave at the next Exit marker; jump/crossfade to the tail;
  re-enter from the tail.

- **Async**: "Runs on its own clock: the clip keeps looping or plays its
  tail while the sequence playhead moves on or waits at a hold point".
  Shown with its own green cursor. Not cut when the playhead passes its
  end while its loop is active; stops at its trim end otherwise, or when
  the playhead jumps back before it.

- **One driver rule**: where Sync clips with loops overlap in time, the
  one on the higher track drives the playhead; the others follow (their
  loops are ignored), show a "⚠ follows" chip, and the Inspector shows
  "⚠ Follows another Sync loop" with **Make Async**. Mirrors how FMOD
  (only timeline loop regions move the playhead) and Wwise (one music
  playlist) avoid the clash.

### 2.7.2 Sequence loops and hold points

- On the Loops row above the ruler. Drag on the row to draw a loop;
  double-click to add a hold point; buttons "Add loop at the playhead"
  and "Add hold point at the playhead". Loop start/end typed fields;
  "Make hold point: end = start".

- Use the full loop model (2.3): Active Always / While held / Parameter,
  Exit, Exit fade, Re-entry.

- Hold points draw a dashed line across all tracks.

- Playback simulates them: Play sets held; Release (button or Space)
  releases; Parameter loops read the Game parameters panel live;
  re-entry jumps back.

### 2.7.3 Automation and curves in sequences (FMOD-style)

- A curve automates one property and is **driven by Time** (clip-local
  time for clip curves, sequence time for track lanes) or by a **game
  parameter** (X = the parameter's range).

- Clip curves live on the clip and move with it. Track curves are lanes
  that fold out under the track header (caret): each lane shows property
  name, live value, Driven by (Time or a parameter), hide, remove, open
  in curve editor. Parameter lanes show min/max labels and a live marker
  at the parameter's value.

- **Clip volume envelope**: drawn over the waveform (amber) and shapes
  the drawn waveform; double-click the clip to add a point; drag points;
  double-click a point or Del to delete. Clip header chip names the
  shown curve; the Inspector › Automation eye picks which curve is shown
  on the clip.

- **Automatable properties**: Enabled (on/off target: Hold steps, snaps
  to On/Off), Volume/Gain, Pitch, Pan, and every effect parameter.
  Automated controls show the live value and are locked.

- **Curve point shapes** (apply to the segment after the point): Linear,
  Ease in, Ease out, S-curve, Hold. Right-click a point for the shape
  menu, Copy, Delete. Shift/Ctrl-click multi-select; drag moves
  together; Del deletes; Ctrl+C / Ctrl+V paste into the selected point's
  curve (time curves at the playhead, parameter curves at the copied
  position), replacing points in the pasted span. Esc clears.

- **Write automation** (W): toolbar record button. While armed ("●
  Writing automation"), moving any automatable control writes a Time
  curve at the playhead (creates it if needed, seeding start/end at the
  previous value; touch mode overwrites what the gesture passes; keeps
  writing while a slider is held during playback). Parameter-driven
  curves are not written. One history step per gesture.

- **\[Planned\]** marquee selection for automation points, curve tension
  handles, Latch/Read automation modes. Automation lanes for the
  whole-sequence chain.

## 2.8 Effects and effect levels (decided)

A chain lives either on something that plays one sound (a clip) or on
something that mixes sounds (playlist, sequence, track, bus). Entries of
Queue/Switch/Blend/Layer are not their own level: each entry is a clip
or a sub-playlist and uses that thing's chain. Mixing points run on the
mixed signal (FMOD-style), not per voice.

| **Level**                                     | **Runs on**                        | **Cost**                             | **For**                                                                                              |
|-----------------------------------------------|------------------------------------|--------------------------------------|------------------------------------------------------------------------------------------------------|
| Sample                                        | Baked offline into a cached render | Free at runtime                      | Fixes that are the same every time; automation over sample time only; game parameters can't drive it |
| Clip                                          | One voice                          | One instance per voice               | One sound, changed per use or by a game parameter                                                    |
| Playlist (any mode, incl. Layer) and sequence | The mixed output                   | One per playing playlist             | Glue for a group (a compressor glues layers)                                                         |
| Sequence track                                | The track mix                      | One per track (per playing sequence) | Same, for one lane                                                                                   |
| Bus                                           | Everything routed to it            | One per bus, always running          | Mix categories, reverb, ducking, limiting                                                            |

- Every chain shows a "Runs on …" line with its cost.

- A Clip playlist used as an entry shares its chain with every playlist
  that uses it.

- **Move-up hints**: when every clip in a playlist (or on a sequence
  track) has the same effect, a "Move to playlist" / "Move to track"
  button moves it up ("Moving it here runs it once on the mix instead of
  on each voice"; warns if some of those clips are used elsewhere and
  would lose it there too).

- Effect card UI (shared): name, bypass checkbox (on/bypassed chip),
  expand caret to show each parameter as slider + typed field, Automate
  button per effect (curves over time or a game parameter, plus on/off
  bypass curve), move up / move down ("effects run top to bottom"),
  remove ("also removes its automation"). Add effect menu: searchable,
  categories, keyboard (type to filter, ↑↓, → opens a category, Enter
  adds, Esc closes); the Samples Add menu previews an effect on the
  waveform before adding it.

- **Effect catalogues** (parameters with ranges are in Appendix B):

  - Sample (baked): EQ, Filter (high-pass + low-pass), Compressor, Gain,
    Pitch shift, Fades, Saturation, Noise reduction, Reverse. Each
    effect type has a version number stored with its parameters.

  - Clip / track / sequence / playlist: Amp envelope (ADSR, per voice),
    EQ, Low-pass, High-pass, Band-pass (filters have Drive), Compressor,
    Saturation, Distortion, Bit-crush, Formant shift, Pitch shift, and
    on tracks/sequence/playlist only: Delay, Reverb (per-voice cost too
    high on clips).

  - Bus: EQ, Low-pass, High-pass, Band-pass, Compressor, Sidechain
    compressor (with Key bus), Limiter, Saturation, Distortion,
    Bit-crush, Formant shift, Pitch shift, Delay, Reverb.

  - Hz sliders (cutoff/centre) are logarithmic; fields stay in Hz.

## 2.9 Bus graph (Mixer)

- **Master**: the output; everything ends here; always hosts an
  ambisonic bed.

- **Buses**: tree under Master (e.g. SFX › Vehicles › Engine; SFX ›
  Footsteps; SFX › Weapons; Ambience › Rain; Dialogue; Music; UI).
  Fields: name, parent, level (dB, −60…+6), mute, solo, colour, voice
  limit (Inherit / Limit N: "Caps every sequence routed into this bus"),
  bed (Share / Own with priority), VCAs it belongs to, effects (inserts,
  run top to bottom, before the fader), sends (post-fader), ducking
  rules, automation of level by game parameters.

- **Returns** (e.g. Reverb): fed by sends; output to Master; "A return
  is not a child of the buses that feed it: they keep their own
  routing"; returns take the bed of the buses that feed them.

- **VCAs** (e.g. Gameplay SFX): control the level of several buses; "No
  audio passes through a VCA".

- **Voice limits**: "Nothing above caps this bus" / "Use the limit of
  the nearest bus above" / "Cap this bus and everything under it".
  Inherited limits shown with ↑.

- **Ambisonic beds** (engine model): a bed is a shared surround field
  hosted on a bus. Master always hosts one and it counts toward **Max
  beds** (project setting). Other buses can ask for their own bed with a
  priority; when more buses ask than Max beds allows, the highest
  priorities win; losers share the nearest host above them. Bed summary
  chip "Beds 2/2 · 1 sharing". Distant sounds are mixed into the bed and
  decoded once.

- **Sends**: copies of the bus signal to a return, after the fader, with
  a level slider.

- **Ducking**: "Turn this bus down while another bus plays". Per rule:
  Ducked by (source bus), When (While playing / Above level with
  threshold dBFS), Duck by (dB), Attack, Release, on/off.

- **Sidechain compressor**: Key = "The bus whose level drives this
  compressor".

## 2.10 Snapshots

- A snapshot stores bus level changes (v: {busId: dB}) applied on top of
  the base mix while active.

- Fields: name, folder, levels, trigger, priority, combine mode,
  transition.

- **Trigger** ("Starts"):

  - **When conditions match**: "Active while \[all \| any\] of these are
    true", followed by condition rows. Each condition = game parameter +
    comparison + value. Comparisons by parameter type: number (is below,
    is at most, equals, is not, is at least, is above, is between A and
    B), true/false (is true, is false), state/enum (is, is not), text
    (is, is not, contains, starts with). Each row shows a live dot:
    true/false right now against the test values.

  - **Always (base mix)**: always active; every other snapshot applies
    on top of it.

  - **From game code**: started and stopped by calls, e.g.
    Mixer.Snapshot("Gameplay").Start() / .Stop().

  - **Never (audition only)**: never starts by itself; audition it in
    the studio by selecting it.

- **Transition**: Fade in (ms), Fade out (ms), Hold at least (ms: "Stay
  active at least this long once started, so a value hovering at the
  threshold doesn't flicker the mix").

- **Conflicts between active snapshots**: **Priority** (integer, higher
  wins) and **Combine**: Override ("higher priority wins" on buses both
  change) or Add ("dB changes stack"). Same-priority override clashes:
  "the one that started last wins" (flagged as a warning). Reference
  behaviour: FMOD orders snapshot priority by the snapshot list and has
  overpowering vs blending snapshots; Wwise state groups are exclusive
  within a group and additive across groups.

- **\[Planned\]** The engine must resolve all active snapshots with
  these rules (the prototype only previews the resolution in the dialog;
  its live mix applies only the snapshot being edited). **\[Open\]**
  exclusive groups (only the highest-priority snapshot in a group can be
  active).

## 2.11 Non-destructive sample editing (edit graph)

- Core rule: source audio never changes. Edits are stored as data.
  Renders are disposable caches.

- Every edit is a parameterised operation on its parent (trim,
  normalize, reverse, splice, fades, effects). The imported source is
  the root. Structure is a tree today; plan for a DAG (operations with
  several inputs: mixdown, crossfade, splice from other sources).

- A forked sample = source reference + operation chain + cached render.
  Forks reference the source (content-addressed storage), never
  duplicate it. Byte deltas are rejected.

- Cache key = hash(input audio + operation parameters + effect version).
  Going back to an earlier state reuses its render if still cached.
  Renders rebuild lazily (only what is used or playing), in the
  background, with live preview.

- **Freeze**: pin a render as fixed audio (protects against effect/DSP
  version changes).

- **Flatten**: render effects into a new source version and clear them
  (source stays in the version list).

- **Fork as new sample** (Ctrl+Shift+S): new sample referencing this
  one's source and edits; no audio copied. Dependency mode per fork:
  **Follow** (tracks the parent's latest state; "Parent changed" note)
  or **Pin** (stays as the parent is now until "Update").

- **Source versions** (re-import): position-based operations are
  re-checked after a switch; broken ones are flagged ("N items past the
  end of source vN" with Select / Fit to vN / Use previous version),
  never failing silently. Old source audio is garbage-collected only
  when nothing references it.

- **Deletion**: a node with dependents can't be hard-deleted (block, or
  keep audio hidden while referenced).

- **A/B**: hear the source with every edit bypassed vs the edits.

## 2.12 WAV metadata round-trip

- On import the studio reads the WAV's own chunks (cue, labl, ltxt,
  smpl, acid, bext): cues (markers), regions, sampler loops (with
  direction and play count), tempo, root note.

- Imported items keep a link to the file and show a small file badge on
  the timeline. Moving a file cue makes the Inspector show it differs
  from the file, with **Revert** to the file's value.

- **File changed on disk** dialog: "The audio is reloaded either way.
  For each change to the file's cues and loop, choose what the project
  keeps. Markers you added in the project are never touched." Per
  change: Keep / take the file's value; **Later** / **Apply**.

- **Write to file** ("Review before saving…"): "Changes the WAV on disk
  so other tools see the same markers; the audio isn't touched. Cue and
  Hit markers are written as plain cues with their name." Shows exactly
  which chunks will be written; option "Keep a backup of the original
  (.wav.bak)".

- **Detach from file**: stop tracking the WAV for the whole sample.

## 2.13 Undo and history

- **Per-sample undo tree** for that sample's edits (every edit records a
  step: markers, loops, trim, tempo, root, effects; sliders commit on
  release/blur).

- **Project history** for creating, deleting, renaming and moving
  samples, and for timeline/sequence/playlist edits.

- **Spanning steps** for operations touching several samples (one
  project step pointing to entries in each sample's tree; undone
  together).

- Ctrl+Z follows focus, and the undo tooltip names the target: "Undo:
  trim (Kick_02)".

- History popover (every screen): every step, with branches; click one
  to go back to it; "Editing after an undo starts a new branch, so
  nothing is lost". Step states: current, earlier ("click to undo back
  to here"), undone ("click to redo to here"), other branch ("click to
  switch to it").

- Screens with history: Samples (per sample), Playlists (per playlist,
  plus the sequence timeline's own history), Mixer (every edit, with
  branches; snapshot edits named), Spatial (every scene edit).

- **\[Open\]** unify the undo tree and the fork tree (forking =
  promoting an undo branch to a named asset) or keep two linked systems.
  **\[Planned\]** Playlists undo should include timeline edits
  (currently separate).

## 2.14 Game parameters

- Defined by the project/game and dynamic (not a fixed set). Types:
  **number** (with unit, range and step; e.g. Health %, Threat 0–1, Time
  of day h, Water depth m, Speed, RPM, Brake, Boost, Intensity, Impact
  velocity, Stamina, Pressure), **true/false** (e.g. In combat), **enum
  state** (e.g. Game state: Playing, Paused, Cutscene, Loading; Surface:
  Dirt, Gravel, Wood, Metal, Water), **text**.

- Everywhere a parameter is picked, it is a dropdown listing the
  project's parameters with their type, never a fixed toggle group.

- Test values: each screen that uses parameters has a panel of test
  values (sliders + fields, checkboxes, dropdowns) so you can hear and
  see behaviour without the game. During Play, values come from the
  running game (or from a replayed take).

## 2.15 Test scenes (Spatial)

- A test scene contains: listeners (one active "listening player"),
  emitters (static or moving on a path), 2D sounds (no position),
  obstacles (material, size, rotation, height range), audio zones,
  reverb zones, scene settings.

- Created from: Blank scene ("One listener, nothing else"), From current
  test scene, From open game scene, From take… ("Positions at the take's
  playhead").

- Emitter sound: by default the sound the game scene assigns; can be
  replaced for testing without changing the game scene (A/B compare).

## 2.16 Takes and captures

- **Take**: a recorded gameplay run: picture frames, game parameter
  lanes (Speed, RPM, Surface…), sequence instances (when each
  started/ended, sustain spans, which playlist variant played), events.
  Read-only for audio content; replaying it drives your current sounds
  with its recorded values.

- **Capture** (Profiler): a take plus debug data: voices, load (voices,
  CPU), effect instances, bus gain, loudness, message log, version info
  (sounds edited during Play), "why it played" reasoning.

- Take and Profiler share the playhead/replay position (localStorage key
  myco.review in the prototype); "Open in Take at the same playhead".

- Opening files: "Open take file…", "Open capture file…" into the
  selected folder. Record captures the running game as a new
  take/capture.

# 3. Application shell (shared by every screen)

## 3.1 Screen layout, top to bottom

1.  **Header bar**: app mark + "Audio Studio" title; grouped navigation
    tabs; the audio-device chip at the right.

2.  **Dock area**: the screen's panels (left dock, centre, right dock,
    bottom docks).

3.  **Player bar**: everything that plays (3.5).

4.  **Status bar**: engine status (3.6).

## 3.2 Navigation

- Tabs in three groups separated by thin dividers: Author (Samples,
  Playlists) \| Mix (Mixer, Spatial) \| Run (Take, Profiler). The active
  tab is underlined in the accent colour. Tooltips show the shortcut
  ("Samples (Ctrl/⌘+1)").

- Shortcuts Ctrl/⌘+1…6 switch screens from anywhere.

- The game session keeps running when you switch screens.
  Playback/transport state that belongs to a screen stays with that
  screen.

- **Deep links** between screens: "Open in Samples ›" (from clips and
  Library), "Open in Playlists" (from Take, Profiler), "Open \<bus\> in
  the Mixer" (from playback rules, Profiler), "Open in Take at the same
  playhead" (from Profiler), "Open sequence ›" (Take). Links carry the
  object to select.

- Sequences have no tab of their own: they open inside Playlists.

## 3.3 Audio device chip and calibration

- Chip shows the output device and its measured latency, e.g.
  "Headphones −16 ms ▾" (or "Not calibrated"). Tooltip explains.

- Menu: **Output device** dropdown (e.g. Headphones · USB interface,
  Studio monitors · USB interface); **Buffer**; **Audio offset** (ms);
  **Visual offset** (ms); **Calibrate…**.

- **Calibration dialog** (modal, aria-modal): "Calibrate by" **By ear**
  ("Tap along to clicks to measure how late sound reaches you on this
  device"; "Tap when you hear each click, on the device you play with.")
  or **By eye** ("Tap along to flashing boxes to measure how late the
  picture reaches you"; "Tap when each box lights."). A big tap target
  ("Tap on the beat", Space or Enter). A scale from "150 ms early"
  through "on the beat" to "150 ms late" with one dot per tap. Result
  "Offset". Buttons Start over, Cancel, Use. Calibration is stored per
  output device.

- Used by: timing of auditioning, tap tempo, visual sync of playheads,
  rhythm features.

## 3.4 Dock system (every screen)

- Panels live in docks: left, right, bottom-left, bottom-right, and a
  fixed centre panel per screen (the centre panel can't be closed). Each
  screen defines a default layout (DKDEF) and the panel names it allows.

- **Panel header**: title (alone on its own row), close ×, collapse
  chevron. Right-click / long-press the header opens the **Panel menu**
  (.cmenu): show hidden panels, move panel to another dock, reset
  layout.

- **Tabs**: several panels can stack in one dock as tabs. A collapsed
  dock folds into a **vertical tab strip** (e.g. "SCENES \| OUTLINE" on
  Spatial's left edge); clicking a tab opens it.

- **Drag to redock**: drag a panel header (or tab) to another dock or
  stack. Works with mouse and touch (pointer events).

- **Resize**: drag the splitter handles between docks and between
  stacked panels. On touch the handles have an 8 px invisible margin.

- **Persistence**: the layout (which panels are where, sizes, collapsed
  state) is saved per screen (prototype: localStorage
  myco.dock.\<screen\> with keys samples, take, mixer, playlists,
  profiler, sequencer, spatial). Validation accepts a saved layout if
  its panels are a subset of the screen's default panels plus its
  allowed names (so a closed panel doesn't invalidate the save). **Reset
  layout** restores the default.

- **Narrow screens**: below 1280 px wide, side panels scale down
  (minimum 170 px) so the centre keeps most of the width. **Tablet
  layout**: when the dock area is under 900 px wide and both sides have
  panels, the left dock folds to its vertical tab strip; opening it
  keeps it open until the screen is wide again. Desktop is unchanged.

- Panels never make the window overflow; contents scroll inside the
  panel.

- **Responsive panel contents** (all screens): label columns in
  inspectors shrink with the panel (label width = min(fixed px, ~34% of
  the panel)); number fields keep a 46 px minimum and timecode fields 74
  px; rows of values and button rows wrap instead of overflowing; button
  text stays on one line; long words break; multi-field rows (e.g. X/Y)
  go two per row when wide and stack when narrow.

- **Popovers and menus inside a panel** raise that panel above its
  neighbours while open, so they always render in front.

## 3.5 Player bar (bottom of every screen; decided "Layout A")

- One bar for everything that plays, above the status bar. Three equal
  columns so the main button stays centred.

- **Left: now-playing card**: type badge (WAV, SW, SEQ, MIX, 3D, TAKE…),
  name, one-line summary with the real length. On Samples also a mini
  waveform with the playhead.

- **Centre: the screen's main action + scrubber**:

  - Samples: scope pill (play mode menu, 4.1.10) and big Play/Pause;
    draggable time slider (keyboard: ←/→ step, Shift bigger, Home/End,
    PgUp/PgDn tenths; announces min/max/value).

  - Playlists: **Trigger** (Space) with ◂ ▸ (previous/next voice start
    or end) and pause; the voice strip is the scrubber ("Drag to preview
    the playlist at any point (pauses the trigger)"; bars are this
    trigger's voices). Trigger is disabled when there is nothing to
    trigger ("Make a playlist to audition it", "Add entries to this
    playlist to trigger it"). The bar follows the open playlist. Stop
    shows only while something plays; a paused trigger shows Trigger
    (fresh start) and Resume continues it. For a sequence: "Plays the
    sequence's timeline; its playhead is in the editor above".

  - Take and Profiler: Back to start, Replay ("play the recording back;
    its values drive your current sounds"), Record ("capture the running
    game as a new take, while the game session plays"), Loop, scrub
    slider, length "00:32.000".

  - Mixer and Spatial: the big button is the **game session** (Space)
    ("The game session is the main button on this screen"). Card:
    "Snapshot · plays the game session through this mix" / "Test scene ·
    plays the game session in this scene".

- **Right**: a short status line that says what is next ("Changes play
  in the game right away", "Start the game to hear changes", "Game
  running · Record to capture it", "Replay, or start the game to
  record", "● Recording a new capture"), the always-visible **Game
  session** button (play/stop the game; "it keeps running when you
  switch screens"), and **Linked to game** ("Edits go to the running
  game").

- Narrow screens: game session collapses to a round button; the bar gets
  a little taller; Playlists splits the time left and right of the
  strip.

## 3.6 Status bar (read-only)

- "Rust core · 48 kHz", "Voices N / 4,096", "CPU x%", "Session
  hh:mm:ss.mmm" (on Mixer/Spatial), "Device OK", "Voice cap: full",
  "Meters: live", "Saved".

- **\[Sim\]** values are placeholders; must come from the engine.

## 3.7 Game session and live editing

- The studio links to a running game ("Linked to game"). Edits go to the
  running game immediately.

- Starting the session from any screen; it keeps running across screens.
  Mixer/Spatial use it as their main action; Take/Profiler record from
  it.

- Edits made while the game plays are kept after Stop ("3 edits kept"
  chip in the Mixer).

- Structural edits during Play apply to the next instance; Take/Profiler
  can "Restart instances" so playing copies pick up the new version
  ("Changed during Play: restart the playing copies with the new
  version"). Profiler marks voices as Old version / Current version
  relative to the edit time.

## 3.8 Keyboard

- Global: Ctrl/⌘+1…6 screens; Ctrl/⌘+Z undo, Ctrl/⌘+Shift+Z or Ctrl+Y
  redo; Space = the screen's main play action (Play / Trigger / game
  session); ? opens the Keyboard shortcuts dialog; F6 moves between
  panels; Esc closes menus/dialogs/tools.

- Shortcut labels are platform-aware ("On a Mac, Ctrl means ⌘ and Alt
  means ⌥").

- **Single-key shortcuts toggle**: letter/number/symbol keys (M, S, C,
  I, O, L, Z, \[, \], ?, +, −, 0) act on their own; can be turned off
  for speech input or accidental presses; every action stays available
  from buttons and menus.

- Trees and menus: arrow keys move, → / ← open/close or go to parent,
  typing a letter jumps to the next row starting with it, Enter
  activates, F2 renames, Shift+F10 opens the context menu.

- Rows are keyboard-reachable; focus rings on all screens; a live region
  announces changes.

- **\[Planned\]** command palette (Ctrl/⌘+K) listing every action with
  rebinding (recommended in the UX review).

## 3.9 Shared list / tree behaviour

- One list toolbar pattern: search field (placeholder "Search …";
  results show each item's folder path), + (primary add) with a ▾ split
  menu ("More: …, New folder"), Collapse all.

- New items go into the selected folder (or the top level). "⤒ Top
  level" target.

- Rows: caret, icon/badge, name, meta (muted, right), hover actions.
  Double-click a folder name to rename (F2 too). "Drag onto a folder to
  move it · right-click for more · F2 renames". Folders show item
  counts.

- Deleting a folder moves what's inside up a level ("Delete folder
  (what's inside moves up a level)").

- **Context menu** (right-click or long-press): Rename, Duplicate
  (Ctrl+D), Move to…, Move to top level, Delete (Del), and Undo for the
  last list action, plus item-specific actions.

- **Move to… dialog** (modal): "Move "\<name\>" to", search folders
  field, folder list (indented; current folder marked and disabled;
  invalid targets disabled), "No folders match", Cancel. Exists because
  HTML drag-and-drop doesn't work on touch.

- Multi-select (Playlists tree): selection bar with Move to folder,
  Duplicate (Ctrl+D), Delete… (Del), Clear selection (Esc).

- Alphabetical ordering everywhere.

- Empty states: one short line saying what to do ("No playlists or
  folders yet. Use + to make a playlist; New folder is in its ▾ menu.").

## 3.10 Touch and tablet support

- **Long-press = right-click**: a 550 ms long press with the finger
  still opens the same context menu; doesn't double-fire on Android;
  suppresses the following tap.

- **Coarse-pointer targets**: icon buttons ≥ 30 px; buttons, inputs,
  selects ≥ 32 px; tree/list/menu rows ≥ 36 px; checkboxes/radios 20 px;
  sliders 30 px hit area; segmented/choice buttons and dropdown rows
  larger.

- **No hover-only controls on touch** (selected-item toolbars, delete
  buttons, previews are visible when relevant).

- No double-tap zoom delay on controls (touch-action: manipulation); no
  iOS callout/text selection on rows and buttons; scrubbers and custom
  sliders use touch-action: none.

- **Keyboard-safe floating fields**: when an on-screen keyboard opens, a
  focused field inside a floating menu, popover or dialog is moved into
  view (top ~42% of the visible viewport on touch inside an embedded
  frame), using the visual viewport size (--vvh).

- **Reorder without drag**: Move up / Move down in context menus; "Move
  to…" for folders.

- **Spatial gestures**: two-finger drag pans the grid; pinch zooms
  around the fingers; one-finger drag on empty grid pans (Select tool);
  tap selects; emitters need tap-to-select or long-press before they
  drag (4.4).

- Tooltips can't be seen on touch, so anything essential must be visible
  text.

## 3.11 Dialogs, menus and popovers (shared rules)

- Dialogs put Cancel before the primary action. Modal dialogs set
  aria-modal. Esc closes. Max size fits the visible viewport.

- Dropdowns inside dialogs open as in-app floating lists right under the
  field (not native pickers), do not resize the dialog, flip above when
  there's no room below, and close on outside click / Esc.

- Popovers float at the root (absolute, clamped to the window), not
  inside panels.

- Menus share one look (.cmenu, .tci items, separators full width, check
  marks for the current choice).

## 3.12 Colour picker (shared)

- Presets + saved user colours (one project-level palette; "Saved
  colours appear as swatches in every colour picker · right-click a
  saved swatch to remove it") + Custom colour… (saturation/brightness
  square, hue strip, hex field, keyboard: arrows, Shift bigger steps,
  Home/End), Save, Apply. Floating popover anchored to its button.
  Fixed-colour items get no picker.

## 3.13 Accessibility

- WCAG AA contrast for text in both themes (tokens adjusted: light muted
  \#5a615f, faint \#656b67, accent \#0a7075, accent2 \#3e7210; dark
  faint \#858885). **\[Planned\]** update the Myco design-system
  tokens.json to match.

- Every icon-only button has an accessible name; every input has a
  label; custom sliders expose value/min/max.

- Reduced motion: transitions and animations off when the OS asks.

- States are never colour-only: shapes, patterns or icons + tooltips.

- **\[Planned\]** a global Info pane (toggle ? or F1, docked in the
  status bar) showing the long description of whatever is hovered or
  focused, so no essential knowledge is tooltip-only.

## 3.14 Time formatting rules

- **Positions** (playheads, markers, ranges, trigger times, readouts,
  session clocks): timecode 00:00.000, following the project timecode
  setting.

- **Lengths in lists**: under 1 s in ms; under 60 s as one-decimal
  seconds ("16.0 s"); longer as m:ss ("2:10").

- **Rulers**: short seconds ticks (0, 0.6 s, 4 s); m:ss only past a
  minute.

- **Voice time** (Playlists strip, Plays now): seconds.

- **Time display menu** (timelines): Timecode ("minutes, seconds and
  ms"), Samples ("sample frames (48 kHz)"), Bars ("bars and beats from
  the tempo"; needs a tempo). It also sets the ruler and grid.

# 4. Screens

## 4.1 Samples (Author · Ctrl/⌘+1)

Purpose: prepare each audio asset once, so every clip that uses it
inherits good defaults: trim, loops, markers, tempo, root note,
loudness, baked cleanup effects, and WAV metadata kept in sync with the
file on disk. The most mature screen; the reference for timeline UI.

### 4.1.1 Default layout (panels)

- Left dock (tabs, foldable to a vertical strip): **Samples** (folder
  tree) and **Outline**.

- Centre (fixed): **Sample** timeline.

- Below the timeline: **Edits** (sample effects) and **Loop seam**.

- Right dock: **Inspector**.

### 4.1.2 Samples panel (tree)

- Toolbar: search ("Search samples by name; results show each sample's
  folder"), **Import** (+; "Import samples… (or drop audio files on this
  panel)"), ▾ More (Import samples… "Add audio files to the selected
  folder"; New folder "Inside the selected folder, or at the top
  level"), Collapse all folders.

- Rows: folders (caret, name, count, colour, delete button "what's
  inside moves up a level") and samples (name, meta line e.g.
  channel/length, file-state badges). Drag samples/folders onto folders;
  drop audio files from the OS onto the panel to import; double-click to
  rename; F2 renames; right-click: Rename, Duplicate, Move to…, Move to
  top level, Colour, Delete. Folder menu with colour.

- Delete sample dialog: "Remove from the project (the file on disk
  stays)"; warns when the sample is used ("used by N
  playlists/sequences").

- Empty project state: "No samples yet" + **Import samples…** button.

- Keyboard: ↑↓ move between samples and folders; → / ← open/close or go
  to parent; letter jumps; Ctrl+C / Ctrl+V / Ctrl+D copy, paste here,
  duplicate.

### 4.1.3 Import dialog (modal, "Import samples")

- Fake-in-prototype, real-in-product file picker: a folder tree of the
  disk location (e.g. ~/Audio/GameSFX) with checkboxes. A folder
  checkbox selects everything under it ("click to select everything
  inside"); Select all ("Select everything not yet imported"); Expand
  all; files already in the project are dimmed and marked "imported"
  ("Already in this project").

- Per file: name, format facts (48 kHz · mono · 3.20 s), and a summary
  of the WAV metadata it carries (cues, regions, loops, tempo, root):
  "These come from the WAV's own chunks (written by Reaper, Sound Forge,
  a sampler editor…). Imported items keep a link to the file."

- **Import settings**: Load (Decode on load / Stream), Format (Original
  WAV / Vorbis / AAC), Sample rate (Keep 48 kHz / Downsample to 24 kHz).

- **Into folder**: folder picker with search ("browse or type to
  search"; Enter picks the first match or creates the folder). **Keep
  the source folder structure** ("Recreate the folders from disk inside
  the target folder").

- Button "Import N" (disabled with a reason: "Tick folders or files to
  import", "Everything here is already imported").

### 4.1.4 Outline panel

- A filterable list of everything on the open sample's timeline,
  grouped: Markers (by type: Notes, Exit, Hit point, Cue), Loops
  (Pickup, Loop 1…, Links, Tail), Trim, Snippets. Filter field ("Filter
  markers, loops and snippets by name"; "Filter 1 item" singular).
  Collapse all groups.

- Each row: name, time/range, source badge (from WAV / project), state
  ("Outside the trim · won't play"). Clicking selects and scrolls the
  timeline. Empty group hints: "None · double-click a marker row to add
  one", "None · set a marker's Type to Exit"…

### 4.1.5 Sample timeline toolbar (left to right)

- **Save** (icon-only) split button ▾: Save (Ctrl+S), Fork as new
  sample… (Ctrl+Shift+S; "Fork: a new sample that references this one's
  source and edits; no audio is copied"), Review before saving… ("See
  exactly which chunks will be written, and choose whether to keep a
  .wav.bak backup"). Save writes project data; "cues / file" chip shows
  what Save will write.

- **Keyboard shortcuts** (?).

- **Undo / Redo / History** (per-sample tree; tooltips name the step and
  sample).

- **Source version** dropdown (v1 / v2 / F1): list of versions with
  length; switching is undoable ("your edits stay and rebuild on this
  audio"); **Re-import…** adds the next version.

- **A/B** toggle: hear and show the source with every edit bypassed vs
  with edits ("Hearing and showing source vN without edits · click to
  show the edits").

- **Root note** chip + popover: note+octave field ("Note and octave,
  e.g. C3, F#2, Bb4"), fine tune cents, source chip (from WAV / detected
  / set), Detect, revert.

- **Normalize** chip + popover: Off / Loudness / Peak, Target, Gain;
  measured loudness; clip warning.

- **Add marker** (M, at the playhead).

- **Add loop**: in the largest free space; also double-click the pickup,
  a link or the tail ("Plays pickup → each loop in order → tail").

- **Razor snipping** (C): click the waveform to snip; S snips at the
  playhead; Esc stops.

- **Snap** split button: on/off + increment menu (time steps, or beats
  when a tempo exists; Custom: "Beats: a number or a fraction, e.g. 0.5
  or 1/3 (triplets)"); **Snap to zero crossings** ("Move trim and loop
  points to the nearest zero crossing, to avoid clicks").

- **Time display** menu (Timecode / Samples / Bars).

- **Tempo** chip: BPM field, meter (defaults 4/4), source chip (WAV /
  detected / set; "Replace the current value with the detected one",
  "Find the tempo and beats by analysing the audio"), **Tap tempo**
  dialog ("Tap on each beat (Space, Enter or T)"; dots show each gap vs
  the average ±15%; averages the last 8 taps; a pause over 2.5 s starts
  a new count).

- **Warnings** chip (when present): e.g. "N markers outside the trim
  won't play" (Move the trim so these play / Delete the markers outside
  the trim), loop "level jump" at the seam (Select the loop and show its
  seam / Lengthen this loop's crossfade), "N items past the end of
  source vN" (Select / Fit to vN / Use previous version).

### 4.1.6 Timeline body (top to bottom)

- **Marker rows**: "Markers" header with Add marker; one typed marker
  set auto-packed into up to 3 visible rows (then scroll; tooltip says
  how many hidden). Hover open space shows a ghost marker ("Double-click
  to add a marker"). Marker caps draggable; ranges have two caps. Dotted
  guides from every marker and range edge run down over the waveform,
  coloured like the marker (muted/selected) and follow marker scroll.

- **Ruler** with the playhead triangle; "Click or drag to move the
  playhead"; ticks per the time display.

- **Structure row**: Pickup \| Loop 1 \| Link \| Loop 2 \| … \| Tail
  (Pickup/Link/Tail read-only bars; loops draggable: body moves, edges
  resize; icon glyph for Active mode; repeat count; hold points as a
  zero-width mark "the playhead parks here while active", draggable
  open). "No loops (optional) · double-click to add one".

- **Trim row**: amber trim bar with draggable edges ("Trim: audio
  outside never plays · drag edges"); double-click resets to full
  length.

- **Audio lane**: header "Audio" with format line ("48 kHz · mono · 2.60
  s"), view toggles **Waveform** and **Spectrogram** (one always on;
  both = split view), lane per channel. Waveform reflects baked effects,
  normalize and gain; red ticks where peaks exceed 0 dBFS; outside-trim
  regions dimmed. Snippet boundaries and snippet bars; "⇤ Close gap"
  control between snippets. Razor cursor when the tool is on.

- **Zoom bar**: Zoom out (−), Zoom in (+), Zoom to selection (Z), Fit (0
  or double-click the scrollbar), and a range scrollbar ("drag to scroll
  · drag an end to zoom · double-click to fit"). Ctrl+wheel zooms;
  Shift+wheel or a sideways swipe scrolls.

- **\[Planned\]** vertical zoom and a dB ruler on the waveform;
  per-channel view options.

### 4.1.7 Edits panel (sample effects, baked)

- Header line: "Baked into the sample · no runtime cost" (tooltip:
  rendered offline, source never changed, every clip gets them, game
  parameters can't drive them).

- Toolbar: **Add effect ▾** (searchable menu with categories; previews
  the effect on the waveform before adding), **Freeze** toggle ("keep
  the current render as fixed audio, safe from effect updates"),
  **Flatten** ("render into a new source version and clear them; source
  stays in the version list; Undo brings the effects back"), **render
  chip**: Source only / Rebuilding… / Cached / Frozen (tooltip: cache
  size + key: "source + every edit's settings + effect versions").

- List (top to bottom = processing order):

1.  **Source vN** root row (locked; "the imported audio, never changed ·
    click to switch versions or re-import").

2.  **Trim** and **Closed gaps** (locked rows; edited on the timeline;
    click selects the trim).

3.  Effects: checkbox bypass, name, chip (Rendered / Bypassed / Frozen),
    expand to sliders + typed fields per parameter, Automate (curves
    over the sample's time; rendered into the audio), move up/down,
    remove ("Undo brings it back"). Clicking an effect shows "the
    waveform after this step".

4.  **Normalize** last (locked; "Applied last, after the effects · click
    to open Normalize").

- Every change is a step in the sample's undo tree (sliders on release).

- Effects: EQ, Filter, Compressor, Gain, Pitch shift, Fades, Saturation,
  Noise reduction, Reverse (Appendix B).

### 4.1.8 Loop seam panel

- Shows the end of the selected loop flowing into its start (the jump),
  ±N ms around the seam, so you can see and hear clicks.

- Controls: own ▶ Play across the seam ("the end of the loop into its
  start"), Repeat ("keep cycling through the seam"), seam playhead
  readout (relative to the seam), scrub ("Click or drag to scrub across
  the seam").

- Readouts/chips: **At** (seam position), **Level jump** (dB difference;
  "The levels match across the seam" when fine), **Crossfade** (ms,
  editable), **Loop length**. "Points snap to zero crossings" when
  that's on.

- Empty state: "No loop on this file. Add one with Add loop in the
  toolbar to tune its seam here."

### 4.1.9 Inspector (content follows the selection)

- **Selected marker**: Type (Note / Exit / Hit point / Cue), Name (only
  when editable), At or Range start/end timecode fields ("type a
  timecode"), Colour (only when not fixed; colour picker), Note ("Shown
  on hover"; Enter for new line, Ctrl/⌘+Enter keeps). Actions: Convert
  to range, Delete marker (Del). File-tracked items show their file
  value and **Revert**.

- **Selected loop**: Range, Repeats (∞ / Times + count), Active (Always
  / While held / Parameter), Binding ("Per clip": "Bound per clip in its
  sequence (Playlists)"), Exit (Jump now / Finish pass / Crossfade) and
  Exit fade, Re-entry (Ignore / Re-enter), Direction (Forward /
  Alternating / Backward), crossfade; Remove loop ("with no loops the
  file plays once from trim start to trim end").

- **Selected snippet**: name, range, Save as… (folder picker; "Save
  snippet as sample" dialog with Name and Folder), Tape left/right,
  Delete.

- **Source** section: what came from the WAV and its state; per-item
  revert ("Revert X to the file's value (Y)"); **Detach from file**.

- **Sample** section: Tempo, Root note, Loudness (Measured, integrated +
  peak), Normalize, **Lineage** (Root / Fork of / Split of with link;
  forks count; Follow / Pin segmented control "When the parent changes";
  "Parent changed · Update" when pinned and the parent moved on; list of
  forks and snippets saved as samples).

- **Music** section: Can leave at (Exit markers / Any bar / Every 2 bars
  / Loop end only), Exit markers list, Hit points list, Cue list, Tags
  (Stinger).

- **Used by**: links to each playlist/sequence with how it's used.

### 4.1.10 Playback on Samples

- Player bar card shows the sample with mini waveform; big Play/Pause;
  scrub slider.

- **Play mode** (scope pill menu):

  - Selection: "Plays the selected item: ranges and snippets start to
    end, loops cycle, point markers to the trim end, the trim from the
    playhead".

  - Pickup → loop: "The pickup into the first bars of the loop: the
    phrase lands on the downbeat".

  - Loop: "The loop repeating, as while the state holds".

  - Loop → exit: "From the loop to the next Exit marker, then the tail".

  - Whole: "Trim start to trim end, once" / "Pickup, each loop as its
    Active setting says, then the tail".

  - Cycle loop: "Cycle the selected loop (or the first loop) until you
    stop".

  - To next marker / To next Exit / To trim end (from the selection or
    the playhead).

  - Options: **Pre-roll** ("Start one second before the start point… a
    count-in"), **Return to start at the end**, **Follow playhead**
    ("scroll the timeline to keep the playhead in view").

- While a "while held" loop plays, the button shows Release.

### 4.1.11 Samples keyboard shortcuts (from the in-app dialog)

- Space play/pause from the playhead. ←/→ move the playhead one snap
  step; Shift ×10; Alt 1 ms (fine).

- Jump to previous/next landmark (marker, loop edge, snip, trim edge).
  Playhead to trim start/end (I / O style), to start/end of the sample
  (Home/End).

- M add marker at the playhead; L add a loop around the playhead; S snip
  at the playhead; C razor tool on/off; Z zoom to selection; + / − zoom;
  0 fit; \[ / \] trim start/end to the playhead.

- Tab / Shift+Tab select previous/next timeline item (focus moves to
  it); with an item focused: ←/→ move it one snap step (Shift 10),
  Alt+←/→ move the start, Alt+Shift+←/→ move the end, Enter moves the
  playhead to it, Delete deletes the marker / removes the loop,
  Shift+F10 opens the item's menu.

- Ctrl+S save; Ctrl+Shift+S fork; Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.

- Effects list: ↑↓ move, Alt+↑↓ move the effect, Enter open/close
  settings, Delete remove.

## 4.2 Playlists (Author · Ctrl/⌘+2)

Purpose: define what plays when the game asks for a sound. Every sound
the game triggers is a playlist (or a sequence, which is a kind of
playlist). Playlists nest, pick, switch, blend and layer; sequences
arrange clips and playlists on a timeline. This screen replaced the old
Synth, Patch, Music, Transitions and standalone Sequencer screens.

### 4.2.1 Default layout (panels)

- Left dock (tabs, foldable): **Playlists** (tree) and **Library**
  (samples, read-only).

- Centre (fixed): **Playlist** (the open playlist's editor; for a
  sequence, the timeline).

- Right dock: **Inspector**.

- Bottom right: **Plays now** and **Voices** (tabs).

### 4.2.2 Playlists panel (tree)

- Toolbar: search ("Search playlists"), + New playlist ("nested inside
  the open playlist, or in the selected folder when you last clicked a
  folder"), ▾ More (New playlist, New sequence, New folder), Collapse
  all.

- Rows: folders; playlists with mode badge (C, Q, D, S/T, L, SEQ), name,
  meta (mode summary), nested children (owned playlists under their
  owner), linked copies (dashed), output-bus indicator (tooltip names
  the bus; inherited vs overridden), link indicator. Topical folders
  (e.g. Destruction, Vehicles/HoverBike, Music, Effect levels demo).

- Multi-select (Shift/Ctrl-click) with a selection bar: Move to folder,
  Duplicate (Ctrl+D), Delete… (Del), Clear selection (Esc).

- Context menu: Rename, Duplicate, Move to…, Move to top level, Add to
  playlist… (pick a target playlist; opens it and adds), Make shared /
  Turn linked copy into its own playlist, Delete (with dialog: linked
  copies elsewhere are kept and each becomes its own playlist; "Delete
  the original and remove it from N playlists" vs keep copies). Folder
  menu: New playlist here, New sequence here, New folder, Rename, Move,
  Delete.

- Drag playlists onto folders; drag a playlist onto an open sequence's
  Playlist track to make a playlist clip; drag onto the open playlist to
  add as an entry.

- Empty project state: "No playlists yet" + explanation + New playlist /
  New sequence / New folder; warns if the project has no samples ("This
  project has no samples yet. Import some in Samples first, or make an
  empty playlist now and fill it later." with Go to Samples).

### 4.2.3 Library panel (samples, read-only)

- The project's sample folder tree (same order and folders as Samples),
  search, collapse all. No import here (decided).

- Each sample: name, length, loop badge, a waveform **preview play
  button**.

- Drag a sample onto the playlist (adds an entry; samples become Clip
  playlists), onto a sequence audio track (adds a clip), or onto the
  empty area below the tracks (new track). Double-click adds to the open
  playlist. "Right-click or long-press for more" (Add to playlist…, Open
  in Samples).

### 4.2.4 Playlist panel (centre) — header and toolbar

- Header row: playlist **name** (editable; typed field), **mode badge**,
  **Undo / Redo / History** (this playlist's history, top row), **+
  Add** (opens the Add picker), entry count ("4 entries"). The title is
  never repeated twice.

- **Playlist type** row: six icon buttons (Clip, Queue, Switch, Blend,
  Layer, Sequence) with tooltips (2.6.1). Switching type converts the
  content (entries ↔ timeline).

- **Mode settings row** (varies by mode, compact, icon segmented
  controls):

  - Queue: Pick (Random / Shuffle / Round robin), Avoid last N.

  - Switch: Switch by (parameter dropdown), When it changes (Crossfade /
    Next trigger / Cut / Next bar) + Crossfade ms.

  - Blend: Dimensions (1D/2D), X input, Y input, Time length (s) when an
    input is time, Blend mode (Crossfade / Layer), Gain curve (Linear /
    Equal power), While playing (Follow / Hold), Glide ms.

  - Layer / Clip: none or minimal.

- "Used in …" line under the title when the playlist is used elsewhere
  (e.g. "Used in Bike crash (sequence)").

### 4.2.5 Playlist panel — body per mode

- **Clip**: the clip editor: mini waveform with the trim (drag either
  edge; "The part of the sample this clip plays"), sample loop regions
  shown ("Loop regions stored in the sample (edit them in Samples)"),
  time display menu, Loop setting (sample loops / off), Voice button
  (gain, pitch, pan, filters as values or curves over voice time),
  Variation per trigger (Gain ± dB, Pitch ± st; "Keeps repeats from
  sounding identical. Usually 0 for music, dialogue and long loops."),
  **Make shared**, **Open in Samples ›**.

- **Queue / Layer**: entries list. Columns: drag handle ("Drag to
  reorder"), entry badge + name, Weight (Queue; "Relative chance of
  being picked"), Voice button (gain/curves summary e.g. "−3 dB · 2
  curves"), live gain bar while playing, Open (nested), Remove (Del).
  Context menu: Move up / Move down, Copy/Paste/Reset curves, Open,
  Remove.

- **Switch**: one row per label of the Switch-by parameter: label,
  "plays" entry picker (menu of playlists/sequences/samples; cyclic
  choices disabled), voice button, live "now" bar (current label
  highlighted), Open. Below: **Change rules** table (2.6.2) with + Rule.

- **Blend 1D**: a lane with entry nodes (name, badge, position) and
  weight polygons; draggable cursor for the test value ("Click or drag
  empty space to move the test value"); node drag + arrow keys; live
  weights readout. Below: one row per entry with gain, curves, "At
  weight 0" (Stop / Continue), Open.

- **Blend 2D**: a plane with X/Y axes labelled with the inputs and
  ranges, nodes, grid, triangulation edges and active triangle, halos
  sized by weight, draggable cursor; node inspector fields Position on X
  / Position on Y.

- **Voice envelope** strip (any non-sequence mode): envelope mode, ADSR
  preview over voice time with release marker, hold indication for
  looping entries.

- Empty playlist: "No entries yet. Drag samples here from the Library,
  or use + to add one."

- **Sequence**: the embedded sequence timeline (4.2.9).

### 4.2.6 Add picker (dialog)

- Title follows context ("Add to \<playlist\>", "Pick a sample").
  Search; Show filter (Playlists / Sequences / Samples); **Add playlists
  as** Linked / Copy (with explanation tooltips); list with badges,
  names, summaries; cyclic items disabled with a reason; multi-select;
  Add button ("Add N"). Samples become Clip playlists.

### 4.2.7 Inspector (Playlists)

- Header (one pattern on all screens): mode badge + playlist name +
  summary ("Switch · Surface").

- **Selected entry / label card**: what it plays ("Surface Metal · plays
  Metal impact"), voice time readout ("Voice time — · Trigger to run
  it"), Entry fields: Gain (dB, relative), Pitch (st), Over time (curves
  button), Weight, At weight 0, sample or playlist link, Open ›, Rule ›
  (for switch rules).

- **Parameters**: test values for the game parameters this playlist uses
  (sliders + fields, dropdowns for labels). "Sequences with hold points
  wait there while held" (held toggle).

- **Playlist effects** (chain on the mixed output; "Runs on the mixed
  output · one instance per playing playlist"; empty: "No effects. Add
  one with +. Gain, pitch, pan and filters are voice properties: use the
  curve buttons."). **Move to playlist** hint when all clips share an
  effect.

- **Clip effects** (for a selected clip entry; "Runs on this clip's
  voice · one instance per voice"; shared for Clip playlists used
  elsewhere).

- **Property curves** list for the selected entry.

- **Playback** rules (2.6.7), collapsed with a summary ("Max 4 · steal
  oldest").

- **Linked copies** section (where linked; options to unlink) and **Used
  by**.

### 4.2.8 Plays now and Voices panels

- **Plays now**: "Next trigger · current parameters": a resolution flow,
  one row per level (badge, playlist name, what it would pick and why,
  e.g. "Random pick · 1 of 5", "Surface → Metal"), with the final
  sample(s) and their gain/percent. During playback it lists what each
  voice is playing, with path (sequence › track › playlist) and progress
  bars. "What a trigger would play right now; press Trigger to play it".
  Empty: "Make a playlist, then press Trigger" / "Add entries, then
  press Trigger" / "Nothing plays with these values".

- **Voices**: "Trigger to start capturing. Every voice is listed here,
  newest first, with when it started, its status and gain." Status:
  Playing / Looping / Holding (until release) / Fading out / Rejected
  (with the rule that blocked it: cooldown, chance, max instances,
  steal). Progress bar, remaining time ("until stopped" when unknown),
  gain dB.

- Playback redraws 10×/s; playheads animate every frame; bars ease
  between updates.

### 4.2.9 Sequence view (embedded timeline + inspector)

A sequence opens in the same screen: the Playlist panel shows the
timeline; the Inspector shows the sequence/track/clip/loop/marker
inspector. (Implementation note from the prototype: the Sequencer
component is embedded twice, embed="timeline" and embed="inspector",
sharing state; in the product this is simply one editor.)

- **Toolbar rows** (top row: playlist type icons + undo/redo/history;
  second row: tools):

  - **Add track** split: Audio track (default) / ▾ Playlist track.

  - **Add loop** (at the playhead; or drag in the Loops row), **Add hold
    point** (at the playhead; or double-click the Loops row).

  - **Razor** (C): click a clip to split it; Esc stops.

  - **Write automation** (W).

  - **Playlists** link icon ("transitions between states are Switch
    change rules").

  - **Waveform / Spectrogram** view toggles.

  - **Tempo** chip ("No tempo ▾"): popover with BPM field, **Tap** ("Tap
    on the beat two or more times; averages the last 8 taps, a pause
    over 2.5 s starts a new count"), meter (e.g. 4/4), No tempo.
    (Placement on the toolbar is deliberate; keep it there.)

  - **Snap** split: on/off, increment (time steps or beats), Custom,
    **Snap to edges** ("Clip edges, loops and markers also snap to each
    other").

  - **Time display** menu.

- **Header area above tracks**: Markers row (double-click to add a
  marker), Loops row (drag to add a loop; double-click for a hold point;
  loops show Active icon, capped edges draggable), Tempo lane when the
  time display is Bars, ruler with playhead and **sequence end handle**
  ("Sequence end 00:04.000 · drag to change").

- **Track header**: lanes caret ("Show or hide automation lanes"),
  colour chip, name (editable), track-type/FX badge, **Enable** (power:
  "Disabled: takes no part in playback"), **M** / **S**, **volume**
  field (dB; locked + live when automated), output (bus name, e.g.
  "SFX"), delete (Ctrl/⌘+Z to undo). Drag the header to reorder tracks.

- **Automation lanes** under a track (2.7.3): name, live value, Driven
  by (Time / game parameter dropdown), open in curve editor, hide,
  delete; min/max labels and live marker for parameter lanes.

- **Clips**: name, colour, badge (sample format 1D/2D/QUE for
  playlists), waveform/spectrogram (reflects envelope, direction,
  effects), loop passes tiled to the clip length with dividers,
  pickup/tail, hatched hold loops, markers (Exit green), volume envelope
  (amber) with points, FX badge "FX n", curve chip, "⚠ follows" chip,
  disabled clips dimmed + hatched + struck-through name, Async clip
  green cursor, playlist clips show the picked item while playing.

  - Edit: move (also across tracks), trim start / set length (drag
    edges), razor, context menu (Copy / Paste / Duplicate / Split here /
    Enable-Disable / Delete / Open in Samples), Ctrl+C/V/D, Del,
    multi-select (Shift/Ctrl-click; box-drag on empty lane space;
    Ctrl+A), group move/nudge/trim/copy/paste/duplicate/enable/delete,
    ←/→ nudge by the snap step (Shift ×10), ↑/↓ move to the track
    above/below, \[ / \] trim start/end to the playhead, Alt+←/→ move
    the end, Alt+Shift+←/→ move the start, E toggles enabled.

  - Hover a clip ~0.45 s: card with enabled state, range, timing, loops,
    markers, direction.

  - Library drag shows a ghost clip on the target track; playlist tracks
    refuse samples; audio tracks refuse playlists.

  - Timeline length is frozen during drags so the view doesn't rescale.

- **Drop zone**: "Drop a sample here to add it on a new track" below the
  last track.

- **Zoom bar** (same as Samples) and a **readout row** ("At 00:00.000:
  Metal impact 0 ms · Wood impact 0 ms…": what each track plays at the
  playhead).

- **Playback**: Trigger/Space plays the sequence in the timeline from
  the start; again = Release (while-held loops) or Stop. Play modes:
  from the playhead to the end / the whole sequence from the start;
  Return to start at the end; Follow playhead. The held state is shown
  ("The sequence's key is held: While held loops stay active until it is
  released").

- **Sequence inspector**:

  - **Sequence**: Name, Length (typed timecode), Tempo BPM + Tap +
    meter, **Sequence effects** (whole-sequence chain; "Runs on the
    sequence's mix · one instance per playing sequence"), **Playback**
    rules (Output, Plays Once/Until stopped, Max instances, When full,
    Cooldown, Chance, Delay).

  - **Track**: Enabled (automatable), Colour, Volume, Pan, Output,
    **Track effects** ("Runs on the track's mix"), **Move to track**
    hint, Clips list.

  - **Clip** ("Clip · N selected" for multi): sample with **Open in
    Samples** (Ctrl/⌘+1), Start ("Where the clip starts in the
    sequence"), Offset ("Where in the sample the clip starts playing"),
    End/Length, Enabled, Gain, Pitch, Pan (each with Automate),
    Direction (Forward / Reverse), **Timing** (Sync / Async) with the
    follows warning + Make Async, **Clip effects**, **Automation** list
    with show-on-clip eye, **Sample loops** (each Inherited / Override
    with full loop controls and Parameter binding), **Markers** (use /
    don't use each sample marker in this clip; Cue and Exit explained).

  - **Loop / hold point**: Start, End ("same as the start makes a hold
    point"), Make hold point, Active, Parameter + Condition + Threshold
    (slider + field), Exit, Exit fade, Re-entry.

  - **Marker**: name, time, colour, note.

- **Parameters**: the sequence reads the same game parameter test values
  as Playlists (one set of parameters). Panel shows only parameters this
  sequence uses, plus **held** when something is While held; "N uses"
  chips; empty: "No parameters used by this sequence".

### 4.2.10 Playlists playback and auditioning

- **Trigger** (Space) resolves and plays one voice of the open
  playlist/sequence with the current test values; again releases held
  loops; Stop while playing.

- ◂ / ▸ step to the previous/next voice start or end; Pause holds Plays
  now, Voices and curves at that point.

- The voice strip shows every voice of this trigger as bars on a time
  scale; drag to preview at any point (pauses); keyboard scrubbing like
  Samples.

- Structural edits while playing apply to the next trigger ("applies on
  the next trigger").

## 4.3 Mixer (Mix · Ctrl/⌘+3)

Purpose: the routing tree is the mixer. Set levels, effects, sends,
ducking, beds and voice limits per bus; author snapshots and their
triggers; drive levels with game parameters; meter loudness against
platform targets; mix live against the running game.

### 4.3.1 Default layout (panels)

- Left dock: **Snapshots** (tree) over **Gain lanes**.

- Centre (fixed): **Buses**.

- Below Buses: **Loudness**.

- Right dock: **Inspector** over **Game parameters**.

### 4.3.2 Snapshots panel

- Toolbar: search ("Search snapshots by name or trigger; results show
  each snapshot's folder"), + New snapshot (in the selected folder), ▾
  More (New snapshot, New folder), Collapse all.

- Rows: folders (e.g. Cutscenes, States); snapshots with an active dot
  (● "Active: its trigger is true right now" / ○ "Not active"), name,
  trigger summary as meta ("State: Paused", "Health \< 20%", "Base
  mix"), **EDITING** tag on the one being edited. Click a snapshot to
  edit it (its levels show in the bus list).

- Context menu: **Edit trigger…**, Rename, Duplicate, Move to…, Move to
  top level, Delete, Undo.

- Drag onto folders; F2 renames; double-click folder to rename.

### 4.3.3 Buses panel (centre)

- **Header toolbar**:

  - Undo / Redo / History (every edit with branches; snapshot edits
    named, e.g. "Rename snapshot", "Edit ducking").

  - **Editing chip**: active dot + snapshot name ("The mix you are
    editing"; tooltip: active state + "its levels apply on top of the
    base mix").

  - **Trigger chip** (⚡ + trigger summary, e.g. "⚡ Base mix", "⚡
    Health \< 20%"): opens the **Trigger dialog** (4.3.8).

  - Live chip: "3 edits kept" (stopped: "Edits you made while the game
    played are kept after Stop") / "Live" (playing).

  - **Beds** chip: "Beds 2/2 · 1 sharing" (warning colour when buses are
    sharing; tooltip lists hosts and sharers).

  - **Compare A/B**: A = hear the saved mix (live edits held, not lost);
    B = hear your live edits.

  - **View**: List (routing tree) / Strips (console faders in routing
    order).

  - Collapse all buses (top-level stay visible), **New bus** (inside the
    selected one).

- **List view** columns: Routing (tree: caret, colour bar, name; fx
  count and automation count meta "fx 1 · auto 2"; pending/waiting state
  e.g. "Rain (new) · waiting"), Level (horizontal fader with meter under
  it; a violet ghost tick shows the snapshot's effect: "The fader stays
  where you set it"; double-click for 0 dB), dB (typed field −60…+6),
  Voices (limit, inherited shown with ↑), Bed ("Own · base", "→ Master",
  "Own · p80", "→ Ambience · p60"), M / S. Sections: buses, **Returns**
  (e.g. Reverb "← 3 sends"), **VCAs** (e.g. Gameplay SFX "3 buses").

- **Re-routing**: drag a bus name onto another bus to re-parent ("Drop:
  route X into Y" / "Can't route X there"). Bus context menu: Add child
  bus, Rename, Delete bus ("Its children move up to its parent"), Move
  to…, Undo.

- **Strips view**: vertical faders with meters, names, dB fields, M/S,
  in routing order.

- Master: "the output. Everything ends here."

### 4.3.4 Inspector (bus / return / VCA)

- Header: type badge (Bus / Return / VCA / Master) + name.

- **Name**, **Parent** (path; "Drag the bus in Routing to change its
  parent"), **Level** (slider + dB field + automation curve button;
  shows "→ 0 dB" effective value when automated), **Voice limit**
  (Inherit / Limit + count; "64 · Master" scope chip), **Bed** (Share /
  Own; when Own: priority; "→ Master" host chip; tooltips explain beds),
  **VCAs**.

- **Bus effects**: chain of inserts ("Runs on everything routed here ·
  one instance, always running"; "Inserts run top to bottom, before the
  fader"). Effect cards as in 2.8; Sidechain compressor has **Key** bus
  picker. Empty: "No effects. Add one with +."

- **Sends**: list (target return, level slider + field, remove); + Add
  send ("Already sends to Reverb (the only return)" when no more
  targets). Empty: "No sends. Add one with +."

- **Ducking**: + Add ("Duck this bus when another bus plays"; menu of
  source buses). Each rule card: "Ducked by \<bus\>" header with on/off
  and remove; **When** (While playing / Above level), **Above** (dBFS
  threshold, when Above level), **Duck by** (dB), **Attack**,
  **Release** (sliders + fields). Same card style as effects. Empty: "No
  ducking. Add a bus with +."

- Return inspector: "Return: fed by sends from …. Outputs to Master.";
  VCA: "No audio passes through a VCA"; members.

- **Used by**: playlists/sequences routed here (links to Playlists); "No
  playlists route here directly".

### 4.3.5 Gain lanes panel

- Explains why the selected bus is as loud as it is, as a stack of
  contributions: **authored** (fader), **runtime**, **snapshot –
  \<name\>**, **vca**, **monitor**, **dip** (ducking), **duck**,
  **automation – \<param\>**, **× parents** (the sum of parent buses),
  then **You hear** (the total). Neutral rows say "neutral"; active ones
  show dB and a bar.

### 4.3.6 Loudness panel

- Standard "BS.1770 / EBU R 128". **Platform target** dropdown: Console
  · −24 LUFS, −1 dBTP; PC / web · −18 LUFS, −1 dBTP; Mobile · −16 LUFS,
  −1 dBTP.

- Tiles: **Momentary**, **Short-term**, **Integrated** (LUFS; warning
  when off target: "Warning · 7.6 LU over −24"), **Range** (LU), **True
  peak** (dBTP; "Warning · over −1 dBTP").

- Graph: short-term loudness over the last 60 s with the target line.

- **\[Sim\]** values. **\[Planned\]** targets and tolerances as project
  settings; integrated loudness measured over a whole take/capture (e.g.
  ≥ 30 min), not only live.

### 4.3.7 Game parameters panel (test values)

- Sliders + number fields for numeric parameters (Health %, Threat, Time
  of day h, Water depth m…), **Game state** dropdown, **In combat**
  checkbox (true/false), **Surface** dropdown (text). These drive
  automation and snapshot triggers when the game isn't supplying values.

### 4.3.8 Trigger dialog ("Edit trigger…")

Opened from the trigger chip or the snapshot context menu. Modal; Cancel
/ Done (changes apply only on Done; Esc or outside click cancels). Width
up to 600 px, fits the viewport, scrolls.

- Header: "Trigger" + snapshot name + close.

- **Starts** dropdown: When conditions match / Always (base mix) / From
  game code / Never (audition only).

- **When conditions match**:

  - "Active while \[all ▾ \| any\] of these are true".

  - Condition rows: lead word (If / and / or), **Game parameter**
    dropdown (each item shows its type: number, true / false, state,
    text), **Comparison** dropdown (per type, 2.10), **Value** (number
    field + unit; "and" + upper value for between; value dropdown for
    states/text is/is not; text field for contains/starts with), live
    true/false dot, remove ✕. "+ Condition". Empty: "No conditions yet:
    it never starts on its own."

  - **Transition**: Fade in (ms), Fade out (ms), Hold at least (ms).

- **Always**: note "Always active: the mix every other snapshot is
  applied on top of."

- **From game code**: the Start and Stop calls to copy.

- **Never**: "Never starts by itself. Audition it here by selecting it."

- **When other snapshots are active too** (all except base mix):
  **Priority** (number, "higher wins"), **Combine** dropdown (Override:
  higher priority wins / Add: dB changes stack), and a list of every
  other snapshot that changes the same buses: active dot (warning colour
  when both are true now), name, "priority N · also changes Ambience,
  Music", outcome ("Underwater wins (higher priority)", "Both apply:
  their dB changes add up", "Same priority: the one that started last
  wins" in warning colour). Empty: "No other snapshot changes the same
  buses."

- Footer status: "● True now with the test values" / "○ False now with
  the test values".

- All dropdowns are in-app floating lists (no native pickers).

### 4.3.9 Automation of bus levels

- Bus level (and effect parameters) can be automated by a game
  parameter: curve from the parameter's range to dB, edited in the
  Curves sub-window (Driven by = parameter; shape presets). The bus list
  shows "auto N"; the inspector level shows the live result; the Gain
  lanes show the automation contribution.

### 4.3.10 Live mixing

- Player bar main button = game session. Card "Snapshot · plays the game
  session through this mix". While running, edits go to the game; after
  Stop they are kept. A/B compare during play.

## 4.4 Spatial (Mix · Ctrl/⌘+4)

Purpose: hear and tune 3D sound in test scenes: placement, distance
attenuation, height, occlusion, zones, reverb zones, render modes, and
how the scene's sounds sit under music and 2D sounds.

### 4.4.1 Default layout (panels)

- Left dock (tabs, foldable to "SCENES \| OUTLINE" strip): **Test
  scenes** and **Outline**.

- Centre (fixed): **Scene view**.

- Below: **Voices**.

- Right dock: **Inspector** over **Scene settings**.

### 4.4.2 Test scenes panel

- Toolbar: search, + New blank test scene, ▾ More: Blank scene ("One
  listener, nothing else"), From current test scene, From open game
  scene, From take… ("Positions at the take's playhead"), New folder.
  Collapse all.

- Rows: folders and scenes (e.g. Canyon run, Crates block the campfire).
  Context menu: Rename, Duplicate, Move to…, Move to top level, Delete,
  Undo. A "Game scene · its own sounds" entry represents the open game
  scene.

### 4.4.3 Outline panel

- Filter ("Filter emitters, zones, listeners and obstacles by name"),
  groups (Emitters, 2D sounds, Listeners, Obstacles, Audio zones, Reverb
  zones), collapse all. Each row: name, eye (hide/show), lock, select on
  click, rename, delete.

### 4.4.4 Scene view (centre)

- **Toolbar**: Undo / Redo / History; **Legend** (HRTF ring, Panned
  ring, Ambisonic bed dashed ring, Audio zone box, Zone edge dashed
  line, Occluded red dashed line; legend items are also tooltips on the
  marks).

- **Tool column** (Add to scene): Select, Emitter, Moving (emitter on a
  path), Listener, Obstacle, Reverb (zone), Audio zone, 2D sound ("music
  or a scene-wide sound with no position"). Placing: "Click in the scene
  to place the new item · Esc cancels".

- **Top-down grid** (metres) with pan/zoom: wheel zooms around the
  pointer; Space-drag or middle-drag pans; touch: two-finger drag pans,
  pinch zooms, one-finger drag on empty grid pans; zoom bar (− %, +,
  Fit, Side view). Hint: "Click to select · Del deletes · Ctrl/⌘ C, V
  copy and paste (D duplicates) · double-click to rename · Space-drag
  pans".

- **Items**:

  - **Emitter**: dot coloured by render mode (HRTF / Panned / Ambisonic
    bed), label with name and height relative to the listener ("Campfire
    ↓1 m"), attenuation radius rings (min/max), occlusion line to the
    listener (red dashed when blocked: "Path to the listener is
    blocked"). Selected toolbar: Edit attenuation…, rename, delete. Drag
    to move (keeps the grab offset; no jump). On touch: tap selects;
    drag only after selection or after a long-press (380 ms, finger
    still; light vibration on activation).

  - **Moving emitter**: path polyline with points ("Add a point here",
    "Drag to move · Shift-click to remove"); Edit path mode; speed
    (m/s); position on path (%); label shows speed ("Drone · 12 m/s").

  - **Listener**: player icon; "Listen here" / "Hear the scene from
    here"; only one listener hears the scene at a time ("Not
    listening…"); during Play the listening player follows the game's
    camera.

  - **Obstacle**: rotated rectangle with material colour; drag to move;
    select to resize (edge handles) and rotate (rotate handle); height
    range (bottom/top).

  - **Audio zone**: box (move/resize/rotate), dashed edge; label "Storm
    front · inside".

  - **Reverb zone**: box with priority; "Reverb zone · Canyon (priority
    1, default)".

  - **2D sound**: listed (no position).

- Selection toolbars appear only for the selected item (not all at
  once).

- **Height panel** (right of the grid): vertical scale 0–30 m showing
  every item's height (bars/dots), the **height range** (slab) of what
  the top view shows (drag edges to change top/bottom; drag body; click
  to move the range), **Follow** ("Keep the range centred on the
  listening player", ±3 m), **▲ / ▼ buttons raise/lower the player 1 m**
  (or the selected listener), readout "0.5–6.5 m". Items outside the
  range dim ("· outside the height range"); "Nothing in this range".

- **Side view** toggle: "Side view · looking north · across = X, up =
  height (0–30 m)"; drag items up/down to set height.

### 4.4.5 Voices panel

- Table per emitter: Emitter, Distance (with height delta "58 m (↑12.5
  m)" or "37 m to edge" for zones), Rendered as (HRTF / Panned /
  Ambisonic bed / "Audio zone · from edge, spread 56°" / "Audio zone ·
  surround (bed) · depth" / "silent (outside)"), Occlusion (Clear /
  Blocked), Doppler. Play/mute per row.

### 4.4.6 Inspector (Spatial; follows the selection)

- **Emitter**: Name; **Plays** (sound block: the scene's assigned sound
  as default "Scene sound · Assigned in the game scene"; **Replace**
  with a playlist or sample from a searchable picker "Try another sound
  here without changing the game scene"; remove replacement; **Hear A ·
  Scene / B · Replacement** compare); **Volume** (slider + dB);
  **Output** (Mixer bus; "so ducking and snapshots apply"); Speed / On
  path (moving); **X (m) / Y (m)** (pairs; stack when narrow); readouts
  **Heard as**, **Distance**, **Occlusion**, **Doppler**;
  **Attenuation** summary ("Min 4.0 m · Max 34.0 m") + **Edit
  attenuation…** (Curves sub-window, distance mode); Play solo, Mute,
  Delete.

- **2D sound**: Name, Plays, Volume, Output, note "No position: heard
  the same anywhere in the scene, like music or a menu sound. It isn't
  occluded or panned."

- **Listener**: Name, X/Y, height, Listen here, note about Play
  following the camera.

- **Obstacle**: Material (dropdown, e.g. Wood, Rock, Metal), X, Y,
  Width, Depth, Rotation, **Blocks** (e.g. "−4 dB · low-pass 4 kHz" from
  material), Bottom (m), Top (m), height summary ("3 m tall").

- **Audio zone**: Plays, Volume, Output, **Heard** (From its edge /
  Inside only), **Feather** (m), zone depth parameter ("Zone depth
  (local parameter)"), size/rotation.

- **Reverb zone**: Reverb (preset), Priority, Send, size/rotation.

- Empty: "Select something in the scene or outline to edit it here."

### 4.4.7 Scene settings panel

- **Listening**: HRTF for the nearest N voices; Ambisonic bed beyond D m
  ("Far sounds fold into one ambisonic bed, which is cheap; near ones
  get full HRTF").

- **Occlusion**: Rays per voice; Fully blocked (e.g. "−9 dB · low-pass
  1.2 kHz"); Uses (physics layers, e.g. Terrain, Rock); Curves (Volume,
  low-pass by how blocked; opens Curves).

- **Doppler**: Amount % ("100% is physically accurate. Most games sound
  better around 50%.").

- **Reverb zones**: blend time ("Zones blend over 0.8 s"), overlap rule
  ("Where they overlap, the higher priority wins"), level default
  ("Outside every zone: Canyon hall").

### 4.4.8 Playback

- Main button = game session ("Test scene · plays the game session in
  this scene"). Without the game, emitters can be auditioned (play solo,
  hear every unmuted emitter from the listener).

## 4.5 Take (Run · Ctrl/⌘+5)

Purpose: replay a recorded gameplay run and tune sounds against it. The
take's recorded game values drive your current sounds, so you hear your
latest edits in real gameplay context. Read-only for the recording
itself.

### 4.5.1 Default layout (panels)

- Left dock: **Takes** (tree) and **Sequences in this take** (tabs).

- Centre (fixed): **Take** (lanes).

- Below: **Mixer** (strip view of buses for this take).

- Right dock: **Inspector**.

### 4.5.2 Takes panel

- Search ("Search takes by name; results show each take's folder"), +
  Open take file… (into the selected folder), ▾ More (Open take file…,
  New folder), Collapse all. Context menu: Rename, Duplicate, Move to…,
  Move to top level, Delete, Undo. Click to switch takes.

### 4.5.3 Sequences in this take panel

- Every sequence/playlist that played in the take, with summary ("3
  takes, round robin · used in 1 sequence", "Surface × Impact velocity,
  15 zones · used in 2 sequences"), Open in Playlists links.

### 4.5.4 Take panel (centre)

- Header: Go to start, Playhead readout ("Playhead position"), Open
  sequence ›.

- Ruler (0–32 s in the demo; **\[Planned\]** zoom and the shared time
  toolbar for long takes).

- Lanes:

  - **Picture**: frames from the game at the playhead (thumbnail strip).

  - **Gameplay take** summary lane.

  - **Sequence instances**: one lane per sequence with mute/solo;
    instance bars (start–end, sustain span shaded, label "Engine ·
    instance 1 (whole run)", "one-shot · Bike impacts (Switch)", "until
    stopped · Engine loops (Layer)"); click an instance to inspect;
    "Move the playhead to where this instance started".

  - **Game parameter lanes**: Game · Speed (curve), Game · RPM, Game ·
    Surface (labelled segments: Dirt, Rock, Metal bridge).

- Hint (tooltip): "Scrub to audition the whole mix · click an instance
  to inspect it".

### 4.5.5 Inspector (Take)

- For the selected sequence instance: name and path, "Open \<sequence\>
  in Playlists", per-layer values at the playhead ("Values show this
  sequence's layer as it sounded here"): knob/readouts for driven
  properties (e.g. Speed → Pitch "−3 to +7 st · ease-in · smoothing 120
  ms", Low-pass), each with **Authored value** vs live value. When a
  sound was changed during Play: "Changed during Play: restart the
  playing copies with the new version" (**Restart instances**). No
  editing of the recording; links go to the authoring screens.

- No selection: "Select a sequence instance to inspect it. Values below:
  Track values at the playhead".

### 4.5.6 Mixer panel (bottom)

- Strips for the take's buses with meters (Master, SFX, Vehicles,
  Engine…) and Open Mixer (snapshot shown). **\[Open\]** either add
  faders here (reuse Mixer strips) or keep meters + link (UX review K3).

### 4.5.7 Player bar

- Back to start, **Replay** (play the recording back; its values drive
  your current sounds), **Record** (capture the running game as a new
  take while the session plays), **Loop**, scrub slider, length. Status
  line: "Game running · Record to capture it" / "Replay, or start the
  game to record".

- Playhead shared with Profiler (open the same capture in either).

## 4.6 Profiler (Run · Ctrl/⌘+6)

Purpose: debug what the audio engine did during a capture: which voices
played and why, what was blocked, load, effect instances, bus gain,
loudness, and which version of a sound played.

### 4.6.1 Default layout (panels)

- Left dock: **Captures** (tree).

- Centre (fixed): **Tracks** (timeline lanes).

- Below: **Messages** (log) and **Why it played** (graph).

- Right dock: **At cursor**, **Voice** (selected voice details).

### 4.6.2 Captures panel

- Search, + Open capture file… (into the selected folder), ▾ More,
  Collapse all; context menu as other trees. Captures from exported
  games appear in the same list.

### 4.6.3 Tracks panel (centre)

- Filter: **All voices / Problems only**; playhead readout; ruler
  (**\[Planned\]** zoom for long captures).

- Lanes:

  - **Picture** (frames).

  - **Load**: voices · CPU with the voice limit line ("voice limit 32").
    **\[Planned\]** split voices and CPU or label two axes (not
    colour-only).

  - **Effects**: instances by level at the playhead (Sample: "Rendered
    into the audio offline: no instances at runtime"; Clip: "N voices,
    about 40% with a clip chain"; Playlist/sequence track: "One per
    playing playlist or sequence track"; Bus: "One per bus chain, always
    running").

  - **Bus · Music**, **Bus · Vehicles**: effective gain over time (e.g.
    "duck −6.0 (Dialogue presence)").

  - **Loudness**: short-term vs target (−24).

  - **Game · Speed** (parameter lanes).

  - Voice/instance bars per sequence with warning marks (blocked,
    stolen, missing file) and version colouring.

- Markers for problems: "Boost blocked: voice limit 1 reached", "Impacts
  stole a voice (limit 4)", "Missing file vo_rider_07.wav", "Music:
  Explore → Combat (next beat, stinger Hit)". ← → step; Shift+← → jumps
  to markers.

### 4.6.4 Messages panel

- Timestamped log ("Jump to \<time\>"): game events, rule decisions,
  warnings. Examples: "Game event Boost fired 1.1 s after the last one."
  "Cooldown (0.5 s) was clear, but voice limit for Boost is 1." "Not
  played. Raise the limit or allow restart." "Game state Combat
  requested at 00:15.600." "Rule Explore → Combat: next beat, stinger
  Hit." "Ducked Music and Ambience by 6 dB." "Script asked for line
  rider_07." "File vo_rider_07.wav is not in the build." Filter field.

### 4.6.5 Why it played (graph)

- For the selected voice: a node graph from the game event through each
  decision (playlist modes, switch labels, round robin choice, velocity
  layer, voice limit/steal, ducking) to the sample that played, with
  reasons ("Velocity 64 → Medium layer", "Surface Metal bridge → Metal
  column", "Round robin chose take \#4", "Stole the quietest voice: the
  second land_hard was cut after 0.9 s"). Pan (drag/arrows), zoom
  (Ctrl+scroll, + / −, 0 fit, 1 = 100%). Nodes link to
  Playlists/Samples/Mixer ("Open this sequence in Playlists", "Open this
  sample in Samples", "Open this bus in the Mixer").

### 4.6.6 At cursor / Voice panels

- **Voice**: Sequence, Played (sample), Bus, Peak, Distance, **Version**
  ("Old version · started before Bike impacts was edited during Play
  (00:20.000)" / "Current version · started after the edit" / "Not
  edited during this capture"), **You hear** (the full gain chain,
  reusing the Mixer gain lanes), **Open in Take** at the same playhead.

- Warnings: "Warning · Blocked by voice limit", "Max instances 1 · full
  → not played", "Voice limit 4 · stolen after 0.9 s", "Explore → Combat
  · next beat, Hit", "Ducks Music, Ambience −6 dB".

### 4.6.7 Player bar

- Same as Take; Record "records while the game session runs and adds a
  capture to the list" ("● Recording a new capture").

- **\[Open\]** UX review recommended merging Take and Profiler into one
  Run view with Mix and Debug modes (a capture is a take). Not decided;
  both screens exist.

# 5. Shared sub-windows

## 5.1 Curves sub-window (shared curve editor)

One floating, draggable window used everywhere a curve is edited:
clip/entry property curves over voice time, sequence automation, effect
parameter automation, bus level automation, sample effect automation
over sample time, attenuation (distance), occlusion curves.

- **Window**: title "{title} · {target}", drag handle ("Drag to move
  this window"), close without applying (Esc), Apply. Status: "Unsaved
  changes. Apply writes them to \<target\>". Responsive: width/height
  fit the visible viewport (uses --vvh); below 640 px container width
  the layout stacks (side list above, plot keeps ≥ 230 px height).

- **Properties list** (left/side): every curve of the target (e.g. Gain,
  Pitch, Pan, Low-pass, High-pass, Active), each with visibility eye,
  live value, clear button ("back to a flat curve at the plain value"),
  power (bypass: "keeps the keys, uses the plain value"), count of
  driven curves. Two-line rows so names and values don't truncate.

- **Driven by** (X axis): a clock — Clip time / Voice time / Sequence
  time ("Which clock drives X") — or a game parameter ("the curve then
  maps that parameter to the value"). Distance mode: X = metres from the
  listener with Min/Max handles ("Inside Min the sound plays at full
  volume. Dragging Min or Max stretches every curve with it. Beyond Max
  the last value holds."). Parameter mode shows a histogram of how often
  the game sends each value ("tune where the bars are tall first").

- **And by** (second input): Nothing or another parameter. For scalar
  second inputs, mode: **Morph** (blend between a Low and a High curve
  by the second input), **Scale** (multiply the value by a curve over
  it), **Rate** (time curves only: speed the clock up or down).
  **Preview at** (where the dashed preview sits on the second input).
  For discrete second inputs: **Table** (one value per label instead of
  a curve) or one curve per label.

- **Plot**: double-click to add a key; drag keys; selected key shows X
  ("Key at") and a typed Y value in the property's unit; hover/selected
  key shows the tangent toolbar: Linear, S-curve (flat tangents), Ease
  in, Ease out, Stepped, Bezier (drag the handles), Free handles (move
  each side on its own; Bezier only), Delete key (Del). Waveform of the
  sample drawn behind the curves for sample/clip entries (matching the
  clip's trimmed length), and through the effect being automated.

- **Presets**: built-in shapes ("One key: the same value everywhere",
  "Straight line between the ends", "Physically based roll-off between
  Min and Max" for distance) + saved user presets ("Save the selected
  property's curve as a preset"; click to apply, right-click to remove).

- **Dope sheet** (time mode): a strip with every property's keys as
  diamonds aligned to lanes, playhead, ruler drag-to-zoom ("Drag to
  choose what the curve editor shows · click to move the playhead ·
  double-click to show the whole clip"), Show whole clip, Add key at
  playhead. Lanes are ≥ 32 px on touch; key diamonds stay square.

## 5.2 Other shared dialogs and popovers

- History popover (2.13), Move to… dialog (3.9), Calibration dialog
  (3.3), Tap tempo dialog (4.1.5), colour picker (3.12), Keyboard
  shortcuts dialog (3.8), delete confirmation dialogs (name the
  consequences; Cancel first).

# 6. Cross-screen connections

- Samples ↔ Playlists: Library shows samples; clips link "Open in
  Samples"; Samples "Used by" links to playlists/sequences; sample
  loops/markers are inherited by clips (with per-clip overrides).

- Playlists ↔ Mixer: every playlist/sequence has an Output bus
  (inherited from its folder or overridden); "Open \<bus\> in the
  Mixer"; Mixer "Used by" lists routed playlists.

- Spatial ↔ Playlists/Mixer: emitters play playlists/samples and route
  to buses.

- Take/Profiler ↔ Playlists/Samples/Mixer: Open links from instances,
  graph nodes and voices; Take ↔ Profiler share the playhead.

- One set of game parameters: test values are shared in the product (the
  prototype keeps them per screen, except Playlists ↔ embedded Sequencer
  which share).

- Bridge mechanisms in the prototype (window globals \_\_mycoPl,
  \_\_mycoSqE, \_\_mycoSqCtl, \_\_mycoPlDrag, \_\_mycoLibDrag,
  \_\_mycoSqRes, localStorage myco.review, myco.dock.\*, myco.trial.\*)
  stand in for a shared project model. **\[Planned\]** replace with the
  real project/state layer.

# 7. Runtime (engine) behaviour the studio depends on

Everything below must exist in the Rust audio core and the game
integration for the UI to be real. The prototype simulates it.

## 7.1 Triggering and voice management

- Game calls trigger playlists/sequences by name (events). Each trigger:
  apply Chance, Cooldown, Delay; resolve the playlist tree (Queue pick
  with Random/Shuffle/Round robin and avoid-last-N; Switch by current
  label; Blend weights from current parameter values or voice time;
  Layer all); create voices; apply Max instances and When full (steal
  oldest/quietest/farthest or don't play); report every decision to the
  profiler.

- Hold/release: triggers can be held; While held loops stay active until
  release; Until stopped sequences wait for Stop.

- Voice time clock per trigger; property curves and envelopes evaluated
  on voice time, clip time or sequence time.

- Blend While playing Follow/Hold with Glide smoothing; At weight 0
  Stop/Continue.

- Switch When it changes (crossfade/next trigger/cut/next bar) and
  change rules with most-specific-wins, transition clips, music timing
  (next beat/bar/Exit marker).

- Sequence playback: tracks, clips, Sync/Async clip clocks with the
  one-driver rule, loops/hold points with Active/Exit/Re-entry,
  crossfades on overlaps, automation lanes, write automation from the
  studio.

- Structural edits during play apply to new instances; "restart
  instances" on request; versions tracked so the profiler can label
  old/current.

## 7.2 Effects

- DSP for every effect in Appendix B, with versioned parameters.
  Per-voice chains (clip), per-mix chains (playlist, sequence, track),
  bus inserts, sends/returns, sidechain keys, ducking (While playing /
  Above level with attack/release).

- Offline renderer for sample effects (cache keyed by hash; Freeze;
  Flatten; background rebuild; live preview while rebuilding).

## 7.3 Mixing

- Bus graph with levels, mute/solo, VCAs, voice limits (inherit/cap),
  ambisonic beds (Max beds, priority allocation, sharing), returns,
  effective-gain computation (for Gain lanes and Profiler "You hear").

- Snapshots: evaluate triggers (conditions over typed parameters,
  all/any, base mix, game code, never), fade in/out, hold-at-least,
  priority + combine (override/add), same-priority last-started-wins.

- Loudness metering (BS.1770 momentary/short-term/integrated/range/true
  peak) live and over captures.

## 7.4 Spatial

- Attenuation curves (distance), HRTF for the nearest N voices, panning,
  ambisonic bed beyond distance D, occlusion raycasts (rays per voice,
  physics layers, volume + low-pass curves), Doppler amount, audio zones
  (from edge with spread / inside only / surround bed with depth
  parameter, feather), reverb zones with priority and blend time,
  elevation (heights), moving emitters on paths, listener selection, 2D
  sounds.

## 7.5 Game link, recording and analysis

- Live link to the running game: push edits, receive game parameter
  values, camera/listener, picture frames.

- Record takes/captures: parameter lanes, events, instances, voices,
  decisions, load, bus gain, loudness, messages, picture.

- Replay: drive current sounds from recorded values; shared playhead
  between Take and Profiler.

- Audio analysis: loudness/peak, tempo and beat detection, root-note
  detection, zero crossings, waveform and spectrogram rendering.

- WAV chunk read/write (cue, labl, ltxt, smpl, acid, bext), change
  detection on disk, backups.

- Device latency calibration storage and use.

## 7.6 Status data

- Voices in use / cap, CPU, device health, meter state, save state for
  the status bar.

# 8. Persistence and project format \[Planned\]

- Store in the project: samples (records + edit graph + versions + cache
  references), playlists/sequences (full model incl. timelines, curves,
  chains, playback rules), folder trees, bus graph, snapshots, game
  parameter definitions, test scenes, takes/captures (or references),
  saved colours and curve presets, project settings (timecode display,
  Max beds, loudness targets/tolerances, default output buses per
  folder).

- Per-user (not project): dock layouts per screen, device calibration,
  single-key shortcut toggle, recent selections.

- Undo histories: per-sample trees persisted with the sample; project
  history per session (at least).

# 9. Workflow Trials (validation process)

- A canvas page "Workflow Trials" holds a **Journeys** board (11 user
  journeys with steps; each step cycles Not tried → Pass → Issue with a
  note; progress; expand/collapse; Clear results; Reset project with a
  two-step confirm) and **Trial boards** that open the real screens with
  an empty project (project="empty").

- One shared trial project (localStorage myco.trial.project) holds
  samples, UI state, a derived Library, playlists, playlist folders and
  sequence data, so the screens share data like the real product will.

- Import in trials uses a mock folder (~/Audio/GameSFX) with realistic
  WAV metadata.

- Process (user decision): start from a blank studio, walk each journey,
  fix the source screens, re-run; when every journey passes, the UI is
  ready for implementation. Samples and Playlists are trial-ready;
  Mixer, Spatial, Take, Profiler trial support is still to do
  (Master-only empty Mixer with persisted buses; empty states for
  scenes/takes/captures).

- Every screen needs a proper empty state for a new project (described
  per screen above).

# 10. Implementation notes from the prototype (for engineers)

- Screens are self-contained components; the dock kit, nav, device menu,
  player bar and status bar are duplicated in each. In the product they
  are shared components.

- Each screen injects small window-level helpers at render: dock
  persistence (\_\_mycoDk), keyboard-safe floating fields (\_\_mycoKB),
  long-press to context menu (\_\_mycoLP). Make these shared services.

- Sliders are driven by window pointer events (native range drag broke
  under re-render); drags listen on the window and end on
  pointerup/cancel/blur or a buttonless move.

- Popovers float at the root and are clamped to the window; panels with
  open popovers are raised.

- Dropdowns in dialogs are custom floating lists positioned from the
  trigger's bounding box, flipping above when needed.

- Coarse-pointer CSS (@media (pointer: coarse)) provides touch sizes;
  touch-action rules prevent scroll/zoom conflicts.

# 11. Known gaps and open questions

## 11.1 Open questions (not decided)

- Exclusive snapshot groups (only the highest-priority snapshot in a
  group can be active)?

- Unify the per-sample undo tree with the fork tree, or keep two linked
  systems?

- Does a re-import of a shared source version every fork in one spanning
  step (recommended) or only the sample it was triggered from?

- Fork of a fork: cache only the final result, or each step?

- Take and Profiler: keep separate or merge into one Run view (Mix /
  Debug modes)?

- Take bottom mixer: add faders or keep meters with a link to the Mixer?

- Does the sequence timeline ship as its own container type, or compile
  down to layer containers with start offsets?

- The truncated part of a user comment on the trigger dialog ("Also
  being able to support simple check here and…") is unresolved; ask the
  user.

## 11.2 Known gaps (decided but not built)

- Engine resolution of multiple active snapshots (priority/combine) —
  only previewed in the dialog.

- Playlists undo doesn't include sequence timeline edits; timeline sync
  isn't an undo step.

- Playlist entries save only main curves (not morph/label/multiplier
  layers); after converting an old event to a playlist, other playlists
  still reference the old event.

- Sequence-level effects chain has no automation lanes yet.

- Automation: marquee for points, tension handles, Latch/Read modes.

- Waveform vertical zoom / dB ruler; zoom on Take and Profiler rulers.

- HTML drag-and-drop doesn't work on touch for Library → playlist; the
  "Add to playlist…" context menu and Move to… cover it; a touch drag
  polyfill or picker would close the rest.

- Tooltips are invisible on touch; move essential explanations into
  visible text or the planned Info pane.

- Command palette with rebindable shortcuts; global Info pane.

- Myco design-system tokens.json contrast updates.

- Loudness targets as project settings; integrated loudness over
  captures.

- Trial support for Mixer, Spatial, Take, Profiler.

- Status bar and meters are placeholders.

- Escape inside the canvas preview exits the preview (canvas behaviour,
  not the product).

# 12. Archive (superseded designs; do not build)

- **Standalone Sequencer screen**: now the Sequence view inside
  Playlists (the component file remains because Playlists embeds it).

- **Player-bar draft (TransportDraft)**: Layout A adopted on every
  screen; B and C were references.

- **Latency calibration board (Calibrate)**: built into the device menu
  on every screen.

- **Synth / Sound v4 / Sound v5**: one-voice synth with switch + blend
  space, voice settings and modulation matrix; replaced by playlist
  modes (Switch, Blend, Layer, Queue) plus clip/playlist effects and
  curves.

- **Patch**: cables graph; superseded (choose → playlist modes, shape →
  sequence curves, control → playback rules, output → playback Output).

- **Transitions / TransitionTimeline**: replaced by Switch change rules.

- **Music** screen: music segments are sequence content; transitions are
  change rules.

- **Curves draft, Axes concept, Playlist concept, Spatial v1, Event,
  Editor, Sampler, Segments**: earlier drafts whose ideas live in the
  shared Curves sub-window, Playlists and Spatial v2.

# Appendix A. Seed / demo content in the prototype (useful as test fixtures)

- **Samples**: brake_skid.wav (48 kHz mono 2.60 s; markers Lock-up,
  Release; loops; used by Vehicles › HoverBike › Brake),
  hover_engine_low_loop.wav, hover_engine_high_loop.wav,
  door_creak_02.wav ("Creak start" 0.420 s, "Latch" 2.850 s; two sampler
  loops), impact_metal_03.wav (baked high-pass 90 Hz + 80 ms fade-out),
  glass_shatter, door_open/close, ground impacts, wood/metal impacts,
  water splash, music loop at 120 BPM 4/4 (48 kHz stereo 22.0 s),
  vo_rider lines.

- **Playlists** (each demonstrates a pattern):

  - Footsteps: Surface (discrete) picks the set (Switch) with
    per-surface volume; Speed crossfades walk → jog → run (Blend 1D);
    each set picks a random take (Queue).

  - Rain: heavier rain adds layers on top instead of replacing (Blend 1D
    in Layer blend mode).

  - Breathing: emotion picks the set (Switch); stamina crossfades rested
    → tired → exhausted (Blend 1D); exhausted takes carry an envelope
    curve on stamina.

  - UI feedback: one sound reshaped by a value (pitch curve) in a Clip
    playlist.

  - Door: a Queue picking Round robin alternates open and close; a held
    creak needs a hold point, so that version is a sequence.

  - Destruction: material picks what breaks (Switch): Wood plays the
    Crate burst sequence, Metal a playlist of explosion sequences, Glass
    a single sample.

  - Fuel tank explosion: fireball holds at 3 s while held (hold point),
    then burns out.

  - Bike crash: contains Destruction and Bike impact as playlist clips
    (no cycles).

  - Charge-up: charge loop holds while held, then Charge release picks
    the payoff by charge level.

  - Bike impact (Switch by Surface: Dirt, Gravel, Wood, Metal, Water)
    with change rules.

  - Effect levels demo folder: Crash hits (Random; three clips with the
    same Distortion → "Move to playlist"), Crash debris (Random; only
    debris_02 has an EQ), Crash layers (Layer with a Compressor),
    sequence "Bike crash · effect levels" (Hit track plays Crash layers;
    Scrape track two clips with the same Low-pass → "Move to track";
    Tail track EQ, tail clip one-off Saturation; whole-sequence
    Compressor), output SFX › Vehicles (bus Compressor).

  - Sequences: Brake (Skid clip with volume envelope; hold loop while
    held), Engine (High track with Low-pass and lanes driven by rpm),
    Boost, Lead hook (Low-pass cutoff driven by intensity).

- **Buses**: Master (fx Limiter), SFX › Vehicles (Compressor) › Engine,
  SFX › Footsteps, SFX › Weapons, Ambience (fx, auto 2) › Rain (new,
  waiting), Dialogue (fx 2), Music (Sidechain compressor keyed by
  Dialogue; auto 1), UI; Return Reverb (← 3 sends); VCA Gameplay SFX (3
  buses).

- **Snapshots**: Gameplay (base mix), Low health (Health \< 20%;
  priority 10), Pause menu (Game state is Paused; priority 40),
  Cinematic (Game state is Cutscene; priority 30), Underwater (Water
  depth \> 0; priority 20).

- **Game parameters**: Health %, Threat, Time of day h, Water depth m,
  Game state, In combat, Surface; Playlists/sequences also use Speed,
  RPM, Brake, Boost, Intensity, Impact velocity, Stamina, Emotion,
  Pressure, Charge.

- **Spatial scene "Canyon run"**: Waterfall (12.5 m up, ambisonic bed),
  Generator, Campfire (HRTF), Drone (moving, 12 m/s), Wind zone (audio
  zone), Storm front (audio zone), Crate stack and Metal bridge
  (obstacles), Player 1 (listening), Canyon reverb zone (priority 1,
  default).

- **Take / capture "canyon_run_03"** (32 s): Engine instance (whole
  run), Boost (holds while Boost is held), Land/Jump/Brake impacts,
  Speed/RPM/Surface lanes; Profiler events: Boost blocked by voice limit
  1, Impacts stole a voice (limit 4), missing vo_rider_07.wav, Music
  Explore → Combat on next beat with stinger Hit, Dialogue ducking
  Music/Ambience by 6 dB, Bike impacts edited during Play at 00:20.000.

# Appendix B. Effect parameter reference (ranges and defaults from the prototype)

## B.1 Sample effects (baked)

| **Effect**             | **Parameters (min–max, unit, default)**                          |
|------------------------|------------------------------------------------------------------|
| EQ (v1.2)              | Low −12–12 dB (0); Mid −12–12 dB (0); High −12–12 dB (0)         |
| Filter (v1.0)          | High-pass 20–2000 Hz (20); Low-pass 1000–20000 Hz (20000)        |
| Compressor (v2.0)      | Threshold −40–0 dB (−18); Ratio 1–20 :1 (3); Make-up 0–24 dB (0) |
| Gain (v1.0)            | Gain −24–24 dB (0)                                               |
| Pitch shift (v1.1)     | Semitones −24–24 st (0); Fine −50–50 ct (0); keeps the length    |
| Fades (v1.0)           | Fade in 0–2000 ms (0); Fade out 0–2000 ms (50)                   |
| Saturation (v1.0)      | Drive 0–100 % (20); Mix 0–100 % (100)                            |
| Noise reduction (v3.1) | Amount 0–100 % (40)                                              |
| Reverse (v1.0)         | none                                                             |

## B.2 Clip / track / sequence / playlist effects

| **Effect**            | **Parameters**                                                                                                                                                                               |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Amp envelope          | Attack 0–2000 ms (5); Decay 0–2000 ms (200); Sustain 0–100 % (80); Release 0–3000 ms (300). Per voice: sustain while the clip plays (and while held), release when released or the clip ends |
| EQ                    | Low / Mid / High dB                                                                                                                                                                          |
| Low-pass              | Cutoff 20–20000 Hz (20000, log); Resonance 0–1 (0.1); Drive 0–100 % (0)                                                                                                                      |
| High-pass             | Cutoff 20–20000 Hz (20, log); Resonance 0–1 (0.1); Drive 0–100 % (0)                                                                                                                         |
| Band-pass             | Centre 20–20000 Hz (1000, log); Resonance 0–1 (0.3); Drive 0–100 % (0)                                                                                                                       |
| Compressor            | Threshold −60–0 dB (−18); Ratio 1–20 :1 (3); Attack 0.1–200 ms (10); Release 5–2000 ms (120)                                                                                                 |
| Saturation            | Amount 0–100 % (30)                                                                                                                                                                          |
| Distortion            | Drive 0–1 (0.3); Mix 0–100 % (100)                                                                                                                                                           |
| Bit-crush             | Bits 4–24 (12); Mix 0–100 % (100)                                                                                                                                                            |
| Formant shift         | Shift −12–12 st (0)                                                                                                                                                                          |
| Pitch shift           | Semitones −24–24 st (0)                                                                                                                                                                      |
| Delay (not on clips)  | Time 1–2000 ms (250); Feedback 0–95 % (30); Mix 0–100 % (25)                                                                                                                                 |
| Reverb (not on clips) | Size 0–1 (0.5); Decay 0.1–20 s (1.8); Mix 0–100 % (20)                                                                                                                                       |

- Base clip properties: Enabled (on/off), Volume −48–12 dB, Pitch −12–12
  st, Pan −100–100. Base track properties: Enabled, Volume −60–12 dB,
  Pan.

## B.3 Bus effects

| **Effect**                                                    | **Parameters**                                                                            |
|---------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| EQ                                                            | Low / Mid / High −18–18 dB (0)                                                            |
| Low-pass / High-pass / Band-pass                              | as B.2                                                                                    |
| Compressor                                                    | Threshold −60–0 dB (−18); Ratio 1–20 (3); Attack 0.1–200 ms (10); Release 5–2000 ms (120) |
| Sidechain compressor                                          | Key bus; Threshold −60–0 dB (−24); Ratio 1–20 (3); Release 5–2000 ms (300)                |
| Limiter                                                       | Ceiling −12–0 dBTP (−1); Release 1–1000 ms (50)                                           |
| Saturation, Distortion, Bit-crush, Formant shift, Pitch shift | as B.2                                                                                    |
| Delay                                                         | Time 1–2000 ms (250); Feedback 0–95 % (30); Mix 0–100 % (25)                              |
| Reverb                                                        | Size 0–1 (0.5); Decay 0.1–20 s (1.8); Mix 0–100 % (20)                                    |

# Appendix C. Build checklist (suggested order)

1.  Shared shell: nav, dock system with persistence and tablet rules,
    player bar, status bar, device menu + calibration, history popover,
    list/tree component with context menus and Move to…, colour picker,
    Curves sub-window, dropdown component, keyboard layer, touch layer.

2.  Project model + persistence (section 8) and the game parameter
    registry.

3.  Samples (import, metadata round-trip, timeline,
    loops/markers/snippets, edit graph + render cache, versions, forks,
    per-sample undo).

4.  Playlists (all six modes, entries, linked copies, playback rules,
    effects levels, Plays now/Voices) and the Sequence timeline (tracks,
    clips, Sync/Async, loops/hold points, automation, write automation).

5.  Mixer (bus graph, effects, sends, ducking, beds, voice limits, VCAs,
    gain lanes, loudness, snapshots + trigger dialog + priority/combine
    resolution, A/B, live mixing).

6.  Spatial (scenes, items, height/slab, side view, gestures, scene
    settings, attenuation/occlusion curves, replacements A/B).

7.  Take and Profiler (record, replay, lanes, instances, inspector, log,
    why-it-played graph, versions).

8.  Workflow Trials: run all journeys against the real build from an
    empty project.
