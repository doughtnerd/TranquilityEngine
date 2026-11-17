# 0235. One story harness builds the editor surface, and stories reach editor state only through it

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0219: how a story gets an editor to render in)
- **Related:** 0143, 0144, 0147, 0219, 0228, 0231, 0232, 0233

## Context

ADR 0219 made stories the tests of editor components, rendered through their real props in a real browser. It left
"stories for the rest of the editor's components" open, and in practice only the audio plugin had any: 8 story files,
none for the ~33 components of the particles, navigation, physics, materials, tilemaps and sky plugins, or for
`src/editor/ui`. Most of those components read the editor rather than props: the open project, an asset's current value,
the open scene and its selection, the viewport tool's mode, the play session's Worlds (`editor.project`, `editor.assets`,
`editor.scene`, `editor.viewport`, ADR 0147, 0231, 0232, 0233). Nothing built that for a story, so each audio story that
needed it opened a project by hand and set the shell's own signals (`currentProject`, `playState` from `editor/state`),
which plugins are never meant to touch. The Shader Graph's copy, paste and group were tested only by an e2e spec that
needs WebGPU and is skipped where there is none.

## Decision

We will build an editor for a story in one place, the story harness `src/editor/stories/editorStory.tsx`, and stories
will reach editor state only through the editor SDK surface.

- **`withEditor`**, a Storybook `beforeEach`, reads `parameters.editor` (`files`, `root`, `scene`) and does what the
  editor's boot and a project opening do: registers the core asset kinds and the built-in panels, opens a writable
  project over `MemoryFileSystem` with `openFolderProject`, applies the first-party plugins through the editor's own
  plugin set (`applyEditorPlugins`, with the project's `plugins.disabled`), and, with `scene`, opens that scene in the
  editor's own scene tabs (`createSceneTabs`, no history, closing never asks) over the Editor World of a headless
  editor Engine; `sceneTabs.ts` stays the only writer of the open scenes. Its cleanup (asynchronous: it closes the tabs) leaves no project, no scene, edit mode and nothing selected. A meta sets
  `beforeEach: withEditor` and its files; a story overrides `parameters.editor`.
- **What only the shell's own UI does** the harness does as that UI does: `startPlaying()` runs a real play session of
  the open scene (`startPlay`, as the play bar's Play), so `editor.scene.playWorlds` lists real Worlds; `stopPlaying()`;
  `setPlayState(state)` sets play mode alone, for a component that reads only `editor.scene.playState`.
- **`PanelStory`** renders a registered panel (built-in or a plugin's) as the dock does (`panelView`), in a panel
  instance of its own, so a story tests the panel the user sees, lazy load included.
- `storyProject()`, `fileText(path)` and `fileJson(path)` read the project and what a save wrote to the in-memory folder.
- **Rules.** A story file imports no `editor/state`; it drives the component as a user does and checks the outcome through
  the surface (`editor.scene.open.doc`, `editor.assets.openIn`, `editor.viewport.mode`) or in the saved file. The harness
  is story code beside `testing.ts`'s role for unit tests, never imported by the editor build, and adds nothing to
  production modules (CLAUDE.md's testing rule).
- **First stories on it.** The Shader Graph and Particle Graph panels (the `useGraphSelection` shortcuts: click and
  Shift-click, box select, Delete, Escape, Ctrl+C/V/X/D/G, a selected block deleted first): they are the Shader Graph's
  copy, paste and group coverage where WebGPU is missing. The preview draws nothing in the story browser and the
  Particle Graph's is turned off with its own Preview button; no flag was added. Also the particle inspectors and a
  ParticleSystem's overrides in the shell Inspector, the physics Edit Collider header action through `editor.viewport`,
  the Navigation debug panel over a real play session and the real WebAssembly runtime, the Tileset inspector, and the
  shell Inspector (scene settings, node header, component card, several nodes, a revealed asset). The four audio story
  files that opened projects or set play mode moved onto the harness.

## Alternatives considered

- **A Storybook decorator that renders the editor around the story.** Decorators render synchronously, and opening a
  project, applying plugins and creating an Engine are asynchronous; a `beforeEach` finishes before the story renders and
  returns its cleanup. Not chosen.
- **A fake `EditorSurface` handed to components.** Components import the `editor` singleton, so a fake would need a
  prop or a seam added for stories, which the testing rule forbids, and it would test a stand-in. Not chosen.
- **Keep per-story setup.** Each new story would repeat the project, plugin and scene setup and reach into the shell's
  signals. Not chosen.

## Consequences

**Positive**
- A story for any editor component is a few lines of files plus a `play`; 29 new story tests, 86 in all.
- The graph panels' shared shortcuts are covered in a real browser without WebGPU.
- Stories use the same plugin set, panel renderer and play session as the editor, so they catch what unit tests can't:
  writing them found two bugs, below.

**Negative / costs**
- Each story applies every first-party plugin and, with `scene`, creates an editor Engine; the first story of a file
  that renders the Inspector waits for its lazy load (the stories allow 30 s).
- The collider tool's handles still need a scene view; they stay unit tests (`collider2d.test.ts`, `collider3d.test.ts`).

## Deprecates

The audio stories' own project opening (`openFolderProject` + `currentProject`) and their writes to `playState`.
`MixerPanel.stories.tsx` still opens the Project Settings panel's session (`projectSettings.open`) to press that
panel's Undo; the surface has the same history but not "the panel's Undo label".

## Open questions

- Stories for the remaining plugin components (the Sky panel, the Material inspector, the Tile Palette, the navigation
  settings and component inspectors, the Formation inspector) and more shell panels.
- Whether `withEditor` should apply only the plugins a story names, to make stories faster.

## Notes from building (2026-11-17)

- The particle sub-graph and block Inspector (`ParticleAssetInspector`) now reads `editor.assets.read` (the current
  value, ADR 0233) and turns the document back into the asset's JSON (`docToAsset`) for its summary, instead of reading
  the raw file; a file that isn't one shows the format's own problem. `SubgraphAsset` shows an unwritten edit.
- Bugs the stories found, left for their owners (both outside this change's files): (1) Revert on a ParticleSystem's
  property override removes it from the scene document, but the Editor World keeps it, because `writeField` →
  `assignField` deep-merges a plain-object field (`mergeDeep`), so writing `{}` keeps the old keys; the Inspector shows
  the stale override until the scene is rebuilt. (2) Escape in the Inspector's name field should drop the typed name,
  but its `TextInput` resets the draft and then blurs, and the blur commits the stale draft, so the typed name is saved.
  The stories note where they will assert the fixed behaviour.

## References

- `src/editor/stories/editorStory.tsx`; the stories listed above; `.storybook/`; `vitest.stories.config.mts`.
