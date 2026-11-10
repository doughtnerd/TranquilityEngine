# 0159. `@field` takes an optional `description`, shown as the field's tooltip in the Inspector

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0131 (asset field kinds), 0158 (audio events; `AudioSource.clip` takes clips or events)

## Context

`@field(type, options)` (`src/engine/core/registry.ts`) carries `replicate`, `predicted`, `quantize`, `choices`, `kind` and `hidden`. There is no way to say in a script what a field means, so the Inspector shows only its name. ADR 0158's Consequences ask the Inspector to make clear that `AudioSource.clip` takes a clip or an audio event; the M2 build found no way to do that (m2-decisions entry 8). An animation system is planned (0075 names it; it has no record yet) and will likely want its own per-field metadata.

## Decision

We will add `description?: string` to `FieldOptions`: one or two plain sentences saying what the field is for, shown as the field row's tooltip in the Inspector (and wherever the editor lists the field). It is metadata only: not saved in scenes, not replicated, ignored at run time. A list field's description applies to the list and is not repeated per item.

- `AudioSource.clip` gets the first one: "A sound clip, or an audio event (`*.audioevent.json`) to play as an instance."
- **Left for the animation record:** a field's display label, its display range or units, and whether it can be animated. Those are separate keys with their own meaning; `description` stays prose only.

## Alternatives considered

- **Doc comments read by the editor** (TSDoc). Nothing reads source comments at run time; it would need a build step for user scripts.
- **`help` or `tooltip` as the key name.** `description` matches what it holds (prose), not one way of showing it, so a later UI (a help panel, docs generation) can use it too.
- **Wait for the animation record.** Costs nothing in compatibility either way, but `AudioSource.clip` stays unexplained until then.

## Consequences

**Positive**
- Script authors and first-party components can explain fields in the Inspector.
- Additive: existing components and saved data are unchanged.

**Negative / costs**
- The strings ship in game builds (decorators run at run time); small, and a build could strip them later.
- One more option to keep consistent as `FieldOptions` grows.

## Deprecates

Nothing.

## Open questions

- Whether the editor generates a component reference page from descriptions.

## References

- `src/engine/core/registry.ts` (`FieldOptions`), `src/editor/fieldValues.ts`, `docs/design/0157-audio-core/m2-decisions.md` entry 8.
