# 0037. The engine is renamed Myco Engine, by Foxfire Studios

- **Status:** Accepted
- **Date:** 2026-11-02
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0003, 0013, 0024, 0027, 0030, 0033

## Context

The engine was called TranquilityEngine. Its maker's studio is Foxfire Studios, and the engine is rebranded to match: **Myco Engine**, with its own logo, icon and colour palette (glowing cyan mycelium, moss green on near-black; the art is in `branding/`). The old name was everywhere, in user-visible text and in identifiers that projects and saved data depend on: the module scripts import (`"tranquility"`), scene and history file formats (`tranquility.scene@1`), the project's `.tranquility/` folder, browser storage keys, the dedicated server's command and the Tauri app identifier.

## Decision

We will rename everything, not only what users see:

- **Names:** "Myco Engine" in titles, the start screen, docs and the desktop app (`productName`); the npm package `myco-engine`; the Rust crate `myco` (`myco_lib`); the dedicated server `myco-server`; log lines start `[myco]`.
- **Identifiers:** scripts import the engine as `"myco"`; files are written as `myco.scene@1`, `myco.history@1` and `myco.history-slot@1`; the editor keeps per-project files in `.myco/`; browser storage keys start `myco.`; the Tauri identifier is `com.foxfirestudios.myco.editor`.
- **Compatibility** with what was made before the rename:
  - `import … from "tranquility"` keeps working in the editor, the dedicated server, the Code panel's type checking, project `tsconfig.json` files and tests (an alias of `"myco"`).
  - `tranquility.scene@N` files load as `myco.scene@N`; history files in the old formats are read.
  - Editor preferences and the panel layout are read from their old `tranquility.` keys when the new ones are missing.
- Accepted ADRs keep the old name in their text; they record what was decided then.

## Alternatives considered

- **Visible branding only.** No breakage, but the code and file formats would carry a name the product no longer has, forever.
- **Full rename without compatibility.** Simpler code, but every existing project and script would break at once.

## Consequences

**Positive**
- One name across the product, its files and its code.

**Negative / costs**
- Things not carried over: edit history kept in a project's old `.tranquility/history/` folder or in the browser's per-user store (`tranquility-editor`), games' browser saves (IndexedDB `tranquility:<game>`), and the desktop app's data folder (the identifier changed). None of these had shipped to players.
- The compatibility aliases stay until a later record removes them.

## Deprecates

The `"tranquility"` import specifier and the `tranquility.*` file formats: still read, no longer written.

## Open questions

- When to drop the `"tranquility"` aliases.

## References

- `branding/` (logos and icons), `src/editor/scriptLoader.ts` (`LEGACY_ENGINE_MODULE`), `src/engine/scene/SceneLoader.ts` (`migrateSceneFile`).
