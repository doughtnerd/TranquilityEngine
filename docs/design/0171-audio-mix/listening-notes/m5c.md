# M5c listening section: live mixing and level ducking (ADR 0171 amended by 0172 and 0173, task LSc)

The owner's section for milestone M5c: **the Mixer panel's faders** (the zipper test), **structural edits and their dip** (a bus moved, a bus inserted mid-tree, a bus removed), **level ducking against presence ducking on the same target**, and **Compare**. It is the third of three M5 sections ([m5-0.md](m5-0.md), [m5b.md](m5b.md); Ls1 joins them into `listening-pass.md`).

It was written from the running Sound Lab and the Audio Mixer panel, with its headless walker beside it (`tests/e2e/audio-mix-listening.spec.ts`, cases `M5c`), not from the design. The numbers below are what the walker reads in the page. **Nobody has auditioned this yet:** every "correct" line is what the engine is built to do and the walker's readings agree with, not a finding. Mark each step **heard OK** or **issue** (with a note) in the sign-off block at the end.

What this section is for. The tests read gains, duck lanes and counters; they cannot say that a fader moves without zipper noise, that a bus moved mid-sound dips cleanly instead of clicking, or that a level duck sounds like a mixer's and not like a switch. That is the ear's job here: the walker proves each edit reached the core and landed where it should; you say whether it sounded right on the way.

## What you need

- **Headphones or monitors, volume at a comfortable level before you start.** The voice loop and the music are at normal level; nothing here is much louder than the page was in the earlier sections. Wired if you can. Chromium (Chrome or Edge), or the desktop editor.
- The repository with M5c built (`npm install` once, then `npm run test:e2e:install` for the walker).
- **A writable copy of the Sound Lab.** The sample opens read-only (a live edit in it is shown but neither reaches the mixer nor is saved). In the editor's start screen choose the Sound Lab and **copy it to an empty folder**; the copy opens. Everything below is done in the copy; throw it away afterwards. (The walker does the same with an in-memory copy.)

### Run it

```bash
npm run dev
```

Open `http://localhost:3000/editor.html`, open the Sound Lab copy, press **Play**, and click the game view once (sound starts after a gesture, and the click gives the game the keys). On the tour page press **-** to go to the Mixer page (**B** goes back). Then open **Window > Audio Mixer**: the Audio Mixer and the Project panel are tabs of the same dock, so use the tab (or the Window menu) to go between the strips and **Project > Audio**.

To let the walker prompt you step by step and check each step afterwards (it waits for the page to show what you did, reads it, and says in the terminal which step ran as built):

```bash
E2E_LISTEN=1 npm run test:e2e:slow -- audio-mix-listening --headed --workers 1 -g "M5c \(owner"
```

A card over the page lists the keys; the terminal prints `[listen] M5c: ...` with what to do. The spec never times out while it waits for you.

The same walk without you (the headless check; it proves the page does what the steps say, not how it sounds):

```bash
npm run test:e2e:slow -- audio-mix-listening --project chromium-slow --workers 1 -g M5c
```

It has two cases: `M5c (owner or headless)` (S1 to S4 below, doing the actions itself) and `M5c (listen mode)` (the same page at human pace: a late key, a quick double tap, a held key; step S5).

## The test material (what each control does)

