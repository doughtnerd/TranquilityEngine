# L2: corrections to `listening-pass.md` (the coordinator applies them)

What changed on the sample side: the Sound Lab's music and rhythm pages have on-screen buttons and take a pointer press as a tap; the music page starts the eight-stem and A, B, C events itself (keys 4 and 5); D shows a music readout (`leadMs`, `primeEmaMs`, `lateGroups`, `groupsHeld`) on the music and rhythm pages; Flappy shows the same readout on M (a round note button in the corner on a touch screen); a page can claim the keyboard so the main page's handlers stay quiet; Flappy's town music dips on game over; the tour page has buttons to reach the other pages.

## "What you need" table, phone row

| **A phone** (**P**) | the Flappy town music (A5), the Sound Lab's music page (A1 and A4 by hand, B1 to B10) and rhythm page (C1 to C5) through their on-screen buttons, the device probe (R1, R2, R3, R5, R6, R7, R8, R9) and the prime lead (P1) | The Z items and A2 and A3 stay on the desktop (the spec's own keys and the paused decoder). Two phones for R8. |

## "Run it (phone and the real-device probe)": after the Flappy export, add

The Sound Lab is an export too (it is the same kind of page as Flappy; tap once to unlock the audio):

```bash
npm run export -- samples/sound-lab --out /tmp/lab-web --target web
cd /tmp/lab-web && node serve.mjs 8083
```

Android: `adb reverse tcp:8083 tcp:8083`, open `http://localhost:8083/`. The tour page has four buttons along the bottom (Events, Spatial, Music, Rhythm); the music and rhythm pages have a button for each of their keys, Back included. On the rhythm page a press anywhere on the game view is a tap (SPACE's form), timed from the pointer event's time stamp. A phone has a big, slow audio path: calibrate (C2) on the phone before the tap game (C4).

## Part 1 (Z): the scene paragraph, last sentence

Replace "The spec takes keys 0 to 5 before the Sound Lab's own handlers see them (on this page 1 is a click and a beep, 4 the Underwater snapshot, 5 a burst), so only the item and the crowd are heard." with:

"The spec claims the keyboard (`globalThis.__soundLabKeys.claim()`, from `samples/sound-lab/scripts/keyScope.ts`), so the Sound Lab's own handlers for the same keys (on this page 1 is a click and a beep, 4 the Underwater snapshot, 5 a burst) stay quiet and only the item and the crowd are heard."

(The spec's capture-phase `keydown` workaround can go once it calls `claim()`; see the report.)

## Part 2 (A): the scene paragraph, add

"The music page (M from the tour) also starts two of these itself: **4** plays the eight-stem event (`audio/music/music-stems8.audioevent.json`: A1's eight stems, on the Music bus, looping) and **5** the A, B, C playlist (`music-list3.audioevent.json`: A4's items, once through, about 12 s). That is how a phone runs A1 and A4. A2 (the held-back ring) and A3 (the paused decoder) have no page."

## Part 3 (B) and Part 4 (C): add to each scene paragraph

B: "Every key has a button along the bottom of the view (B is Back); **D** shows the music readout under the label."
C: "Every key has a button along the bottom of the view; a press on the game view is a tap, like SPACE, timed from the pointer event's own time stamp (a mouse click does the same). **D** shows the music readout under the label."

## Part 4 (C), "You tap with the SPACE bar" sentence

"You tap with the SPACE bar or by pressing the game view, timed by the event's own time stamp."

## A5 row, "Listen for", append

"At game over the town music dips to about a third of its level (0.4 s) and comes back when the next run starts; it never restarts or gaps across the restart."

## Part 6 (P1): the row

| P1 | The prime lead on a phone, with the Flappy town music running | Export Flappy (above), open it on the phone, tap to start. Press the round note button in the bottom-right corner (a keyboard's **M** does the same): the top-left of the view shows `music town`, `lead`, `prime` (the smoothed prime time, with the last one) and `late`, `held`, refreshed four times a second. After the town music has played 30 s read it (a photo of the screen will do). Remote DevTools still works: `JSON.stringify(__myco.Audio.debug().music.map(r => ({asset: r.asset, lead: r.leadMs, ema: r.primeEmaMs, last: r.primeLastMs, late: r.lateGroups, held: r.groupsHeld})))` | `lead`, `prime` (`primeEmaMs`, and the last), `late`, `held`, with the phone model and the browser. Expect the lead to settle near 100 ms at 60 Hz on a fast desktop (seed 40 ms); a phone's is the finding. `late` and `held` should stay 0; a "prime lead is longer than one beat" warning in the console is expected where the estimate is large | P |

And the paragraph below it: "The one streamed town stem is the lightest group the engine primes. The eight-stem group (music page, key 4, then **D**) is the heavier one: run it on the phone too and note its `lead`, `prime`, `late` and `held` beside P1's."

## Limits and gaps

Replace the second, third and fourth bullets with:

- **Z, A2 and A3 are desktop-only.** Z's keys and A2's delayed ring and A3's paused decoder are the spec's own (the main page with a claimed keyboard, the DevTools protocol). The music and rhythm pages, and A1, A4 and A5, run on a phone through their buttons and taps.
- **The prime lead has an on-screen readout** on Flappy (M, or the note button on a touch screen) and on the music and rhythm pages (D, or the button). The numbers come from `Audio.debug().music`; the readout refreshes four times a second and only while it is on.
- **A phone page for the 8-stem group exists** (music page, key 4); A2's held-back ring and A3's pause still have none.
- **Touch taps are timed from the pointer event's stamp, not the frame's,** like SPACE; whether a touch screen's `event.timeStamp` lags is R3's measurement.
