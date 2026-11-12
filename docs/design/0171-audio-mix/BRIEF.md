# 0171 audio mix (M5): brief for the two-author technical design

Coordinator's brief for step 6 of the design pipeline (2026-11-12). Both authors read this whole file.

[ADR 0171](../../decisions/0171-audio-profiler-loudness-metering-and-live-mixing.md) is **Accepted** (direction). Its "RFC round (revision 2)" (changes 1–35) and "Owner decisions (accepted, 2026-11-12)", including the owner's UI/UX note, win over the text above them. Don't reopen anything in the handoff's "Settled" list ([../../plans/2026-11-audio-mix-m5-design-handoff.md](../../plans/2026-11-audio-mix-m5-design-handoff.md)). If the design finds that a settled point is wrong, say so in your document's "For the owner" section with evidence; don't silently design around it.

## Documents and owners

| File | Owner | Target |
|---|---|---|
| `architecture.md` | architect | ≈ 8,000 words |
| `api-and-models.md` | senior engineer | ≈ 10,000 words, the task table excluded |
| `contracts-architect.md` | architect: what the architecture needs from the API document, numbered **C1, C2…** | |
| `contracts-senior.md` | senior engineer: what the API document needs from the architecture, numbered **S1, S2…** | |
| `review-round2-<role>.md` | each author, round 2A | |

Mirror the shape of M4's design: [../0166-audio-music/architecture.md](../0166-audio-music/architecture.md), [api-and-models.md](../0166-audio-music/api-and-models.md) (its §10 task table), [contracts-architect.md](../0166-audio-music/contracts-architect.md). Diagrams are Mermaid. Every number cites a spike README, a `file:line`, or is marked as an estimate. Cut duplication by pointing at the other document's section, not by cutting content.

## Contract ownership (one owner each)

**The senior engineer owns** every byte, name and format:
- the public API (`Bus.loudness`, `Bus.volume` vs `Bus.authoredVolume`, `Audio.capture` incl. `mark`, capability flags) with full signatures, defaults, units and a compatibility table against today;
- the `audio` settings changes (`meter: "loudness"`, `audio.loudnessTargets`, ducking `mode` and the pre-fader sidechain tap) with parse rules and limits, and the proof that no migration is needed (the product has no outside users: no feature flags, no compatibility shims; update the samples that use `fadeTo`);
- the wire and ABI: STATUS at 20 KB (byte layout of the cumulative CPU counters, loudness readings, gain-reduction, taint), new commands and opcodes (mix operations, bus ramps), init params, the ABI version;
- the capture file format: header, the `audio` section, mix operations, EPOCH/gap/marker records, keyframes, compression, versioning, limits for untrusted input;
- the mix-operation encoding and the session slot table's ids and tombstones as data;
- the SDK hook that carries saved edits into the play Engine (`mixer.configure` clears script state today), and `editor.project.changed` amending 0147;
- editor models (pure, tested, `*Logic`/model modules) with thin views registered through the editor SDK in one place, built in today's layout (owner's UI/UX note);
- native crate and TS module layout, the test plan (EBU goldens, click tests, capture round trip, fake-clock CPU test, e2e), and **the task table**: tasks of ≤ 3–5 days, files, dependencies, level (S/M/J), acceptance criteria, the critical path, in order **M5-0 → M5a → M5b → M5c → M5d**, with an honest total and a 20% reserve (the reserve M4 chose), compared with the record's ≈ 58 pw of tasks / 62–75 pw.

**The architect owns** every constant, timing, memory and failure behaviour, and states requirements for the senior's formats:
- components and the channels between threads; lifecycles; one sequence diagram per key flow (capture start/stop, live edit incl. structural edit with the 20 ms subtree dip, rebuild with slot-table replay, hidden tab / gap, keyframe eviction, import of a capture);
- the stream and its clock: (epoch, frame, seq) semantics, EPOCH and gap records, the heard-clock offset, ordering, and the later live link's framing on paper;
- the recorder ring: sizing per preset and `navigator.deviceMemory`, keyframe segments and eviction, truncation;
- the CPU counters: semantics, windows by quantum count, the 6 ↔ 48 cadence switch, skipped posts;
- loudness data flow: meter placement (master after the reverb return and limiter), K-weighting, gating, true peak, integrity (`tainted`), and how readings reach the editor;
- gain lanes (one per factor, ducking by min), stamped bus ramps as the third class in `due.rs`, the ≤ 50 ms fader gate;
- the slot table and the live-edit path end to end, with rebuild replay;
- sidechain taps and the bus sort; presence ordering in M5-0 and level mode in M5c;
- the new first shedding-ladder step (amends 0162/0170);
- budgets in µs and in metered instructions converted to 0169's floor; failure modes (detection, handling, user-visible effect, counter); observability; the platform matrix (incl. the Babylon fallback, best effort).

If you need something the other owns, write it as a numbered contract in your contracts file, with fields, ranges, semantics, who writes it and when. Don't design the other's part in your document.

## Must-read list (confirm each in your final reply)

Both:
1. The record: glossary, "Decision", "RFC round (revision 2)", "Owner decisions (accepted)".
2. [goal.md](goal.md).
3. [../0162-audio-spatial/working-notes.md](../0162-audio-spatial/working-notes.md): the owner's working rules (no runs that can't change a decision; follow industry standards; no feature flags; intensive tests at wave end and milestone end).
4. [../../../spikes/audio-mix/README.md](../../../spikes/audio-mix/README.md): answers, consequences, budgets, unverified list.
5. The handoff's "Gotchas found".
6. The RFC reviews in [../../rfc/0171/](../../rfc/0171/) that bear on your part (architect: `architect.md`, `challenger.md`; senior: `senior.md`, `junior.md`, `mixer.md`).

Architect, also: `spikes/audio-mix/cpu-clock/README.md` (S2), `capture/README.md` (S3), `mix-core/README.md` (S4); ADRs 0162, 0169, 0170 (the ladder, the mobile floor and its metered-instruction conversion); M4's `architecture.md` §5.3 (constants) and §7 (cost model).

Senior, also: `spikes/audio-mix/research/README.md` (S0), `loudness/README.md` (S1), `capture/README.md` (S3, for the file format); M4's `api-and-models.md` (wire sections and §10); ADR 0147 (editor project events).

Code to read for facts about today (cite `file:line`, read it, don't remember it): `native/audio/crates/audio-wire/src/schema.rs`, `native/audio/crates/audio-core/src/{bus.rs,counters.rs,due.rs}`, `src/engine/audio/` (`coreBackend.ts`, `coreDriver.ts`, `clock.ts`, `statusReader.ts`, `mixer.ts`, `settings.ts`), `src/editor/` play mode and the audio settings model. Use `grep`/`find`; paths may differ slightly from these.

## Working method

- You work in your own git worktree. **Commit your own files there** (the session's stop hook demands clean commits). Only touch files you own in `docs/design/0171-audio-mix/`; never edit the other author's files, the record, or code.
- No long benchmark runs. If the design depends on a number no spike measured, mark it **unverified** and say what run would settle it and how long it would take; the coordinator decides.
- Model IDs never go into any file.
- End your document with "For the owner": the decisions that change product behaviour, scope or schedule, each with options, a recommendation and its net effect. Design trade-offs between the two documents go to the coordinator's rulings, not there.