| Control | Does | Detail |
|---|---|---|
| **1** (game view) | the **voice** on or off | `audio/mixer/voice-loop.wav`, on the Voice bus: a speech-like loop with phrases and gaps |
| **2** | a **burst** on SFX | `audio/burst.wav`, once |
| **3** | the **tour**: the page cycles the triggers (the voice alone, a burst alone, both, quiet) | for hands-free listening |
| **4**, **5** | the Music bed, the Ambience bed on or off | |
| **D** | the readout: each ducked bus's duck lane (`Bus.duckGain`, 1 = not ducked) | |
| Mixer panel fader | the bus's volume; **arrows** move it 0.02 of its travel, **PageUp/PageDown** 0.1, **Home/End** the ends, **Shift or Alt** a tenth of that, **double-click** unity, a drag follows the pointer (**Shift** a tenth) | every key press and every released drag is **one** edit and **one** undo step; the travel is a dB scale, unity at three quarters |
| Mixer panel **M**, **MM**, **S** | mute (saved), monitor mute, monitor solo (neither monitor control is saved) | |
| Mixer panel **Compare** | plays the **saved mix from Play start**, faders locked, until switched off | saves nothing |
| **Project > Audio** | the buses' parents (the select beside each name), **+ child**, **×** | structural edits |
| **Undo** (Project panel's toolbar) or **Ctrl+Z** with a fader focused | one step back, in one shared history | |

The project's rules: **SFX ducks Music** (presence: while a sound plays on SFX, Music goes to 0.3, attack 0.05 s, release 0.4 s); **Voice ducks Music** (level: RMS detector, threshold -30 dBFS, Music to 0.35, attack 0.05 s, release 0.5 s); **Voice ducks Ambience** (level: peak detector, threshold -20 dBFS, Ambience to 0.5, attack 0.1 s, release 0.8 s). A level rule follows how loud the trigger is, not whether it plays: the voice's gaps release it.

## Setup (S0, do it once)

Play the copy, press **-**, open the Audio Mixer. You should see one strip per bus (Master, Music, SFX, Ambience, UI, Filters, Tape, Load, Foley, Engine, Voice) with the music and the bed audible, the **Music** and **Ambience** strips showing a **gain reduction meter** (they are targets of a level rule, so it shows even at rest), and the loudness readouts on Master and UI. Press **D** in the game view for the duck readout.

**Walker:** the Mixer page's behaviour is up, the Voice bus exists, the buses are live.

## The steps

Do them in order the first time. Each leaves the page as it found it; Undo brings an edit back.

### S1. Level against presence, on the same target. Keys **1**, **1**, **2**, **1** then **2**, **1**

- **Press 1 and listen.** Correct: the voice plays and **Music dips inside each phrase and comes back in the gaps**; the bed (Ambience) dips too, less (to 0.5, slower to come back). The Music strip's gain reduction meter follows: about **-9.1 dB** at the bottom of a dip (0.35), the Ambience strip's about -6 dB. The dip is a **smooth duck**, not a click or a step; the release is a little slower than the attack.
- **Press 1 again.** Correct: the voice stops and both ducks release to 0 dB within about a second and a half.
- **Press 2.** Correct: a short burst on SFX; **Music dips to 0.3 (-10.5 dB) for as long as the burst plays** and releases. This is the presence rule: it does not care how loud the burst is, only that it plays.
- **Press 1, wait a moment, press 2 inside the voice.** Correct: Music takes **the lower of its two ducks** (about 0.3 while the burst plays, 0.35 otherwise), with no jump when the second rule joins.
- **A defect sounds like:** the dip arriving as a click or an audible step (the attack is 50 ms; a step is a bug); Music pumping on every syllable (the RMS detector is 10 ms; the follower's 0.5 s release should smooth the phrase gaps); the bed not dipping at all, or dipping as deep as Music (peak -20 and 0.5 are different from RMS -30 and 0.35); a duck that stays after the sound ends. **A defect reads like:** the readout's duck lane stuck below 1 with nothing playing; the lowest reading under 0.3.
- **Walker confirms (not by ear):** the voice plays on Voice; over 7 s of the audio clock Music's duck lane reaches 0.30 to 0.42 and Ambience's 0.45 to 0.56; stopping releases Music to 1 (within 0.005); a burst takes Music to between 0.26 and 0.36; the two together take it under 0.36.

### S2. The fader: keys, and the zipper test. Down arrow x5, then Undo x5

- **Click Music's fader (or Tab to it) and press the Down arrow slowly, five times.** Correct: Music steps down in small, even level steps, **each press one smooth change** (a 10 ms ramp), with no crackle or zipper noise; the strip's readout, the authored value and the effective gain beside it follow each press. Then **hold** the Down arrow for a second: the level glides down; **it must not buzz, crackle or stair-step audibly** (this is the zipper test: every auto-repeat is its own committed edit, ramped).
- **Drag the fader** up and down with the mouse, quickly and slowly. Correct: the level follows the pointer while the button is down, with no zipper; letting go keeps the value. **Escape during a drag** puts the start value back. **Shift-drag** moves a tenth as far. **Double-click** puts the fader on 0 dB.
- **Press Ctrl+Z with the fader focused** (or the Undo button, Project panel), five times. Correct: Music climbs back through the same five values to where it was, **one press one step**, smoothly; **Ctrl+Shift+Z** goes forward again.
- **A defect sounds like:** a zipper (a buzz or grain while the fader moves), a click at the start or end of a drag, a step bigger than the key's size, or a value that jumps on release. **A defect reads like:** the effective gain not following the authored value; an undo that takes more than one press per key; a drag that saves before release.
- **Walker confirms:** after five Down presses the saved volume of Music is under its start and the effective gain equals it (within 0.001); five undo steps restore the starting value exactly; no record was late, early or refused.

### S3. Structural edits and the dip. In **Project > Audio**: Engine's parent, **+ child**, **×**

- **Set Engine's parent to Music** (the select beside Engine's name; open Engine's row if it is folded). Correct: **a very short dip** (20 ms down, 20 ms up, on the audio thread) and Engine sits under Music: its effective gain is now its volume times Music's. No click. **Press Undo:** another dip, and Engine is back under Master.
- **Press + child on Music**, then **set Engine's parent to the new bus**: a bus inserted between Music and Engine. Correct: the new bus appears at once (a direct edit, no dip), the move is one dip, Engine's level is as before the insert.
- **Press × on a bus with sounds on it** (the walker uses **Load**): the bus leaves the mixer and the Mixer's strips at once, its sounds **dip and move to Master**, and keep playing; **Undo** brings the bus back.
- **A defect sounds like:** a click, pop or burst at a dip; a bus's sounds stopping instead of moving to Master on a removal; a level that lands somewhere other than the product of the tree; a dip longer than a few tens of milliseconds. **A defect reads like:** a strip that does not move to its new depth; a removed bus still in the strips; an Undo that leaves the bus gone.
- **Walker confirms:** the saved parent changes and Engine's effective gain lands on Engine's volume times Music's (within 0.001), and back after Undo; the added bus exists live; after the removal no voice remains on the removed bus; after the three undos the tree is as it was; `traps`, `busRecordsEarly`, `sidechainLate` and `liveRefused` are unchanged across all of it (`lateCommands` is read and reported: in this whole-Sound-Lab page one or two records reach the core a quantum late in about half of the runs, under load). **Limit:** the dip's shape (the 20 ms V on the dip lane) and its click-freedom are the core's goldens' and `Ck1`'s checks; headless Chromium can read the meters at a few readings per dip, not the dip.

### S4. Compare. Down arrow x3, then **Compare**, then **Compare**

- **Press Down three times on Music's fader**, then **press Compare.** Correct: Music jumps back to its **Play-start level** (a quick smooth fade, no click), a banner says you are hearing the saved mix and the faders are locked (arrows do nothing). **Press Compare again:** your edit is back. Nothing was saved by Compare; **Ctrl+Z** x3 undoes the three presses.
- **A defect sounds like:** a click at either switch; Music not changing level on Compare; the faders still moving while it is on. **A defect reads like:** the saved value changing during Compare.
- **Walker confirms:** with Compare on Music's effective gain equals the Play-start volume and `project.json` still holds the edited one; off, the edit is back; three undos restore the Play-start value.

### S5. The owner's way: late, twice, held

You press at human pace, and not always at a good moment. These are the cases the headless walker also runs in its `M5c (listen mode)` case; do each once by ear.

- **A late key.** Leave the page alone for about 12 seconds, then press **1**. Correct: exactly S1: Music ducks inside the phrases at once. A defect: the first voice after a long idle starts late or does not duck.
- **A key twice.** Press **2** and **2** again a quarter of a second later. Correct: two bursts, Music at 0.3 for as long as either plays, released afterwards, no jump when the second starts. A defect: a stuck duck, or Music popping back up between the bursts.
- **A key held.** Focus Music's fader and **hold the Down arrow** for a second. Correct: the level glides down with no zipper; **each repeat is one edit** and the held key is as many undo steps (press Ctrl+Z until it is back). A defect: a buzz while it moves, or a value that does not follow.
- **Walker confirms (listen-mode case):** a key after 12 s idle still ducks Music to 0.30 to 0.42; two bursts a quarter second apart take Music under 0.36 and it is released; holding the Down arrow lowers the fader, never raises it, the effective gain follows, and at least four undo steps bring it back.

## What the walker cannot do

- **Hear.** Headless Chromium has no sound output: every "correct" and "defect" sentence above about how it sounds (a duck's smoothness, a dip's click, the zipper) is yours. The walker reads gains, duck lanes, saved values and the engine's record counters. The objective checks of the same things (the `maxStep` of the Mixer page in the goldens, the click tests of the dip) are the goldens'.
- **Show a dip.** The meters report a few readings per 40 ms; the walker reads where the level lands, not the V.
- **Open the sample itself.** The Sound Lab is read-only, so the walker (and you) edit a copy. In the read-only sample the Mixer panel shows an edit's value and nothing hears it.
- **Add a fifth effect through the Project panel.** A fifth effect on a bus is a problem of the draft (the audio core runs four), so the panel does not save it; the refusal's message ("applies at the next Play") is `audio-mix-c.spec.ts`'s check through the mixer, not a step here. The same file has a `fixme` case for an edit with no live path showing the Mixer's "Applies at the next Play" banner.

## Sign-off

| Step | Control(s) | Heard OK / issue | Note |
|---|---|---|---|
| S0 | Play, -, Window > Audio Mixer, D | | |
| S1 | 1, 1, 2, 1 then 2, 1 | | |
| S2 | Down x5, drag, Escape, Undo x5 | | |
| S3 | Engine's parent, + child, ×, Undo x3 | | |
| S4 | Down x3, Compare, Compare | | |
| S5 | 1 late, 2 twice, Down held | | |

Walker run (owner mode, or headless): pass / fail, date, note. Output device, machine and the volume you worked at:

Signed:
