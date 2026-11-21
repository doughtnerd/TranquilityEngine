# 0307. One refused-or-next result for audio editor edits

- **Status:** Accepted, amended by 0313 (every settings edit and the guarded tree edits return the result; the music panels apply it through one node handle)
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0158 (§7 the Event editor), 0166 (music editors Ed4, Ed6, Ed7), 0171 (§6.2 mix ops), 0172 (ducking refusals), 0304 (the parameter list)

## Context

The audio editor's pure edits answered "here is the next value, or why not" in eight shapes, each unpacked by its own
panel:

- `music/segmentEdits.ts` `Edit = {segment} | {error}` (`SegmentPanel.tsx` kept its own error line);
- `music/ruleEdits.ts` `RuleEdit = {container} | {error}` (`RuleEditor.tsx` kept another; `RulesTable.tsx`'s `apply`
  returned false and dropped the message, so **Add rule** at 256 rules and **Duplicate** did nothing, silently);
- `event/treeActions.ts` `addNode`, `event/treeDrop.ts` `applyClipDrop` and `event/eventTreeModel.ts` `addMusicNode`:
  `TreeEdit | string` and `MusicEdit | string` (`EventTree.tsx` sent the string to `onProblem`), while `wrapNode` threw
  and the tree caught it;
- `segmentEdits.ts` `readCondition` `{condition} | {error}` and `ruleEdits.ts` `gridSpec` `GridSpec | string`;
- `audioSettingsModel.ts` `DuckEdit = {draft, refusal}` (the ducking list kept a refusal line), and "the draft
  unchanged" for the other mix ops (`mixOpRefusal` private), so renaming a bus or a snapshot to a taken name did nothing,
  silently.

## Decision

We will have one result type and one way to apply it.

- **`EditResult<T>`** in `src/plugins/audio/editor/editResult.ts`: `{ next: T }` or `{ refused: string }`, built with
  `accept(value)` and `refuse(reason)`; `placeEdit(result, part, whole, place)` lifts a part's edit (a segment, a
  container) into the whole asset, keeping "nothing changed" as the whole unchanged. Every audio editor edit that a
  user can get refused returns it: the segment and rule edits (with `readCondition` and `gridSpec`), `addNode`,
  `applyClipDrop`, `wrapNode`, `addMusicNode`, the ducking edits (`addDucking`, `setDuckingValue`, `moveDucking`,
  `removeDucking`), `renameBus`, `renameSnapshot` and the parameter list (0304). `mixEdit(d, op)` gives a mix op's
  result from `opRefusal`.
- **`applyEdit(result, label, commit, unchanged?)`** in the same module is the one place a result is applied: a refusal
  goes to the editor's status bar and message log as an error (`editor.messages.error("Can't <label>: <reason>")`), and
  an accepted value is committed once with the label (one undo step), unless it is `unchanged` itself. Two adapters sit
  on it: `applyToDocument(doc, result, label)` for an asset document (the Event editor's parameters, the segment panel,
  the rules table and rule editor) and `applyToSettings(draft, set, result, label)` for the Project panel's settings
  draft (the Audio section). The event tree applies through `applyEdit` into the panel's `onEdit`, which selects the
  node the edit made.
- **Refusals show in one place**, the status bar, not in per-panel lines: the segment panel's, the rule editor's and
  the ducking list's own refusal lines are removed.
- The tree model's guarded functions (`removeNode`, `moveNode`, `duplicateNode`, `reorderChild`, …) keep throwing on a
  call their `can*` guard refuses: those are programming errors, not refusals a user can cause. `wrapNode` had no
  guard, so its depth and node limits become refusals.
- Out of scope here: the other mix-op setters (effects, bus values, snapshot values, loudness targets) still return the
  draft unchanged when refused; their controls are clamped or disabled, and the loudness targets keep their own
  refusal query (`loudnessTargetRefusal`).

## Alternatives considered

- **Keep each panel's inline line, unify only the type** — still a refusal place per panel, and the rules table and
  the settings renames would need lines of their own.
- **Throw a `RefusedEdit` error** — callers would need `try` around every edit, and an unexpected error would read as a
  refusal.

## Consequences

**Positive**
- No silent no-ops: Add rule and Duplicate at the rule limit, a bus or snapshot renamed to a taken name, and a global
  parameter renamed to a taken name all say why.
- Less glue per panel; refusals are tested through the edit functions.

**Negative / costs**
- A refusal is read in the status bar, further from the field than the old inline lines; the message log keeps it.
- The ducking stories read the refusal through a spy on `editor.messages.error` instead of a line in the section.

## Deprecates

`Edit` (segment edits, now private), `RuleEdit` (now private), `DuckEdit`, `addDuckingEdit`, `setDuckingValueEdit`,
`EventTree`'s `onProblem` prop, and the inline refusal lines (`segment-panel-error`, `re-error`, `data-duck-refusal`):
removed.

## Open questions

None.

## References

Architecture review 2026-11-21, candidate 7 and small fix 5; `src/editor/sdk/messages.ts`.
