# Owner list: ADRs 0451 and 0452

Choices the RFC round surfaced that are the owner's, not the records'. Design step 5 asks only for the direction;
these are answered at step 8, after the technical design, unless one can't wait. One numbering for both records.
Each has options, a recommendation and its net effect. Estimates are provisional table-days.

1. **Where the profiler's contract lives** (0452). The owner said the profiler lives in the Studio for now. The
   architect points out that plugins' diagnostics views import the profiler's contract, so if it sits in
   `src/studio/`, plugins import the Studio app, and a later editor host imports it too.
   - (a) `src/studio/profiler/` now, moved later.
   - (b) A neutral `src/profiler/` for the contract and views kit; the Studio still hosts it and is its only host.
   - Recommendation: (b). Net effect: no extra work now (same files, different folder); avoids a second move later.
   - **Owner, 2026-11-28: (b), a neutral `src/profiler/`.**
2. **`t()` stays in the engine** (0451). The confirmed summary moved `t.ts` to the plugin; the senior engineer found
   the UI plugin's renderer imports it, so moving it makes `myco.ui` depend on localisation.
   - Recommendation: keep `t.ts` (and `message/`, `strings/`) in the engine. Net effect: −3 to −5 table-days; the
     plugin owns where strings come from and the tools, not formatting.
   - **Owner, 2026-11-28: accepted; `t.ts` stays in the engine.**
3. **The capture cap and what audio always records** (0452). Today a capture is 64 MiB, profile only; a take 256 MiB
   with requests never dropped and optional pictures (0348).
   - (a) 256 MiB; audio's requests always recorded (log), pictures only when asked.
   - (b) 64 MiB; requests always recorded.
   - (c) 256 MiB; requests and pictures always.
   - Recommendation: (a). Net effect: none on the estimate; files can reach today's take size.
4. **The record key and the take code** (0452). The take code is 227.7 kB raw, 76.4 kB gzip (spike); a plain F9 capture
   avoids loading it today. With one key, a debug build loads it on the first press.
   - Recommendation: load on the first press (lazy), as the trigger does today. Net effect: none.
5. **Look-back window length and "save the last N seconds"** (0452).
   - (a) The build's ring size decides (16–32 MiB, minutes of audio profile); Record saves from the press on.
   - (b) As (a), plus a "Save last N seconds" action that saves the window behind the playhead.
   - Recommendation: (b). Net effect: +2 to +3 table-days.
6. **Re-execution on the live window** (0452). Today Replay is disabled while a recording runs
   (`src/studio/screens/take/index.tsx`).
   - (a) Only on saved captures and a paused look-back window.
   - (b) Also while live.
   - Recommendation: (a). Net effect: (b) adds about +5 table-days and two engines' audio at once.
