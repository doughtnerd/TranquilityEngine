# 0383. The Create menus nest what they make in sorted categories, from one tree, and plugins name their category

- **Status:** Accepted
- **Date:** 2026-11-23
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0069, 0077, 0143, 0146, 0149, 0174, 0233, 0349

## Context

The Hierarchy's "+" menu, its right-click menu and the menu bar's Create menu listed every node kind flat, in
registration order (`newNodeKinds()`, ADR 0146): about 25 "Create X" items, and on a row the same list again as
"Create X Child", so the row menu ran past 55 items before Cut and Copy. The Assets panel's right-click menu listed
New Folder, every asset kind's New… entry (21 with the bundled plugins) and New Script… flat too. Neither was sorted,
and the Hierarchy and Assets menus drew their own flat popover without submenus, while the shared context menu
(ADR 0349) and the menu bar already had submenus with → and ← keys.

## Decision

We will arrange the Create menus Unity-style: a short top level and one submenu per category, each sorted.

- **One generic arranger**, `src/editor/menuCategories.ts` `categorise(items)`: items without a category stay at the
  top in the order given; then a separator and a submenu per category, categories sorted by name with **Other**
  last, items sorted by label (numeric-aware, case-insensitive).
- **The node Create tree**, `src/editor/createMenuTree.ts` `nodeCreateTree(item)`, is the single source the
  Hierarchy's "+" and right-click menus and the menu bar's Create menu all draw: **Empty** and **Camera** at the top,
  then **2D** (Sprite, Tilemap), **3D Object** (Capsule, Cube, Cylinder, Plane, Sphere), **Effects** (Fog, Particle
  System, Water), **Light** (Ambient, Directional, Point and Spot Light, Reflection Probe), **UI** (Button, Canvas,
  Image, Input Field, Panel, Screen Text, Text, UI Document). Each built-in kind carries its `category` and, where the
  category already says part of its label, a `short` label shown inside it ("Canvas" for "UI Canvas"; the
  screen-space `engine.Text` shows as "Screen Text").
- **Plugins name their category.** `HierarchyCreateContribution` gains an optional `category`; without one, the entry
  takes the category of the entry its `after` names, else Other. `AssetKindCreate` gains an optional `category`
  (`AssetKindCreatePlacement`); without one, Other. The bundled plugins set theirs (Particles: Effects; Tilemaps: 2D;
  Materials: Rendering and Shader; Sky: Rendering; UI: UI; Navigation: Navigation; Animation: Animation).
- **The Hierarchy's menus.** "+" (and the menu bar's Create): Element in Document › (when a UI document is selected),
  the tree, then Child of Selection › (the tree again, adding into the selected node). A row: Create › (beside it) and
  Create Child › (into it), then Cut, Copy, Paste, Paste as Child; Rename, Duplicate, Delete; Open Prefab; the Scene
  view's Hide/Lock. Empty space: the tree, then Paste. A UI element row: Create Element ›, then Rename, Duplicate,
  Delete.
- **The Assets panel's menu.** Background: Create ›, Paste, Show in File Manager. A selection: Create › (on one
  folder), Open and plugins' actions, Cut, Copy, Paste; Rename, Duplicate, Delete; Show in File Manager. Create holds
  Folder, Scene and Script… at the top, then each kind's New… entry under its category, labelled without "New "
  (Rendering › Material, Shader › Shader Graph).
- **Drawing.** The Hierarchy and Assets panels draw their menus with the shared context menu (`ContextMenu`, ADR 0349)
  through `PanelMenu`, which takes the menu bar's entry shape. `ContextMenu` gains `inline` (draw it where it is
  rendered instead of at the main page's floating root, so a panel in a detached window, ADR 0174, opens it in that
  window) and `class`. A submenu opens on hover, click, Enter, Space or →; ← or Escape goes back to its item. The
  submenu arrow is `aria-hidden`, so an item's accessible name is its label.

## Alternatives considered

- **Keep the flat lists and sort them** — still 25+ items (55+ on a row), and the child variants double it.
- **Group with caps headings instead of submenus** — shorter to reach but no shorter to scan; the row menu stays long.
- **Map plugin kind ids to categories in the shell** — breaks ADR 0146's rule that the shell reaches plugins only
  through contribution points, and misses third-party plugins; an optional field on the contribution doesn't.

## Consequences

**Positive**
- Every Create menu is a dozen top-level rows or fewer, and the three node menus can't drift apart.
- New plugin kinds land in a sensible submenu with no shell change.

**Negative / costs**
- Creating takes one more pointer move; e2e specs and anyone used to the flat labels ("Create Cube", "New Material")
  have to learn the paths.
- `HierarchyCreateContribution.category` and `AssetKindCreate.category` are new optional SDK fields.

## Deprecates

The Hierarchy's and Assets panel's own flat popover renderers (replaced by `PanelMenu`), and the "Create X" / "Create
X Child" / "Create X in Document" / "New X" flat labels.

## Open questions

- An **Audio** category waits for an audio node kind (there is no AudioSource component to create yet).

## References

- Unity's GameObject › Create and Assets › Create menus.
