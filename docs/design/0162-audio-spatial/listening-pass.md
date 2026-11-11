# M3 listening pass: the spatial audio items (ADR 0162, task E10, #161)

The owner's listening pass for M3, the spatial milestone. It takes the owner's listening items from the [M3 waves plan](../../plans/2026-11-audio-spatial-m3-waves.md#milestones) (one group per milestone: M3a bed, M3b ambisonic clips, M3c zones, M3d occlusion, Doppler and event effects, F the Babylon fallback, M3e the lab VM) and gives each one a key or a scene. The M1 pass is [the audio core's listening pass](../0157-audio-core/listening-pass.md), the M2 pass [its events page](../0157-audio-core/m2-listening-pass.md).

**Nobody has auditioned this yet.** Every "you should hear" line is an intention to check, not a finding. Mark each item pass or fail, add a note, then sign at the end.

## Before you start

- **Build.** The commit you are signing, with the held bed flip applied (see below) for the M3a items.
- **Run.** `npm run dev`, open `/editor.html?sample=sound-lab`, press Play, click the game view once (sound starts after a gesture), then press **S** for the spatial page. **B** goes back to the tour. The spatial page's title card lists its keys.
- **Headphones.** Required, as in the M1 pass: HRTF and the bed cannot be judged on speakers.
- **Watch.** Window > Audio Debug (voices, buses, counters) and the browser console (`__myco.Audio.debug()`).
- **Changing configs.** The core reads its preset and backend when it starts. For each configuration, edit the `audio` block of `samples/sound-lab/project.json`, save, reload, Play and click again. Put the file back afterwards (`git checkout samples/sound-lab/project.json`).
- **Clips.** Start an item once Audio Debug lists the Music and the spatial sources as `playing` (not `waitingForData`).

### The held bed flip (M3a)

The bed flip (beds on, HRTF voices to 8) is **held for the owner**, not on the build by default. The M3a items below need it. Apply it on the integration branch first:

```
git am docs/design/0162-audio-spatial/flips/a6b-beds-on-hrtf-8.patch
```

Its state, and why it is held (the mixer is already past its 230 KB budget), is in [flips/README.md](flips/README.md). Without the flip, the M3a items measure the old default, so write "not applied" in the notes and skip them.

### Configurations

| Config | `audio` block changes in `samples/sound-lab/project.json` | Used by |
|---|---|---|
| A (default) | none | every item unless it says otherwise |
| B (low preset) | the low preset's `voices`, `clipMemoryMB` and `hrtf` as in `VOICE_PRESETS` (`src/plugins/audio/editor/audioSettingsModel.ts`), the same values the [M1 pass's Config B](../0157-audio-core/listening-pass.md#configurations) uses | Z4 (eviction fade) |
| C (high preset) | the high preset's values from the same table | Z5 (standby path, high) |
| F (Babylon fallback) | `"backend": "babylon"` | F1 to F4 |

Take B and C's numbers from `VOICE_PRESETS` at the commit you sign, not from this table.

### Keys on the spatial page

The spatial page's keys come from its own scene nodes (`samples/sound-lab/scenes/spatial.scene.json`), plus the listening bench on the listener.

| Key | What it does | Where |
|---|---|---|
| W / S | walk forward / back along the corridor (4 m/s) | `Walker.ts` on the Listener |
| 1 / 2 / 3 | jump to room A (z 11), corridor B (z 0), cave C (z -16): **teleports** | `Walker.ts` |
| F | open / close the door (wood, -12 dB closed; 0.8 s) | `Door.ts` on the Door |
| V | start / stop the Flyover pass-by (30 m/s, z 40 to -40, Doppler on) | `PassBy.ts`, `Toggle.ts` on the Flyover |
| 4 | a loud source 1.5 m away plus 200 quiet ones at 4 to 25 m, all at once (press again to add another burst) | `ListeningBench.ts`, `mode: "spatial"` |
| 5 | start / stop the **Bed orbit**: a hum going round the head at 3 m, overhead (+70 degrees) and below the floor (-70 degrees) once every 12 s | `ListeningBench.ts` |
| 6 | jump behind the west wall (x -3.2, z 0): the wall is between the listener and the corridor and room | `ListeningBench.ts` |
| 7 | jump to the cave's corner (x -2.6, z -20.5): outside the west wall, round the corner from the cave | `ListeningBench.ts` |
| 8 | turn the listener 90 degrees on the spot (press four times for a full turn) | `ListeningBench.ts` |
| 9 | stop the Bed orbit and the key-4 sounds | `ListeningBench.ts` |
| B | back to the tour | `SceneSwitch.ts` |

The keys 4 to 9 need the bench's scene setup described under [Scene setup](#scene-setup-for-this-pass) below. Without it, keys 4 to 9 do nothing and the items that use them cannot be run.

The sources in the scene: the **Radio** (music loop) behind the door in room A at z 12.5; the **Machine** (noise) in the cave at (0.8, 1, -18); the **Ambience** (first-order ambisonic, always on); the **Curtain** (cloth, at z -8) in the corridor.

## Items

Mark each item **pass**, **fail** or **pass with note**. A fail gets an issue; a note the owner accepts stays a note.

### M3a: the bed

Needs the held bed flip applied (above). Run in Config A.

#### B1. A source crossing the 8-voice HRTF boundary, both ways
- **Do:** press **4** (the burst fills the mixer and the HRTF set), then **V** (the Flyover comes past at 30 m/s, passing the listener at its closest).
- **Listen for:** as the Flyover's rank among the nearest sources crosses the 8 that get HRTF, its sound should keep its level and timbre. Listen both ways: as it comes in (it joins the HRTF set) and as it goes out (it drops to equal power).
- **Pass:** no dip in level, no jump in position or colour at either crossing. The change is smooth, about 45 ms (the equal-power and HRTF kinds crossfade over 45 ms).
- Result: [ ] pass [ ] fail
- Notes:

#### B2. Above and below
- **Do:** press **5** (the Bed orbit starts). Let it go round for 12 s.
- **Listen for:** at the top of its arc (+70 degrees) the hum should come from above. At the bottom (-70 degrees) it is below the floor, and it should still be there.
- **Pass:** the hum is clearly overhead and clearly below, and it does not vanish as it goes under the floor. A drop-out at the bottom is a fail on the floor-below check: it opens reserve R1 (the SADIE II set, [plan](../../plans/2026-11-audio-spatial-m3-waves.md)).
- Result: [ ] pass [ ] fail
- Notes:

#### B3. Behind and at the sides
- **Do:** press **5**, listen for one full turn (24 s), then press **8** to turn the listener and listen again.
- **Listen for:** the hum passing behind you (its move from front to back), and left and right. The Radio (behind the door, at z 12.5) is behind you when you start.
- **Pass:** behind sounds are behind, sides are at the sides, and the front-back is not swapped. The Radio's position is clear from the hum's.
- Result: [ ] pass [ ] fail
- Notes:

#### B4. The bed against HRTF
- **Do:** with the Ambience playing (it always is on this page), press **5** and listen as the hum crosses above and below the listener.
- **Listen for:** the Ambience is the bed: a wide, steady image. The hum is the HRTF voice. As the hum passes, the bed should stay steady and not gain or lose level.
- **Pass:** the bed does not pump, duck or shift when the HRTF voice comes and goes. The two can be heard apart.
- Result: [ ] pass [ ] fail
- Notes:

#### B5. A loud close source with 200 quiet ones
- **Do:** press **4** once, then again after 2 s.
- **Listen for:** the near source (1.5 m ahead and to the right) should stay sharp and in place. The 200 quiet sounds form a soft wash around you.
- **Pass:** the loud source is not masked and does not change level. The quiet ones start without clicks and do not pump. No crackle as they are stolen.
- Result: [ ] pass [ ] fail
- Notes:

#### B6. Idle silence
- **Do:** press **9** (stops the orbit and the key-4 sounds). Then with the bench quiet, listen for a while.
- **Listen for:** with the bench's sounds stopped, the page should not hiss or hum beyond the Ambience, the Radio and the Machine, which play on the page by design. **The sample has no key that silences those three.** So this item checks the bench's silence (Audio Debug shows no bench voices), and a true silence test (no sources at all) needs those three stopped another way, for example by the owner in the editor. Say in the notes if you did that.
- **Pass:** the bench's sounds stop cleanly (no tail beyond their fade) and nothing new appears: no noise floor from the bed or the HRTF path.
- Result: [ ] pass [ ] fail
- Notes:

### M3b: ambisonic clips

#### AM1. An ambience turned on the spot, first order
- **Do:** the Ambience is first-order (`ambience-o1.wav`). Press **8** four times, a quarter turn each, and listen for the full turn. Stop and repeat with **6** (wall) for a quieter room.
- **Listen for:** as you turn, the ambience's sources stay where they are in the room, not with your head. The image is clear and steady in each direction.
- **Pass:** the ambience turns against your head (it stays put in the room). No wrong-way image, no collapse to the centre.
- Result: [ ] pass [ ] fail
- Notes:

#### AM2. An ambience turned on the spot, third order
- **Scene needed:** this sample ships only first order. Generate a third-order clip with [`samples/sound-lab/tools/makeAmbisonic.mjs`](../../../samples/sound-lab/tools/makeAmbisonic.mjs):

  ```
  node samples/sound-lab/tools/makeAmbisonic.mjs --out <a scratch directory> --az 0 --el 0
  ```

  That writes `ambi-o3-az0-el0.wav` (16 channels) and a FuMa twin. Copy the 16-channel file to `samples/sound-lab/audio/`, add its `.meta.json` sidecar (`{"format":"myco.import@1","ambisonic":{}}`), and add a second ambience node (`engine.AudioSource`, the clip, `loop: true`, `output: "Ambience"`) to the spatial scene. That node is the owner's change, not this pass's (see [Scene setup](#scene-setup-for-this-pass)).
- **Do:** as AM1, with the third-order node playing and the first-order one stopped.
- **Listen for:** a tighter, more localised image than first order, turning on the spot with the same steadiness.
- **Pass:** the third-order image is sharper and stays put, with no added artefacts (zipper, pumping) as it turns.
- Result: [ ] pass [ ] fail
- Notes:

### M3c: zones

#### Z1. Rooms A, B and C with their reverbs
- **Do:** press **1**, then **2**, then **3** (teleports to the room, corridor and cave). Clap or press **1** (the UI click on the Master bus) at each station.
- **Listen for:** the three rooms sound different. The room (A, the 4 m box with the 0.6 wet preset) is short and close. The corridor (B) is longer. The cave (C, 0.7 wet) has the longest tail.
- **Pass:** each zone is recognisably its own space, the cave's tail is longest, and no zone sounds like the bare dry path.
- Result: [ ] pass [ ] fail
- Notes:

#### Z2. A source in A, heard from B
- **Do:** press **2** (corridor). The Radio plays in room A behind the door at z 12.5. Press **F** to open the door, and again to close it.
- **Listen for:** the Radio is heard from the corridor (B): with its own room's reverb coming through the open door, and muffled with the door shut.
- **Pass:** the Radio's sound has room A's character, not B's: a clear change when the door opens.
- Result: [ ] pass [ ] fail
- Notes:

#### Z3. Walking through zone edges, and the tails after leaving
- **Do:** press **1**, then walk with **S** (back) into the corridor and then the cave with **W**, slowly and then quickly. Then stand in the cave and walk back out.
- **Listen for:** at each zone edge (2 to 3 m blend) the reverb fades in and out. After you leave a zone, its tail decays on its own.
- **Pass:** no click or step at the edges; the cave's tail carries on past the edge and fades naturally.
- Result: [ ] pass [ ] fail
- Notes:

#### Z4. The low preset: the eviction fade (Config B)
- **Do:** in Config B, walk quickly from room A to the cave and back, several times.
- **Listen for:** on the low preset a zone's reverb slot is evicted and reused. The eviction is a 150 ms fade.
- **Pass:** no click at the eviction. The reverb fades rather than cutting, and the new zone's reverb comes in without a click.
- Result: [ ] pass [ ] fail
- Notes:

#### Z5. The standby path, and the shared reverb's level (Config C, or A)
- **Do:** in Config C (high), walk through room A, corridor B and cave C and back, several times.
- **Listen for:** a zone that is not in use goes to standby rather than being torn down. Coming back to it should not sound different. The shared reverb's level should not jump as zones are entered and left.
- **Pass:** no level jump, no gap, no click as the zones switch on and off. A returning zone sounds like it did.
- Result: [ ] pass [ ] fail
- Notes:

### M3d: occlusion, Doppler and event effects

#### O1. A wall
- **Do:** press **6** (behind the west wall). Listen to the Radio (room A) and the Machine (cave). Then press **1** (room) and listen to the same sources through open air.
- **Listen for:** through the wall the Radio and the Machine are muffled and quieter, not cut off, and they keep their pitch.
- **Pass:** the wall muffles (a low-pass, lower level), and the change is smooth as you move.
- Result: [ ] pass [ ] fail
- Notes:

#### O2. A door, open and closed
- **Do:** press **2** (corridor). Press **F** to open the door, listen to the Radio, then **F** again to close it and listen. Repeat, slowly.
- **Listen for:** open, the Radio is clear. Closed, it is muffled by wood (-12 dB).
- **Pass:** open and closed sound clearly different, and the change over the door's 0.8 s is smooth, with no click at the start or end of the move.
- Result: [ ] pass [ ] fail
- Notes:

#### O3. A corner
- **Do:** press **7** (the cave's corner, outside the west wall). Listen to the Machine, which is in the cave, round the corner.
- **Listen for:** the Machine is heard round the corner: muffled, with no direct sound from it.
- **Pass:** the Machine's sound is occluded as a corner would be, and it stays muffled as you walk (**W** and **S**) along the wall's edge.
- Result: [ ] pass [ ] fail
- Notes:

#### O4. The curtain (cloth)
- **Do:** press **2**, walk **W** through the corridor toward the curtain (z -8) with the Machine behind it.
- **Listen for:** cloth muffles less than wood or concrete: a light softening, not a wall.
- **Pass:** the curtain is lighter than the wall and the door.
- Result: [ ] pass [ ] fail
- Notes:

#### O5. A fast Doppler pass
- **Do:** press **V** (the Flyover at 30 m/s, the Doppler on).
- **Listen for:** as it comes toward you the pitch rises, and it falls as it goes away, about 9% each way.
- **Pass:** a smooth glide through the pass, with no stepped pitch and no sudden change at the closest point.
- Result: [ ] pass [ ] fail
- Notes:

#### O6. A teleport
- **Do:** press **V** to start the Flyover, then press **1**, **2**, **3** (teleports) and **6** and **7** (the stations), several times.
- **Listen for:** a teleport is a jump, not a motion: the Doppler should not register it as a fast move.
- **Pass:** no whoosh, no pitch glide, and no click at the jump. The Flyover carries on from where it is in the world.
- Result: [ ] pass [ ] fail
- Notes:

### F: the Babylon fallback

Set `audio.backend` to `"babylon"` in `samples/sound-lab/project.json` (Config F), reload and Play. The fallback has no zones and no per-voice occlusion filter, and it plays an ambisonic clip's W channel as mono. See [the spatial audio guide](../../guide/spatial-audio.md) for what the fallback does.

#### F1. Walls only lower the volume
- **Do:** as O1 and O2 (press **6**, then **2** and **F**).
- **Pass:** the walls and the door make the Radio and Machine quieter, with no muffling. The change is a volume change only.
- Result: [ ] pass [ ] fail
- Notes:

#### F2. No zones
- **Do:** as Z1 (press **1**, **2**, **3**).
- **Pass:** the rooms sound the same: no reverb changes between the stations.
- Result: [ ] pass [ ] fail
- Notes:

#### F3. Ambisonic plays W as mono
- **Do:** as AM1 (press **8** to turn).
- **Pass:** the ambience does not turn with the head as the core's does: it plays as a mono W channel. Expect no image; that is the fallback's known limit.
- Result: [ ] pass [ ] fail
- Notes:

#### F4. No Doppler on streams
- **Do:** as O5 (press **V**).
- **Pass:** the Flyover's pitch stays put through the pass: no Doppler shift on the streamed source.
- Result: [ ] pass [ ] fail
- Notes:

### M3e: the lab VM

These run on the owner's lab VM, not in a container. They are the numbers the presets are set from ([architecture §6.5](architecture.md)).

**The scenes.** `check:audio-metered` runs the bench's scenes through the metered wasm (`npm run check:audio-metered`; its scene list is in `tools/audio-bench/metered-gate.mjs`). The native and wasm bench runs take a scene name:

```
node tools/audio-bench/run.mjs mode=scene name=m3-worst-high seconds=60 runs=5
node tools/audio-bench/run.mjs mode=scene name=m3-worst-high-sends seconds=60 runs=5
node tools/audio-bench/run.mjs mode=scene name=m3-high seconds=60 runs=5
```

Each run prints one JSON line. Record **p50, p99 and p99.9** per scene (the spec's p99.9 is the lab VM's number; the container's tails are not asked for). `m3-typical` is the bench's **`m3-high`** scene (C7: architecture §7.2's typical high scene); `m3-worst-high` and `m3-worst-high-sends` are the worst case without and with zone sends.

| Scene | Run on | p50 | p99 | p99.9 | Notes |
|---|---|---|---|---|---|
| `m3-typical` (`m3-high`) | lab VM | | | | |
| `m3-worst-high` | lab VM | | | | |
| `m3-worst-high-sends` | lab VM | | | | |
| `m3-high` | lab VM | | | | |

- Result: [ ] pass [ ] fail (the owner's threshold: p99.9 against 0157's 1.3 ms and the modelled net, [api-and-models §10.3](api-and-models.md))
- Notes:

## Scene setup for this pass

The keys 4 to 9 on the spatial page, and the third-order items, need scene edits. Those are the owner's to make in `samples/sound-lab/scenes/spatial.scene.json`; this pass does not edit it. The change:

1. **The listening bench on the listener.** Add a component `lab.ListeningBench` to the **Listener (W, S walk)** node, with data:

   ```json
   { "mode": "spatial" }
   ```

   The other fields keep their defaults (`burstKey` "4", `orbitKey` "5", `wallKey` "6", `cornerKey` "7", `turnKey` "8", `silenceKey` "9"; the stations `wallX` -3.2, `wallZ` 0, `cornerX` -2.6, `cornerZ` -20.5).
2. **The Bed orbit.** Add a child node to the Listener named **Bed orbit** (the bench looks it up by that name), with `engine.Transform` and `engine.AudioSource`: clip `asset:audio/hum-loop.wav`, `loop: true`, `playOnAwake: false`, `spatial: true`, `dopplerLevel: 0`, `minDistance: 1`, `maxDistance: 40`, `volume: 0.5`, `output: "SFX"`.
3. **The third-order ambience (AM2 only).** A second node as described under AM2.
4. **The title card.** The spatial title (`Title`) should list keys 4 to 9 and the turn. The bench does not write it.

## Known gaps

- The spatial page's keys 4 to 9 are only live once the scene setup above is made.
- The sample has no key that silences the Ambience, Radio and Machine together (B6).
- The 16-channel stream and the held flip's other gates are not in this pass.

## Sign-off

| Field | Value |
|---|---|
| Date | |
| Build (commit) | |
| Bed flip applied (`git am`) | yes / no |
| Machine and OS | |
| Browser and version | |
| Output device and sample rate | |
| Headphones (model) | |
| Lab VM (for M3e) | |
| Signed by | |

| Item | A | B | C | F | Result | Notes |
|---|---|---|---|---|---|---|
| B1 HRTF boundary | ✓ | | | | | |
| B2 Above and below | ✓ | | | | | |
| B3 Behind and sides | ✓ | | | | | |
| B4 Bed against HRTF | ✓ | | | | | |
| B5 Loud close with 200 | ✓ | | | | | |
| B6 Idle silence | ✓ | | | | | |
| AM1 Ambience, first order | ✓ | | | | | |
| AM2 Ambience, third order | ✓ | | | | | |
| Z1 Rooms A, B, C | ✓ | | | | | |
| Z2 Source in A from B | ✓ | | | | | |
| Z3 Zone edges and tails | ✓ | | | | | |
| Z4 Eviction fade (low) | | ✓ | | | | |
| Z5 Standby path (high) | | | ✓ | | | |
| O1 Wall | ✓ | | | | | |
| O2 Door open and closed | ✓ | | | | | |
| O3 Corner | ✓ | | | | | |
| O4 Curtain | ✓ | | | | | |
| O5 Fast Doppler pass | ✓ | | | | | |
| O6 Teleport | ✓ | | | | | |
| F1 to F4 Babylon | | | | ✓ | | |
| M3e lab-VM benches | | | | | | |
