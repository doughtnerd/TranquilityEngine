# M3 listening pass: the spatial audio items (ADR 0162, task E10, #161)

The owner's listening pass for M3, the spatial milestone. It takes the owner's listening items from the [M3 waves plan](../../plans/2026-11-audio-spatial-m3-waves.md#milestones) (one group per milestone: M3a bed, M3b ambisonic clips, M3c zones, M3d occlusion and Doppler, F the Babylon fallback, M3e the lab VM) and gives each one a key, a scene and a configuration. The M1 pass is [the audio core's listening pass](../0157-audio-core/listening-pass.md), the M2 pass [its events page](../0157-audio-core/m2-listening-pass.md).

**Nobody has auditioned this yet.** Every "listen for" line is what the engine is built to do, checked against the code at master `1ef1c61` and after, not a finding. Mark each item pass or fail, add a note, then sign at the end.

## Before you start

- **Build.** Master (M3 merged). Beds are on by default since the bed flip (build log D27).
- **Run.** `npm run dev`, open `/editor.html?sample=sound-lab`, press **Play**, click the game view once (sound starts after a gesture and the click gives the game the keys), then press **S** for the spatial page. **B** goes back to the tour. The title card lists every key.
- **Headphones.** Required, as in the M1 pass: HRTF and the bed can't be judged on speakers.
- **Watch.** Window > Audio Debug: the voice table's **Panner** column shows which panner each sound uses (`hrtf`, `bed`, `ambisonic`, `equalPower`, `flat`), the **Occlusion** column its occlusion gain and cutoff, and the **Beds**, **Zones** (with a `why` for a silent zone) and **Occlusion** sections. In the browser's devtools console, `__myco.Audio.debug()` returns the same data.
- **Changing configurations.** The core reads its preset when it starts. For each configuration, edit the `audio` block of `samples/sound-lab/project.json` as the table below says, save, reload the page, Play, click and press **S** again. Put the file back afterwards (`git checkout samples/sound-lab/project.json`).
- **Clips.** Start an item once Audio Debug lists the page's sources as `playing`, not `waitingForData`.

### How M3's spatial audio behaves (what you are listening for)

- **HRTF and the bed.** The 8 most audible spatial sounds (the **Voices > HRTF** count) get their own HRTF. Every other spatial sound is mixed into its bus's **bed**: a shared 3rd-order ambisonic sound field around the listener, decoded to headphones once by a MagLS binaural filter. On this page the Master bus hosts a bed (SFX, where the Radio, Machine, Flyover and orbit play, uses Master's), and the Ambience bus has its own. A sound changing between HRTF and the bed crossfades over 45 ms; a sound leaving HRTF for the bed waits until 500 ms after its last change (so one hovering at the boundary doesn't flip back and forth); a sound joining HRTF doesn't wait.
- **Reverb zones follow the source.** Each spatial sound takes the reverb of the zone **it** is in (weighted across a zone's 2 or 3 m blend edge), as Wwise's rooms do: the Radio, in room A, always sounds of room A wherever you stand, and the Machine always of the cave. The listener's position matters for two things: the **ambience** (an ambisonic clip sends its W channel to the zones that hold the **listener**) and the shared bus reverb, which fades out as the listener goes inside zones. A source's send falls with distance (full up close, half at its `maxDistance`), independent of its dry rolloff.
- **Occlusion.** A wall between a source and the listener lowers its level and dulls it (a low-pass), per material: concrete -30 dB / 800 Hz, wood -12 dB / 2.5 kHz, cloth -4 dB / 8 kHz (starting values for this pass). Its reverb send drops by part of the same loss (the material's `wetOcclusion`), so a source behind a wall in a reverberant room still sounds reverberant.
- **Doppler.** A moving source's pitch rises toward you and falls away from you (OpenAL's formula, speed of sound 343 m/s). A jump (a teleport) isn't heard as motion.

### Configurations

Edit only the keys shown; leave the rest of the `audio` block as it is.

| Config | Add or change in the `audio` block of `samples/sound-lab/project.json` | Used by |
|---|---|---|
| A (the sample as shipped) | nothing (default preset: 8 HRTF voices, 2 beds, 1 ambisonic clip, zones 2 active + 1 standby, IRs cut at 2 s) | every item unless it says otherwise |
| B (low preset, eviction path) | `"voices": {"mixed": 64, "logical": 1024, "hrtf": 4}, "clipMemoryMB": 64, "bed": {"maxBeds": 0}, "ambisonic": {"maxClips": 1}, "zones": {"maxActive": 1, "standby": 0, "maxIrSeconds": 2}` | Z4 |
| C (high preset, 4 s IRs) | `"voices": {"mixed": 256, "logical": 4096, "hrtf": 8}, "clipMemoryMB": 256, "bed": {"maxBeds": 4}, "ambisonic": {"maxClips": 2}, "zones": {"maxActive": 2, "standby": 1, "maxIrSeconds": 4}` | Z1 (4 s), Z5 |
| D (one HRTF voice) | `"voices": {"hrtf": 1}` | B1, B2 (bed half), B4 |
| F (Babylon fallback) | `"backend": "babylon"` | F1 to F4 |

B and C are the editor's low and high presets (`VOICE_PRESETS` in `src/plugins/audio/editor/audioSettingsModel.ts`) plus the zone keys the presets don't set: B uses one zone slot with no standby (the eviction fade), C 4-second impulse responses.

### Keys on the spatial page

| Key | What it does | Where |
|---|---|---|
| W / S | walk forward (toward the cave) / back (toward the room) along the corridor, 4 m/s | `Walker.ts` on the Listener |
| 1 / 2 / 3 | jump to room A (z 11), the corridor B (z 0), the cave C (z -16): **teleports** | `Walker.ts` |
| F | open / close the door between the corridor and room A (wood; it opens over 0.8 s) | `Door.ts` on the Door |
| V | start / stop the Flyover: a hum passing overhead (6 m up) along the corridor at 30 m/s, from z 40 to -40 and back, Doppler on | `PassBy.ts`, `Toggle.ts` |
| 4 | a burst: one loud source 1.5 m away and 200 quiet ones 4 to 25 m away, all at once (press again for another) | `ListeningBench.ts` (spatial mode) |
| 5 | start / stop the **Bed orbit**: a hum 3 m from your head, going round you once every 24 s while its height swings between overhead (+70°) and below the floor (-70°) every 12 s. It is attached to the listener, so it moves and turns with you | `ListeningBench.ts` |
| 6 | jump behind the west wall (x -3.2, z 0): the wall, and the door, are between you and room A | `ListeningBench.ts` |
| 7 | jump outside the west wall beside the cave (x -2.6, z -20.5): the wall is between you and the Machine, 3.5 m away | `ListeningBench.ts` |
| 8 | turn the listener 90° on the spot (four presses make a full turn) | `ListeningBench.ts` |
| 9 | stop the orbit and the burst | `ListeningBench.ts` |
| 0 | stop every other sound on the page (Ambience, Radio, Machine, Flyover); press again to start them again | `ListeningBench.ts` |
| B | back to the tour | `SceneSwitch.ts` |

The page's sources: the **Radio** (music loop) in room A at z 12.5, behind the door (z 6); the **Machine** (noise loop) in the cave at x 0.8, z -18; the **Ambience** (a first-order ambisonic loop, always on, on its own bus's bed); the **Flyover** (key V). The **Curtain** (cloth) hangs across the corridor at z -8, between the corridor and the cave. The zones: **room** (preset `room`, wet 0.6, z 6 to 16), **corridor** (`corridor`, wet 0.6, z -8 to 6), **cave** (`cave`, wet 0.7, z -24 to -8, blend 3 m).

## Items

Mark each item **pass**, **fail** or **pass with note**. A fail gets an issue; a note the owner accepts stays a note.

### M3a: the bed

#### B1. A source crossing the HRTF boundary, both ways (Config D)
- **Do:** Config D (one HRTF voice). Press **2** (corridor), press **F** to open the door (so the Radio is loud enough to hold the HRTF voice while the Flyover is far), then **V**. Watch the Flyover's **Panner** cell in Audio Debug.
- **Listen for:** with one HRTF voice, the Flyover and the Radio compete for it. As the Flyover comes within about 20 m it becomes the most audible and moves from the bed to HRTF (and the Radio to the bed); as it leaves, it goes back to the bed (half a second after its last change). The Panner cell shows `bed` → `hrtf` → `bed`.
- **Pass:** no dip in level, no jump in position or tone at either change: a smooth 45 ms crossfade each way.
- Result: [ ] pass [ ] fail
- Notes:

#### B2. Above and below (Config A, then Config D)
- **Do:** in Config A press **5** and listen for at least 12 s (one swing up and down). The orbit is the nearest sound, so it uses HRTF (Panner `hrtf`). Then in Config D press **1** (room A, next to the Radio, which takes the one HRTF voice), press **5**, and listen again: the orbit is now in the bed (Panner `bed`).
- **Listen for:** at the top of its swing the hum is overhead; at the bottom it is below the floor and stays audible there. Both through HRTF and through the bed.
- **Pass:** clearly above and clearly below, with no drop-out under the floor, on both paths. The head-response data has nothing below -45° (the lower rows reuse -45°), so a weak or vanishing image below is the floor-below failure: it opens reserve R1 (the SADIE II data set, [waves plan, "Milestones"](../../plans/2026-11-audio-spatial-m3-waves.md#milestones)). Note which path failed.
- Result: [ ] pass [ ] fail
- Notes:

#### B3. Behind and at the sides
- **Do:** Config A. Press **5** and listen for a full 24 s circle. Then press **9**, press **1** (room A; the Radio is 1.5 m away along the corridor's axis) and press **8** four times, a quarter turn each, listening to the Radio at each step.
- **Listen for:** the orbit passing in front, to the sides and behind you; the Radio moving a quarter of the way round your head at each press (from its starting side, to one side, to the opposite side, to the other side) (the orbit is attached to you, so turning doesn't move it relative to your head; the Radio is fixed in the room).
- **Pass:** behind is behind, sides are at the sides, no front-back swap.
- Result: [ ] pass [ ] fail
- Notes:

#### B4. The bed against HRTF (Config D)
- **Do:** Config D. Press **1** (the Radio takes the HRTF voice), press **5** (the orbit goes to the bed), and compare the two. Then press **9**.
- **Listen for:** the orbit through the bed is a little wider and softer-edged than the Radio through HRTF, but placed in the right direction. The Ambience (its own bed) stays steady as the orbit moves.
- **Pass:** the bed's image is in the right place and stable; nothing pumps or shifts in level as the orbit moves.
- Result: [ ] pass [ ] fail
- Notes:

#### B5. A loud close source with 200 quiet ones (Config A)
- **Do:** press **4**, then again after 2 s.
- **Listen for:** the loud source, 1.5 m away, stays sharp and in place (it holds an HRTF voice). The 200 quiet sounds form a soft wash around you, most of them in the bed.
- **Pass:** the loud source isn't masked and doesn't change level; the quiet ones start without clicks or pumping; nothing crackles as voices are stolen.
- Result: [ ] pass [ ] fail
- Notes:

#### B6. Idle silence (Config A)
- **Do:** press **9** (stops the bench), then **0** (stops the page's other sounds). Audio Debug's voice table should be empty. Listen for 30 s, then press **0** again to bring the sounds back.
- **Listen for:** true silence: no hiss, hum or noise floor from the beds, the zones or the HRTF path while nothing plays.
- **Pass:** silence; the sounds stop with their short fades (no tail beyond them, no click) and come back cleanly.
- Result: [ ] pass [ ] fail
- Notes:

### M3b: ambisonic clips

#### AM1. An ambience turned on the spot, first order (Config A)
- **Do:** with the Flyover off and the bench stopped (**9**), press **2** (the corridor, between the Radio and the Machine, so the Ambience is the loudest thing), then press **8** four times, a quarter turn each, listening between presses.
- **Listen for:** the ambience stays put in the room as you turn, not with your head.
- **Pass:** it turns against your head, with no wrong-way rotation and no collapse to the centre.
- Result: [ ] pass [ ] fail
- Notes:

#### AM2. An ambience turned on the spot, third order (Config A)
- **Make the clip.** The sample ships only first order. Generate a third-order clip (a tone straight ahead, 16 channels):

  ```bash
  node samples/sound-lab/tools/makeAmbisonic.mjs --out samples/sound-lab/audio --az 0 --el 0
  ```

  It writes `ambi-o3-az0-el0.wav` (and other orders and a FuMa twin). Add the sidecar `samples/sound-lab/audio/ambi-o3-az0-el0.wav.meta.json` with `{"format": "myco.import@1", "ambisonic": {}}`, then point the **Ambience** node's `clip` in `samples/sound-lab/scenes/spatial.scene.json` at `asset:audio/ambi-o3-az0-el0.wav` (one ambisonic clip plays at a time in Config A: `maxClips` 1). Put both files and the scene back afterwards.
- **Do:** as AM1.
- **Listen for:** the tone starts straight ahead, and each quarter turn moves it a quarter turn the other way round your head; the image is tighter than first order.
- **Pass:** the tone stays fixed in the room as you turn, sharper than first order, with no zipper or pumping.
- Result: [ ] pass [ ] fail
- Notes:

### M3c: zones

#### Z1. Rooms A, B and C, with 2 s and 4 s impulse responses (Config A, then Config C)
- **Do:** in Config A press **1** and listen to the Radio in room A; press **3** and listen to the Machine in the cave; press **2** and listen to the Ambience's reverb in the corridor. Then repeat in Config C.
- **Listen for:** the Radio has room A's short, close reverb; the Machine the cave's long one (the cave preset rings for about 3.6 s, so in Config A, cut at 2 s, its tail is shortened with a fade; in Config C, at 4 s, it rings out in full). The Ambience takes the reverb of whichever zone you stand in.
- **Pass:** each zone is recognisably its own space, the cave's tail is longest, and the 2 s cut ends with a fade, not a click.
- Result: [ ] pass [ ] fail
- Notes:

#### Z2. A source in A heard from B (Config A)
- **Do:** press **2** (corridor). Press **F** to open the door, listen to the Radio, then **F** again to close it.
- **Listen for:** from the corridor the Radio still carries room A's reverb (the zone it is in), not the corridor's. With the door closed it is quieter and duller, and its reverb drops less than its direct sound (wood's `wetOcclusion` 0.5).
- **Pass:** room A's character comes through from B, open and closed, and the door's move is smooth.
- Result: [ ] pass [ ] fail
- Notes:

#### Z3. Walking through zone edges (Config A)
- **Do:** press **1**, then hold **W** to walk slowly through the corridor into the cave; then walk back with **S**, quickly.
- **Listen for:** the Ambience's reverb fades from room to corridor to cave as you cross each zone's blend edge (2 m; 3 m at the cave). The Radio keeps room A's reverb throughout, getting a little drier as you walk away (the send falls with distance). After you leave a zone, the reverb already playing decays on its own.
- **Pass:** no click or step at any edge; tails decay naturally.
- Result: [ ] pass [ ] fail
- Notes:

#### Z4. The eviction fade (Config B)
- **Do:** Config B (one reverb slot, no standby). Press **1**, listen, press **3**, listen; then walk from room A to the cave and back with **W** and **S**, several times. Watch the **Zones** section: one zone is active, the others read `faded: preset has 1 reverbs`.
- **Listen for:** the one reverb slot moves to whichever zone holds the most send energy near you (the Radio's room near A, the Machine's cave near C), with a 150 ms fade-out of the old zone before the new one fades in (100 ms). A zone needs 1.5 times the energy for half a second to take the slot, so it doesn't flip back and forth at the midpoint.
- **Pass:** no click at the eviction; the reverb fades out and the new one fades in.
- Result: [ ] pass [ ] fail
- Notes:

#### Z5. The standby path (Config C)
- **Do:** Config C. Press **1**, then walk through the corridor to the cave and back with **W** and **S**, several times.
- **Listen for:** three zones (room A for the Radio, the cave for the Machine, and the zone you stand in for the Ambience) share two active slots and a standby. A zone that loses its slot rings out in the standby slot while the incoming one starts, so no tail is cut. The shared bus reverb fades out as you enter the zones and back in as you leave, without a step.
- **Pass:** no gap, cut tail or click as zones change; a zone you come back to sounds as it did.
- Result: [ ] pass [ ] fail
- Notes:

### M3d: occlusion and Doppler

#### O1. A wall (Config A)
- **Do:** press **2**, press **F** to open the door, and listen to the Radio. Then press **6** (behind the west wall) and listen again. Close the door with **F** and listen once more.
- **Listen for:** from behind the wall the Radio is much quieter and duller (concrete), not cut off, and keeps its pitch; the door closing adds its own loss on top.
- **Pass:** the wall muffles and lowers the Radio; the change is smooth as the result settles (about 100 ms).
- Result: [ ] pass [ ] fail
- Notes:

#### O2. A door, open and closed (Config A)
- **Do:** press **2**. Press **F** to open the door and listen to the Radio, then **F** to close it. Repeat slowly.
- **Listen for:** open, the Radio is clear; closed, it is muffled by wood (about -12 dB, dull above 2.5 kHz).
- **Pass:** a clear difference, and a smooth change over the door's 0.8 s move, with no click at its start or end.
- Result: [ ] pass [ ] fail
- Notes:

#### O3. Close behind a wall (Config A)
- **Do:** press **7** (outside the west wall beside the cave, 3.5 m from the Machine). Listen, then press **3** (inside the cave) and compare. From **7**, walk along the wall with **W** and **S**.
- **Listen for:** from behind the wall the Machine is heard muffled, with no direct sound; inside the cave it is open.
- **Pass:** the wall occludes even this close, and stays occluding as you walk along it.
- **Known limit:** the page has no free wall end to step round, so the "round a corner" form of this item can't be heard here; note it.
- Result: [ ] pass [ ] fail
- Notes:

#### O4. The curtain, cloth (Config A)
- **Do:** press **2** and listen to the Machine through the curtain (z -8) and the corridor; walk **W** past the curtain into the cave and listen again.
- **Listen for:** cloth only softens a little (about -4 dB, dull above 8 kHz): far lighter than the door or the walls.
- **Pass:** the curtain is a light softening, clearly lighter than the door and the walls.
- Result: [ ] pass [ ] fail
- Notes:

#### O5. A fast Doppler pass (Config A)
- **Do:** press **2**, then **V**. Let it pass a few times.
- **Listen for:** the pitch rises as the Flyover approaches and falls as it goes away, by about 9% each way (30 m/s against 343 m/s), gliding through the closest point.
- **Pass:** a smooth glide, no stepped pitch, no jump at the closest point.
- Result: [ ] pass [ ] fail
- Notes:

#### O6. A teleport (Config A)
- **Do:** with the Flyover running (**V**), press **1**, **2**, **3**, **6** and **7** in turn, several times.
- **Listen for:** each jump moves you at once; the Flyover's pitch doesn't swoop at the jump (a jump faster than 150 m/s is treated as a teleport, not motion).
- **Pass:** no whoosh, no pitch glide and no click at any jump.
- Result: [ ] pass [ ] fail
- Notes:

### F: the Babylon fallback (Config F)

The fallback (Babylon's audio engine) plays the same scene with less: no beds (the browser's own panner places every sound), no reverb zones (one console warning), occlusion as volume only (no low-pass), an ambisonic clip as its W channel in mono, and Doppler on decoded clips only. See [the spatial audio guide](../../guide/spatial-audio.md#the-babylon-fallback).

#### F1. Walls only lower the volume
- **Do:** as O1 and O2 (press **6**, then **2** and **F**).
- **Pass:** the walls and the door make the Radio quieter, with no muffling; the console warns once that the cutoff is dropped.
- Result: [ ] pass [ ] fail
- Notes:

#### F2. No zones
- **Do:** as Z1 (press **1**, **3**, **2**).
- **Pass:** no zone reverb anywhere; the console shows one warning that reverb zones need the audio core.
- Result: [ ] pass [ ] fail
- Notes:

#### F3. Ambisonic plays W as mono
- **Do:** as AM1.
- **Pass:** the Ambience is a mono sound that doesn't turn as you do (the fallback's known limit), with one console warning.
- Result: [ ] pass [ ] fail
- Notes:

#### F4. Doppler on a decoded clip
- **Do:** as O5 (press **2**, then **V**).
- **Pass:** the Flyover's pitch still shifts (its clip is decoded, so the fallback applies the factor to its playback rate). Only streamed clips play without Doppler on the fallback; none on this page streams.
- Result: [ ] pass [ ] fail
- Notes:

### M3e: the lab VM

These run on the owner's lab VM, not in a container. They set the presets' M3 numbers ([architecture §7.2–§7.5](architecture.md); [api-and-models §9](api-and-models.md)).

**The scenes.** The bench runs a scene by name, natively and in Node's wasm. Use the method of architecture §7.5: paced, at least 5 runs of 60 s:

```bash
node tools/audio-bench/run.mjs mode=scene name=m3-high pace=1 seconds=60 runs=5
```

```bash
node tools/audio-bench/run.mjs mode=scene name=m3-worst-high pace=1 seconds=60 runs=5
```

```bash
node tools/audio-bench/run.mjs mode=scene name=m3-worst-high-sends pace=1 seconds=60 runs=5
```

Each run prints one JSON line. Record **p50, p99 and p99.9** per scene. `m3-high` is the design's `m3-typical` (§7.2's typical high scene); `m3-worst-high` is the worst case with idle zone slots, `m3-worst-high-sends` the same with zone sends flowing. For reference, the shared container measured zone and ambisonic costs at about 1.5 to 2 times the model ([build log](build-log.md)); this run settles them.

| Scene | Run on | p50 | p99 | p99.9 | Notes |
|---|---|---|---|---|---|
| `m3-high` (`m3-typical`) | lab VM | | | | |
| `m3-worst-high` | lab VM | | | | |
| `m3-worst-high-sends` | lab VM | | | | |

- Result: [ ] pass [ ] fail (against 0157's 1.3 ms and the modelled net, [api-and-models §9 and §10.3](api-and-models.md))
- Notes:

## Known gaps

- The page has no free wall end, so a "round the corner" occlusion check isn't possible here (O3).
- The 16-channel ambisonic stream isn't part of this pass (it's covered by tests: a 60 s loopback with seeks and loops, and the 300 ms stall test).
- WebKit and Firefox: run the core items in each if the milestone is signed for them.

## Sign-off

| Field | Value |
|---|---|
| Date | |
| Build (commit) | |
| Machine and OS | |
| Browser and version | |
| Output device and sample rate | |
| Headphones (model) | |
| Lab VM (for M3e) | |
| Signed by | |

| Item | A | B | C | D | F | Result | Notes |
|---|---|---|---|---|---|---|---|
| B1 HRTF boundary | | | | ✓ | | | |
| B2 Above and below | ✓ | | | ✓ | | | |
| B3 Behind and sides | ✓ | | | | | | |
| B4 Bed against HRTF | | | | ✓ | | | |
| B5 Loud close with 200 | ✓ | | | | | | |
| B6 Idle silence | ✓ | | | | | | |
| AM1 Ambience, first order | ✓ | | | | | | |
| AM2 Ambience, third order | ✓ | | | | | | |
| Z1 Rooms A, B, C (2 s, 4 s) | ✓ | | ✓ | | | | |
| Z2 Source in A from B | ✓ | | | | | | |
| Z3 Zone edges and tails | ✓ | | | | | | |
| Z4 Eviction fade | | ✓ | | | | | |
| Z5 Standby path | | | ✓ | | | | |
| O1 Wall | ✓ | | | | | | |
| O2 Door open and closed | ✓ | | | | | | |
| O3 Close behind a wall | ✓ | | | | | | |
| O4 Curtain | ✓ | | | | | | |
| O5 Fast Doppler pass | ✓ | | | | | | |
| O6 Teleport | ✓ | | | | | | |
| F1 to F4 Babylon | | | | | ✓ | | |
| M3e lab-VM benches | | | | | | | |
