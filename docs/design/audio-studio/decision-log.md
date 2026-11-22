# Audio Studio build: decision log

For the owner. Decisions taken while building unattended (owner instruction 2026-11-22: "make any architecture changes
or technical decisions… following industry standards"). Each entry: the question, the choice, why, how to revert.

## Summary

- Needs the owner: (none yet)
- Biggest calls: see entries D1–D3.

## Entries

**D1. Records 0327–0335 accepted.** Owner: "Any new ADRs that need to be approved, go ahead and implement them."
Revert: set the records back to Proposed.

**D2. `audio.json` and the editor's legacy audio panels during the transition.** Until the Studio replaces them (M10),
the editor's Project Settings > Audio and Mixer panel keep working by editing `audio.json` through an adapter between
the new mix model and the legacy section shape; fields the legacy shape can't express (extra returns, VCAs, snapshot
effect overrides) are preserved on write, not dropped. Why: keep `main` usable at every merge. Revert: n/a (transitional).

**D3. Contracts first.** The new formats' TypeScript shapes were committed before wave 1
(`src/engine/audio/{playlist,sample,project,effects,attenuation}/types.ts`) so tasks could run in parallel.
