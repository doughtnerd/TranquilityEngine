# Glossary

The domain terms used in Myco Engine's code, decision records and reviews. Add a term when a decision gives a concept a name, and sharpen an entry when its meaning gets clearer. The core engine terms (Node, GameObject, GameBehavior, Component, World and so on) are in the [architecture overview's glossary](docs/architecture/overview.md#glossary); this file holds the rest.

## Plugins and the SDK (ADR 0133)

- **Plugin:** a feature, packaged as a manifest (`plugin.json`), a runtime half and an editor half. It registers contributions into contribution points. A plugin is a feature, not one asset type. For example, Materials and Shaders can be one plugin. _Avoid:_ package (that means an npm package, ADR 0125), extension, module (for a whole plugin).
- **Runtime half:** a plugin's `runtime/` folder, holding Components, systems, World services and asset loaders. It ships in game builds and on the dedicated server, and never imports editor code.
- **Editor half:** a plugin's `editor/` folder, holding asset kinds, asset document formats, panels, inspector sections, viewport tools, settings sections, importers, thumbnails and "New…" entries. It may import its runtime half.
- **Contribution point:** a registry that plugins register into, such as asset kinds, Components or World services. Each supports unregistering.
- **Contribution:** one thing a plugin registers at a contribution point.
- **SDK:** the public surface plugins are written against. `myco` is the runtime SDK. `myco/editor` is the editor SDK, importable only from editor halves. Anything else is internal, for first-party plugins only.
- **First-party plugin:** a plugin shipped with the engine, in `src/plugins/<name>/`, versioned with the engine.
- **Third-party plugin:** a plugin found in a project's `plugins/<name>/` folder or in its `node_modules`.
- **Plugin set:** what a host (the player, the dedicated server, the editor) makes plugins active through (ADR 0144): it takes every plugin the host knows and the project's `plugins.disabled`, works out which are enabled, orders them, activates or deactivates their halves, and reports the ones that fail. Plugins never see it; they see only their half's context. _Avoid:_ plugin host, plugin manager.
- **Asset kind:** one type of asset file and how the editor treats it: how its files are recognised, its label and icon, what opening it does, its inspector, preview and import, and its policies.
- **Asset policies:** an asset kind's rules for use: which fields may reference it, whether and as what node it can be added to a scene, how exports process it, and whether it is read-only or an importer sidecar.
- **Asset document:** one open asset file in the editor. It owns the file's current value, queued saves, the read-only check, telling its own writes from outside edits, and its persistent undo tree (ADR 0027). That history follows the file when it is renamed and is dropped when the file is deleted.
- **Viewport tool:** a scene-view tool a plugin's editor half registers (ADR 0138), installed on every scene view: it gets presses before selection and the transform gizmo, hover and keys, draws overlays, and may be the **active tool**, the one mode that replaces the transform gizmo until Escape, Q/W/E/R or play. Tile painting is one; so is editing a collider (ADR 0142). A tool may also mark outlines **selectable**, so a click inside one picks its node.
- **Scene toolbar item:** a button a plugin's editor half adds to the Scene toolbar that opens a popover (ADR 0142), such as Navigation's Nav overlay toggles.
- **Component header action:** a control a plugin's editor half adds to the header of an Inspector component card for some Component types (ADR 0142), such as Physics' Edit Collider.
- **World service:** a lazily loaded per-World subsystem a plugin provides (physics 2D, physics 3D, navigation), started when a scene or an attached Component needs it. Other plugins can look one up as "that plugin's service, if enabled".
- **Physics backend:** a physics engine (Rapier today) adapted to the Physics plugin's backend interface for one dimension (ADR 0137). A backend plugin contributes it; the Physics plugin's shared sync core drives it through neutral descriptions, so Components and scripts never see it. A project picks one with `physics.backend2d`/`backend3d`, or uses the only one enabled. _Avoid:_ physics engine (for the plugin), physics world (that is one World's simulation).
- **Editor service:** the editor-side counterpart of a World service, a named, typed object a plugin publishes for other plugins to use if it is enabled.
- **Core:** what is never a plugin. In the engine: World, ECS, GameObject and Transform, scene files, prefabs and overrides, assets, time, input, `Engine`, the renderer core and netcode. In the editor (the **editor shell**): panels and docking, Hierarchy, Viewport, the Inspector and Assets frames, undo, the scene document, the Code panel, Play, Export, and the graph view.
