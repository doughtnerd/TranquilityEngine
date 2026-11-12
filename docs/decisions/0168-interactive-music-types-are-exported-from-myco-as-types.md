# 0168. Interactive-music types are exported from myco as types

- **Status:** Accepted (2026-11-12)
- **Date:** 2026-11-12
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0166 (§1, the public API)
- **Related:** 0010 (no backend types in the public API), 0166, 0167

## Context

0166 §1 defines the interactive-music API, and `myco` exports its value and debug types (`MusicEvent`, `MusicHandle`, `MusicPositionAt`, `CalibrationResult`, `GridSpec`…). It does not export `MusicEventHandle` (what a beat callback's `e.handle` is) or the music format's node types (`SegmentNode`, `TransitionRule`, `StingerDef`…). A script could use those values but could not name them in a parameter, field or return type. The M4 build log (D5) flagged it, and the owner decided on 2026-11-12 that scripts should be able to name them.

## Decision

`src/myco.ts` re-exports these with `export type { … }` only, so nothing reaches the runtime bundle:

- **Handle and event:** `MusicEventHandle`, `CalibrationApi`.
- **Format node model** (`musicFormat.ts`): `SegmentNode`, `PlaylistNode`, `MusicSwitchNode`, `MusicContainerNode`, `MusicNode`, `MusicNodeType`, `TempoMarker`, `MusicCue`, `MusicRegion`, `RegionCondition`, `MusicTrack`, `MusicAutomation`, `MusicAutomationTarget`, `AutomationQuantize`, `TrackPick`, `PlaylistMode`.
- **Rules and stingers** (`musicRules.ts`): `TransitionRule`, `TransitionFade`, `TransitionExit`, `TransitionEnter`, `TransitionBridge`, `StingerDef`, `StingerAt`, `FadeCurve`, `IfTooLate`.

The other 0166 §1 types (`MusicEvent`, `MusicHandle`, `MusicPositionAt`, `MusicSeekResult`, `GridSpec`, `GridPoint`, `MusicKind`, `CalibrationResult`, `AudioLatency`, `AudioEventHandle`) were already exported. Constants, parsers, the writer, the rule index and the parse context stay internal: they are values, and `RuleIndex`, `RuleAnalysis`, `RuleTier` and `MusicParseContext` serve the engine and editor only.

None of the exported types refers, directly or transitively, to Babylon.js, three.js, Rapier or Howler (ADR 0010); they reach only `NodeBase`, `Automation` and `Curve`, which are plain data. A type test (`src/engine/tests/musicTypesExport.test.ts`) imports each type from `myco` and checks a usage.

## Alternatives considered

- **Leave them internal and let scripts use `ReturnType`/indexed access** — works for some types and not for node and rule shapes; clumsy.
- **Export the modules' values too** — widens the runtime API for no scripting need.

## Consequences

**Positive**
- Scripts annotate with `import type { MusicEventHandle } from "myco"`; no runtime cost.

**Negative / costs**
- These shapes become public: changing a field is an API change.
