# 0458. One mapping-shape module names each composite's parts and their control paths

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0024, 0336, 0337, 0339, 0433

## Context

A mapping is a single control or a composite (`dpad`, `axis`, `modifier`, a chord). Which parts each shape has, the
order of its controls, how a chord's `modifier` (a path or a list) becomes the parts `modifier0`…, and how a mapping
looks with some parts replaced were restated in five places: the evaluator's `compileMapping`, the profile's
`SHAPE_PARTS` and `withControls`, the prompt's `partsOf`, the rebinder's default part and `modifier${i}` naming, and the
editor's `COMPOSITES` and `PART_FIELDS`. The editor's list names a chord's modifiers `modifier` where the engine says
`modifier0`…; that one is right (the editor edits the asset's `modifier` field, not rebind parts), but its
`mappingControls` read that field joined with " + ", so a chord with two modifiers listed one non-path
(`<Keyboard>/control + <Keyboard>/shift`) in the Input dialog and the modifier trace. And `rebind` took any `part`, so
`part: "modifier"` (the asset's field name) waited for a key and saved an override the profile then ignored.

## Decision

We will keep the shape of a mapping in `src/engine/input/mappingShape.ts`, and every caller uses it:

- `MappingShape` (`single | dpad | axis | modifier`), `shapeOf(spec)` (null for an unknown composite);
- `shapeFields(shape)` and `MAPPING_FIELDS`: the asset fields, in control order (a chord's modifiers are one `modifier` field);
- `modifierList(spec)`: a chord's modifiers as a list; `modifierPart(i)`: `modifier<i>`;
- `partsOf(spec)`: the part names (rebind, profile override, prompt), in control order;
- `partPath(spec, part)`, `controlPaths(spec)`, `withParts(spec, parts)`.

Part names on disk (`<context>/<mapping>/<action>/<part>` profile overrides) are unchanged. `rebind` refuses a part the
mapping doesn't have, naming the parts it has.

## Consequences

**Positive**
- A new composite is one table entry plus the evaluator's `Source` case.
- The editor's chord controls are paths, each modifier its own.

**Negative / costs**
- None worth noting; the compiled `Source` keeps its named fields, built from the parts by position.

## Deprecates

`SHAPE_PARTS`/`withControls` (profiles), `partsOf` (prompts), the editor's literal part lists; removed.

## As built

`evaluate.ts` builds `Source` from `partsOf`/`partPath` (same problems, same order); `profiles.ts` uses `withParts`;
`prompts.ts` uses `partsOf(m.spec)`; `rebind.ts` uses `partsOf` for its default and check and `modifierPart`;
`editor/inputDebug.ts` `sourceRow` reads the compiled `controls`; `src/editor/inputContextModel.ts` takes `COMPOSITES`'
fields, `MAPPING_FIELDS` and `mappingControls` from the module (the editor imports engine modules directly; no `myco`
export added). Tests: `engine/tests/inputRebind.test.ts` (an unknown part throws), `editor/inputContextModel.test.ts`
(a two-modifier chord lists three controls).
