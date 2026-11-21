# 0282. One SDK asset picker, slider field and colour field serve every plugin editor and the Inspector

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0040, 0043, 0131, 0133, 0143, 0147, 0148, 0219, 0233, 0257, 0265, 0273

## Context

Which project files fit an asset slot, whether the stored reference carries `asset:`, how the files are listed and
labelled, which built-in entries come first and how a reference to a missing file shows were decided in eight places:

- the Inspector's asset fields (`ui/fieldRows.tsx`): a text box over a `<datalist>` per asset field kind
  (`AssetLists`, `assetListId`), not in the editor SDK;
- the Sky panel: a text box and datalist of images that strips `asset:`;
- the ParticleSystem section: a text box and datalist of images that keeps `asset:`;
- the Particle Graph (`AssetValue`): a select over lists the panel filtered by hand, built-in meshes first, a missing
  file marked;
- the Material Inspector: a select of images and render textures;
- the Shader Graph Blackboard (`ShaderPropertyValue`): a select of **images only**, so a render texture a material
  property names showed as "(missing)" in the graph that declares the property;
- the Tileset Inspector and the Formation Inspector: selects over raw `project.files`.

The SDK offered `NumberField`, `TextField` and `Row` only, so slider and number pairs (Sky, Materials, three audio
files) and colour pickers with an opacity field (Sky, Particles, Materials, Tilesets) were hand-written too, and they
commit a gesture differently: the Sky panel sends a drag flag on `input`; the Material Inspector's slider and the
Shader Graph's colours commit on `change` only (no live preview while dragging); the Inspector's colour row commits
on `change`. The hex helpers behind the colour pickers were copied (`toHex2` in `ShaderPropertyValue.tsx`, a `hex`
closure in `meshes/editor/modelNodes.ts`).

## Decision

We will have three SDK controls (`myco/editor`) that own these rules, and every editor that has such a slot uses them.

- **`AssetPicker`** (`src/editor/ui/AssetPicker.tsx`): a select of the files that fit **field kinds** (the names asset
  kinds declare in `referencedAs`, ADR 0131, 0143; `[]` takes any file), read from the open project, which it follows.
  - **Listing and built-ins** come from `assetChoices` in `assetFieldKinds.ts`: the kind's built-in entries first
    (`builtin:cube`… for `mesh`), then the matching files (sidecars left out), narrowed by an optional `accepts`.
  - **Labels:** a file's name, its project path where two offered files share a name; a built-in's name in words.
  - **The stored form:** `stored: "asset"` (default) commits `asset:<path>`, `"path"` the bare project path (the Sky
    file and the Inspector, whose field kind adds the prefix in the scene file, ADR 0273). The current value is read
    through the asset reference module (`parseAssetRef`, ADR 0148) whatever its prefix.
  - **The missing state:** a value naming a file the project doesn't have shows as `<name> (missing)`, kept until
    another entry is picked. A `#slice` or sub-mesh reference to an existing file is not missing.
  - **Empty and mixed:** `none` names the empty entry ("None", "White", "Soft dot"; `null` for a slot that must be
    set); `mixed` shows a dash for a multi-selection.
- **`SliderField`** (`ui/valueControls.tsx`): a range slider and a number box, clamped to the range.
- **`ColorField`** (`ui/valueControls.tsx`): a colour picker and, with `alpha`, an opacity box, over `#rrggbb[aa]`
  (alpha written only when below 1, `hexWithAlpha` in `colorMath.ts`).
- **One commit rule** for both: a value is reported as `onValue(value, drag)`. While a pointer gesture is under way
  (the slider's or the colour picker's `input`) `drag` is true; the gesture's end (`change`) reports the last value
  again with `drag` false, and a typed number is one report with `drag` false. A caller that merges drag writes
  (`doc.edit(next, drag ? { coalesce: true } : undefined)`, ADR 0027) gets one undo step per gesture, closed at the
  release, as the Inspector's field rows make one step from press to release (ADR 0257). The Inspector's colour row
  uses `ColorField` and opens its target's field drag on the first drag report.
- **Callers:** the Inspector's asset widget (the datalists go), the Sky panel, the ParticleSystem section, the
  Particle Graph's material, texture, mesh, sub-graph and block slots, the Material Inspector's maps and shader
  property values, the Shader Graph Blackboard and node settings, and the Tileset Inspector's image list. The
  Particle Sub-graph and Particle Block kinds declare `referencedAs` (`particlesubgraph`, `particleblock`), and the
  Shader Sub-graph kind `shadersubgraph`, so their slots are field kinds like any other.
- **The navigation editor** (Formation Inspector picker, its hex helpers) moves onto these controls later, with the
  navigation engine changes still to be ported; it is left as it is here.

## Alternatives considered

- **A text box over a datalist everywhere, as the Inspector had.** Free text can name any path, but it can't show a
  missing file, label files by name or offer built-ins, and every caller added its own datalist id.
- **Pass the file list in from each panel** (the Particle Graph's `assets.images`…). Leaves the "which files fit" rule
  in every panel; the picker answering from the field kinds is what makes a new asset kind appear everywhere.
- **Gesture callbacks (`onDragStart`/`onDragEnd`)** on the controls. Every caller would wire three callbacks; the drag
  flag with a closing report fits `doc.edit`'s coalescing as it is and the Inspector's field drag.

## Consequences

**Positive**
- One place decides which files fit a slot; a plugin's new asset kind shows up in every picker that names its field
  kind. A render texture on a material property shows as itself in the Shader Graph.
- Sliders and colours preview while dragging and make one undo step per gesture in every editor.
- The controls are tested once, by their Storybook stories' play functions, and `assetChoices` by unit tests.

**Negative / costs**
- The Inspector's asset field is a select: a path can no longer be typed (specs that typed one now pick it).
- Very large projects give long selects; a searchable picker can replace the select inside the control later.

## Deprecates

`AssetLists`, `assetListId` and the declared-kind datalists in `fieldRows.tsx`; the Particle Graph's `AssetValue` and
its `assets` lists in the graph editor context; the Sky panel's and ParticleSystem section's datalists; the hand-written
selects in `MaterialInspector.tsx`, `ShaderPropertyValue.tsx`, `ShaderGraphPanel.tsx` and `TilesetInspector.tsx`;
`toHex2`. Removed.

## Open questions

- A searchable picker (type to filter, thumbnails) inside `AssetPicker` for large projects.
- The audio editor's sliders (event node properties, parameters, occluder) can move onto `SliderField` when touched.

## References

- `src/editor/ui/AssetPicker.tsx`, `src/editor/ui/valueControls.tsx`, `src/editor/assetFieldKinds.ts`,
  `src/editor/colorMath.ts`; stories beside them (ADR 0219).
