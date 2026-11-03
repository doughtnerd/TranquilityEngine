# 0022. A scene editor is a v1 goal

- **Status:** Accepted
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0013, 0016, 0017, 0020, 0023

## Context

The first draft of the overview listed a visual editor as a non-goal. The owner decided a **scene editor is part of v1**. Earlier decisions already point that way: data-driven scenes with declared fields (0013), a World root with separate Editor/Runtime worlds (0016), and a public World API (0017).

## Decision

- v1 includes a **scene editor**, shipped as a Tauri app built on the engine itself.
- The editor runs an **`Editor` World** (0016): it loads scene files, shows the World as a node tree, and edits nodes and components.
- **Inspector** fields come from component field declarations (0013) and data component schemas (0017). No per-component editor code is needed for the default inspector; custom inspectors are optional.
- **Edits save back to scene/prefab files** (0013), including nested prefab overrides.
- **Play mode** serializes the edited scene and loads it into a fresh **`Runtime` World**, so play never changes the edited state. Stopping discards the Runtime World.
- **Viewport**: the engine renderer with editor cameras and gizmos (move/rotate/scale via three.js `TransformControls` or equivalent), selection by raycast, and 2D/3D view modes.
- **Undo/redo** is a command stack over scene edits.
- v1 scope: node tree, inspector, viewport with gizmos, play mode, prefab create/apply/revert, asset browser for files on disk. Out of v1: visual scripting, animation timeline, terrain tools.

## Alternatives considered

- **No editor in v1, editor-ready design.** Lower risk, but the owner wants the editor in v1.
- **Runtime inspector only (no save-back).** Useful for debugging but doesn't replace authoring.

## Consequences

**Positive**
- Scenes are authored visually, and the scene format gets tested by a real tool from the start.
- Forces the World/serialization APIs to be complete and well designed.

**Negative / costs**
- Large scope increase for v1; the scene format, field declarations and World API must land before editor work can go far.
- Editor and runtime must share code without the editor's needs leaking into shipped games (separate entry points; editor code isn't in game builds).

## Deprecates

- The "visual editor" non-goal in the first draft of the [overview](../architecture/overview.md).

## Open questions

- **Editor UI technology**: DOM (e.g. a web UI framework around the viewport) or in-canvas uikit like game UI (0020). Leaning DOM for editor chrome (dense panels, text input, docking), since 0020 covers game UI only.
- Hot reload of game scripts while the editor is open (Vite HMR into the Editor World).
- Project format (project settings file, layers matrix, autoloads, build settings).

## References

- Godot editor (built on its own engine), Unity Editor play mode.
