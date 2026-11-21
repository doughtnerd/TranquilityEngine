# 0313. Every audio editor edit returns refused-or-next, and the music panels share one open node handle

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0307 (amended: the refused-or-next result), 0268 (the editor's one audition), 0269 (the music tree module), 0306 (audio settings limits), 0166 (music editors Ed2, Ed4, Ed6)

## Context

ADR 0307 gave the audio editor one result shape, `EditResult` (`{ next } | { refused }`) applied by `applyEdit`, but
left edits outside it:

- **Settings.** `audioSettingsModel.ts`'s other mix-op setters (effects, bus values, snapshot values, beds, meter,
  loudness targets) returned the draft unchanged when refused. `setLoudnessTarget` and `loudnessTargetRefusal` built
  the same merged target, and `AudioSettingsSection.tsx` called the refusal, then the setter, and kept an inline
  `role="alert"` line. `renameMaterial` to a taken or empty name and `addMaterial` at `MAX_MATERIALS` did nothing,
  silently; so did the automation setters (unknown bus, parameter or index). `busMeterRefusal` was a second copy of the
  meter op's rule for the checkbox's disabled state.
- **The event tree.** `eventTreeModel.ts`'s guarded edits (`addChild`, `setSustainSlot`, `removeNode`, `reorderChild`,
  `moveNode`, `duplicateNode` and the music `removeMusicNode`, `reorderMusicNode`, `duplicateMusicNode`) threw
  `RangeError` unless their `can*` guard said yes, so `EventTree.tsx` asked `canRemove` / `canDuplicate` first and its
  `remove()` skipped `applyEdit`: a refused Delete (the root, a sustain's loop) said nothing.
- **The music panels.** `SegmentView.tsx`, `SegmentPanel.tsx` and `RulesTable.tsx` each read `openSegment` /
  `openRules`, checked the event file still exists, opened the event's asset document, found the node and wrote it back,
  and had drifted: the segment view called `doc.edit` directly behind `if (!event.musicRoot) return`, the others
  `placeEdit` with `event.musicRoot && replaceMusicNode(...)`. Clip facts from the peaks service were worked out in three
  places (the panel's tempo length and lint, the rules table's segment lengths, the view's lanes), each with its own
  probe-in-an-effect-then-bump-a-`useState` re-render trick.

## Decision

We will make every audio editor edit a user can get refused return `EditResult` itself, and give the music panels one
handle on an open music node.

- **Settings edits return `EditResult<SettingsDraft>`.** Every mix-op function in `audioSettingsModel.ts` is `mixEdit`
  of its op (refused with `opRefusal`, the parse's own rule; `applyMixOp` is gone): buses, effects, snapshots, meter,
  loudness targets, the reset option, `maxVoices`, beds, automation. The automation and material edits return their
  own refusals ("No automation 3.", "A project holds at most 32 materials.", "Another material is already named …",
  "… is built in and keeps its name."); a request that changes nothing (the same name, the same target) is
  `accept(draft)`. `toggleOcclusionLayer` and `applyVoicesPreset` can't be refused and stay plain path writes.
- **One way to show it.** `AudioSettingsSection.tsx` applies every model edit through `applyToSettings` (its `editOf`
  helper); the loudness table's inline alert line and `useState` are removed, so a refused target goes to the status bar
  like every other refusal.
- **Tree edits return `EditResult<TreeEdit>` / `EditResult<MusicEdit>`.** The guarded edits refuse with why ("the event's
  root node stays…", "a sustain node's loop slot is required", "that slot is taken", "a node can't move into itself", the
  depth and node limits) instead of throwing; `removeNode` and `removeMusicNode` now return the parent's path to select.
  `EventTree.tsx` applies Delete, Duplicate, reorder, move, wrap, add and drops through `applyEdit`, so a refused Delete
  says why. `setNode` keeps its `RangeError`: it is the addressing step under the edits, called only on a path just read.
- **Predicates are asked of the edit.** `canRemove`, `canMove`, `canDuplicate`, `canAddChild`, `canRemoveMusic`,
  `canDuplicateMusic`, `busMeterRefusal` and `loudnessTargetRefusal` are removed. A view's "disabled" state asks the edit:
  `refusalOf(result)` in `editResult.ts` gives the reason or null (`disabled={refusalOf(removeNode(root, path)) !== null}`;
  the meter box's reason is `refusalOf(setBusMeter(d, bus, true))`); `treeDrop.canDropNode` is `moveNode` accepted.
- **One open music node handle.** `music/musicNodeHandle.ts` `musicNodeHandle(doc, peaks, kind, id)` over the event's
  asset document and the project's peaks service, for a `"segment"` or a `"container"`, gives:
  - `asset`, `node` (null when the event has no such node), `readOnly`, `path` and `flush()`;
  - `apply(result, label, { coalesce? })`: the part's `EditResult` placed into the event (`placeEdit`) and applied with
    `applyEdit` as one undo step of the document, or the refusal in the status bar; `coalesce` merges a drag's steps
    (the segment view's handles); a missing node is a refusal;
  - `clip(path)` (`MusicClipFacts`), `seconds(path)` and `waveform(path)` (the peak mips): reading one starts the decode
    when it isn't known yet, and a `version` signal the reads subscribe to is bumped when it arrives, so a view re-renders
    without its own effect.
- **The panels become views.** `music/MusicNodePanel.tsx` is the one shell: the open target (`openSegment` or
  `openRules`), the "no project / file gone / no such node" messages, the document (flushed on close) and the handle,
  handed to the view. `SegmentViewPanel`, `SegmentPanel` and `RulesTable` render through it; the segment view's canvas
  component takes `waveform` and `seconds` instead of the peaks service.

## Alternatives considered

- **Keep the `can*` guards beside throwing edits** — two copies of each rule, and a caller that forgets the guard throws
  into the UI; asking the edit costs one pure call per render on trees of at most 1024 nodes.
- **Cache one handle per document and node for all three panels** — one version signal and one probe per clip, but a
  module-level cache keyed by document needs its own invalidation on close; the peaks service already shares the decode,
  so each panel keeps its own handle (`useMemo`).
- **Return refusals for `setNode`** — no user action reaches it with a stale path; every caller would unwrap a result that
  can't be refused.

## Consequences

**Positive**
- No silent settings edit: a material rename to a taken or empty name, a material past the limit, an out-of-range
  loudness target and an automation edit on a removed parameter all say why, in one place.
- A refused tree Delete, Duplicate or drop says why; no throw path reaches the UI.
- Refusal tests are edit tests (`refusalOf(edit(...))`); the music handle is tested without Preact.
- The three music panels lose their copies of open, find, write back and the peaks re-render trick.

**Negative / costs**
- Settings tests and the section unwrap a result where they used the draft directly.
- A disabled check computes the edit it guards (cheap, pure).

## Deprecates

`applyMixOp`, `busMeterRefusal`, `loudnessTargetRefusal`, `canAddChild`, `canRemove`, `canMove`, `canDuplicate`,
`canRemoveMusic`, `canDuplicateMusic`, the loudness table's inline refusal line (`aria-label="Loudness target refused"`),
each music panel's open-and-write-back code and peaks probe, and the segment view's `peaks` prop: removed. ADR 0307's
"out of scope" note (the other mix-op setters) and its rule that guarded tree edits keep throwing are replaced by this
record.

## Open questions

None.

## References

Architecture review 2026-11-22, candidates 3 and 6 and small fix 4; `src/plugins/audio/editor/editResult.ts`,
`audioSettingsModel.ts`, `event/eventTreeModel.ts`, `music/musicNodeHandle.ts`, `music/MusicNodePanel.tsx`.
