# 0339. Player input profiles add and remove mappings, and name the action each change is for

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0024, 0336, 0337

## Context

A player's input profile (ADR 0337, `input/profiles.ts`) is saved with the game's settings as `input.<profile>.json`, in format 1: `{ format: 1, overrides, accessibility }`. `overrides` maps `"<context>/<mapping index>/<part>"` to a control path. That is the only kind of change a profile can hold, which leaves three gaps:

- **Adding.** A player can't add a binding where an action has none for a device: a jump with no gamepad button, or a second key for "fire".
- **Unbinding.** A player can't remove a binding.
- **Changing a chord's size.** A rebind can't change how many modifiers a chord has (Shift+B to Ctrl+Shift+B), because that changes the mapping's shape, not one control.

Format 1 also keys overrides by **mapping index** alone. If a designer later inserts or reorders mappings in a context, every saved override after that point silently moves to a different mapping, so a player's "jump on K" can turn into "crouch on K".

## Decision

**Format 2.** A profile holds four parts:

```json
{
  "format": 2,
  "overrides": { "onFoot/3/jump/control": "<Keyboard>/k" },
  "additions": { "onFoot": [{ "action": "fire", "control": "<Gamepad>/rightTrigger" }] },
  "removals":  { "default": [{ "index": 5, "action": "bomb" }] },
  "accessibility": { "invertY": ["look"] }
}
```

- **`overrides`** replace one control of a mapping, as before. The key now names the action: `"<context>/<index>/<action>/<part>"`.
- **`additions`** are whole mappings the player added to a context, in the same `MappingSpec` shape as context assets.
- **`removals`** take mappings out of a context: `{ index, action }`.
- **Applying a profile:** a context's mappings are its asset's or registration's mappings, minus `removals`, plus `additions`. An added mapping's index is the context's mapping count plus its position among the additions, so overrides on added mappings key the same way as others.

**Changes name their action, so stale ones are dropped.** An override or removal applies only if the mapping at that index still targets the named action. Otherwise it's ignored, with one warning per profile and context:

> Saved binding for "jump" in "onFoot" no longer matches the context; it was reset.

**Format 1 is upgraded on load.** Each override gets the action of the mapping at its index in the current context, the result is saved as format 2 on the next `saveBindings`, and format 1 is never written again.

**The API:**
- `player.rebind(action, { add: true, device })`: the next press becomes a new single-control mapping for that device group. It goes into the context that already holds the action's mappings, or the default context if none does.
- `player.unbind(action, { device, context? })`: removes that device group's mapping for the action. An added mapping is deleted outright; one from the context is recorded in `removals`.
- `player.rebind(action, { chord: true })` with a different number of held modifiers removes the old mapping and adds the new chord in one step.
- `resetBindings()` clears overrides, additions and removals.
- Conflict checks (ADR 0337) and prompts see the profile's added mappings and skip its removed ones.

**`UIControlMapper`:** rebinding an empty cell adds a binding. Delete or Backspace on a selected cell (or an Unbind button, worded through its `text` field) unbinds it.

## Alternatives considered

- **Keep format 1 and only fix the indices with action names.** Adding and unbinding stay impossible, and those are the features asked for.
- **Store the player's whole edited context instead of changes.** Simple to apply, but a game update that adds a mapping would never reach players who saved before it.
- **Key mappings by a designer-given id instead of index.** Robust, but every context asset and inline default would need ids. Index plus action catches the common breakages without new authoring.

## Consequences

**Positive**
- Players can add, change and remove bindings, including chords of any size.
- A game update that reorders a context resets only the affected saved bindings, with a warning, instead of quietly binding the wrong action.

**Negative / costs**
- Applying a profile is a merge (removals, then additions, then overrides) instead of one lookup. It runs only when a player's bindings change.
- Format 1 files are rewritten as format 2 on their next save.

## Deprecates

Format 1 profile files: still read and upgraded on load, never written.

## Open questions

- Whether designers should be able to mark mappings as not removable (for example, the pause button).

## References

- `src/engine/input/profiles.ts`, `rebind.ts`, `evaluate.ts` (`compileContext`), `src/engine/ui/controlMapper.ts`
