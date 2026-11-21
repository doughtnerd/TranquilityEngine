# 0304. One audio parameter list for an event's own parameters and the global ones

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0158 (§2 local and global parameters), 0219 (stories beside components), 0262 (named lists and the shell's rename), 0299 (event references), 0307 (refused-or-next edits)

## Context

An audio event's own parameters (`AudioEventAsset.parameters`) and the project's global ones (`audio.parameters`) are
the same `ParameterDef` list, read back by the same `parseParameters` (`engine/audio/eventFormat.ts`), but the editor
had two models and two views of it:

- **Event:** `event/eventParameters.ts` (`addParameter`, `removeParameter`, `parameterNameProblem`,
  `renameParameterAt`, `setParameterAt`, `toggleLabelled`, `updateNumeric`, `setLabels`) and `event/ParametersPane.tsx`
  with its own number input.
- **Global:** `audioSettingsModel.ts` (`addParameter`, `removeParameter`, `renameParameter`, `setParameterLabelled`,
  `setParameterRange`, `setParameterLabels`, `setParameterDefaultLabel`) and the `Parameters` view in
  `AudioSettingsSection.tsx` with another number input.

Their rules differed where they should not: raising `min` past `max` moved the other bound in an event but swapped the
two globally (as the parse does); new labels were `"A"`, `"B"` in an event and `"State 1"`, `"State 2"` globally; a
taken or empty name was refused with a message in an event and silently ignored globally; label clean-up, name
uniqueness and the add limit were written twice. Only what a remove or a rename carries along really differs by holder:
removing an event parameter keeps its uses (they then read a global one), removing a global one drops the bus
automation that reads it; an event rename follows every use through the event references module (ADR 0299), a global
rename renames the automation, and the shell's settings names module renames the event files and scenes (ADR 0262).

## Decision

We will have one **parameter list module**, `src/plugins/audio/editor/parameterList.ts`, and one **parameter card**
view, `src/plugins/audio/editor/ParameterCard.tsx`.

- **`parameterList(holder)`** gives a `ParameterList<H>` over any holder `H` of a parameter list: `add(h, kind)`,
  `remove(h, name)`, `rename(h, from, to)`, `setKind(h, name, kind)`, `setRange(h, name, patch)`,
  `setLabels(h, name, text)`, `setDefaultLabel(h, name, label)`, plus `parameters(h)`, `limit` and `full(h)`. Every edit
  returns the refused-or-next result of ADR 0307, with a message when refused (`at most 16 parameters`,
  `a parameter needs a name`, `another parameter is named "X"`, `no parameter named "X"`).
- **A holder** (`ParameterHolder<H>`) plugs in only what differs: where the list lives (`read`, `write`), its `limit`
  (`MAX_LOCAL_PARAMETERS` 16 or `MAX_PARAMETERS` 64), and what a `rename` and a `remove` carry along. The event holder
  (`eventParameterList` in `event/eventParameters.ts`) renames through `renameEventName(…, "local", …)` and keeps uses
  on remove; the settings holder (`globalParameterList` in `audioSettingsModel.ts`) renames, and drops, the automation
  that names the parameter.
- **The rules follow the parse.** A `min` above `max` swaps the two (as `parseParameters` does); the default is clamped
  into the range; `seekSpeed` is at least 0; non-finite numbers are ignored. Labels are split on commas, trimmed, with
  empty ones and repeats dropped; none left is refused. A labelled default must be one of its labels.
- **New labels are "State 1", "State 2"** (default "State 1") for both holders: ADR 0158 calls labelled parameters
  states, and the global list already wrote these. Labelled to numeric is `0..labels-1` (at least `0..1`) with the old
  default's index.
- **One card view.** `ParameterCards` renders the list's header, the add buttons (numeric and labelled), one
  `ParameterCard` per parameter (name, kind, remove, then range and seek speed, or labels and default) and, for the
  event, an audition slot the Event editor fills with its sliders. Fields are named the same in both places
  (`Parameter <name> name`, `<name> min`, `<name> labels`, `Remove parameter <name>`). It applies each edit through
  the holder's refused-or-next adapter (ADR 0307). CSS uses the theme tokens; a story sits beside it (ADR 0219).

## Alternatives considered

- **Keep two models, fix the two differences** — the swap and the labels would drift again; the duplicated limits and
  checks stay.
- **One function set over `ParameterDef[]` only, callers carry along by hand** — every caller would have to remember the
  automation drop and the reference rename; the holder seam keeps that behind the module's interface.
- **Move the global list onto the event's `renameEventName`** — the settings draft has no event tree; its carry-along is
  automation plus the shell's named-list rename.

## Consequences

**Positive**
- Each rule lives once and matches the parse; the list's test suite runs once per holder.
- A global rename to a taken or empty name now says why instead of doing nothing.

**Negative / costs**
- Behaviour change in the Event editor: `min` above `max` swaps instead of moving the other bound, new labels are
  "State 1", "State 2" instead of "A", "B", and the Parameters header gains "+ Labelled parameter".
- Event parameter field names change from `Parameter 1 name` to `Parameter <name> name`.

## Deprecates

`event/ParametersPane.tsx` (removed) and `eventParameters.ts`' `addParameter`, `removeParameter`,
`parameterNameProblem`, `renameParameterAt`, `setParameterAt`, `toggleLabelled`, `updateNumeric`, `setLabels`;
`audioSettingsModel.ts`' `addParameter`, `removeParameter`, `renameParameter`, `setParameterLabelled`,
`setParameterRange`, `setParameterLabels`, `setParameterDefaultLabel`, `ParameterRangePatch`; the section's
`Parameters` view and each view's own number input. `auditionValues` stays in `eventParameters.ts`.

## Open questions

None.

## References

`src/engine/audio/eventFormat.ts` (`parseParameters`), `src/engine/audio/eventReferences.ts`,
`src/plugins/audio/editor/audioNames.ts`; architecture review 2026-11-21, candidate 4.
