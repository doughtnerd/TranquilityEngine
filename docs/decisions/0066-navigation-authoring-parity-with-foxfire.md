# 0066. Navigation authoring matches Foxfire: named avoidance layers, formation assets, agent goals

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0065, 0038, 0022

## Context

ADR 0065 ported Foxfire Navigation's runtime and bake faithfully, but its authoring layer was Myco's own guess, and three gaps came out of using it.

- **Avoidance layers.** Avoidance layers were raw bit numbers on agent types, on `NavAgent` (per-agent overrides, -1 = the type's) and on `NavAvoidanceObstacle`. Foxfire names its layers in project settings, puts each agent type on one layer, sets who avoids whom in a matrix, and has no per-agent overrides.
- **Formations.** Painted formations could only be set from code (`NavGroup.setMask`). Foxfire keeps formations as assets (`NavFormation`) with a painting editor.
- **Agent goals.** Foxfire's `NavAgentAuthoring` can give an agent a goal in the scene: an initial goal, optionally chased. Myco's `NavAgent` couldn't.

Separately, field `choices` given as a function of the project settings could only return values, so dropdowns of agent types and areas showed ids rather than names.

The owner asked for authoring to match Foxfire as closely as possible.

## Decision

We will match Foxfire's authoring model:

- **Named avoidance layers.**
  - `NavigationSettings.avoidanceLayers: string[]` names up to 32 layers; the index is the bit, and unnamed slots are allowed.
  - Agent types keep storing `avoidance.layers` and `avoidance.avoidLayers` as bits, so the runtime and bake file are unchanged. `layers` is a single layer (one bit), and `avoidLayers` is the mask, where all bits means "Everything", including layers named later.
  - The Navigation settings show the names, an "On layer" dropdown per agent type, Foxfire's who-avoids-whom matrix, and the "On / Avoids / Avoided by" summaries.
  - `NavAvoidanceObstacle.layers` shows a layer dropdown.
- **No per-agent avoidance overrides.**
  - `NavAgent.avoidanceLayers` and `NavAgent.avoidLayers` are removed. An agent's layers are its type's.
  - The other `NavAgent` overrides (`speed`, `turnSpeed`, `priority`) stay, because scripts use them at runtime.
- **Agent goals.** `NavAgent` gains Foxfire's goal fields:
  - `initialGoal: GameObject`, a node to go to when the agent starts;
  - `chaseGoal: Boolean`, to chase it instead;
  - `chaseRepathDistance: Number`, default 1 m.
- **Formation assets.**
  - `*.formation.json` files (`myco.formation@1`) mirror `NavFormation`: shape, layers, layer spacing, and for a mask, the painted cells.
  - `NavGroup.formationAsset: AssetRef`, when set, replaces the group's inline formation fields.
  - The Inspector edits formation files with Foxfire's painting tools.
- **Labelled function choices.** A field's `choices` function may return a labelled record (`{ "Humanoid": "<id>" }`) as well as a list. Navigation fields use it to show names and store ids.

## Alternatives considered

- **Keep `NavAgent`'s overrides, as named layers.** More flexible, but Foxfire has nothing like it, and it adds a second place to look when agents don't avoid each other. The owner chose Foxfire parity.
- **Store a layer index instead of a bit on agent types.** Clearer, but it would change the bake input and the runtime boundary for no runtime gain. Bits stay, and the editor enforces a single layer.
- **Formation masks stored inline on `NavGroup`.** No new asset type, but masks couldn't be shared between groups or edited with a full-size painter, and it differs from Foxfire.

## Consequences

**Positive**
- Authoring reads like Foxfire's: the same concepts, editors and summaries. Fixes made in Unity carry over directly.
- Dropdowns show agent type, area and layer names.

**Negative / costs**
- Scenes that set `NavAgent.avoidanceLayers` or `avoidLayers` lose those values; they now come from the type. Only the navigation sample used them, and it's regenerated.
- A new asset type (`.formation.json`) to load, preload and export.

## Deprecates

- The per-agent avoidance layer overrides on `NavAgent` (`avoidanceLayers`, `avoidLayers`) are removed.
- Raw layer numbers in the Navigation settings UI are replaced by named layers and the matrix.

## Open questions

None.

## References

- Foxfire: `Documentation~/Avoidance layers.md`, `Documentation~/Groups.md`, `Editor/AvoidanceLayers/*`, `Editor/NavFormationEditor.cs`, `Runtime/Authoring/NavAgentAuthoring.cs`.
- ADR 0065, built-in navigation.
