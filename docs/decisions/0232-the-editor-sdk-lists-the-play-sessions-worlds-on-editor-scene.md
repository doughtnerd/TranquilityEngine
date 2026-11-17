# 0232. The editor SDK lists the play session's Worlds on `editor.scene`

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0138 on play Worlds and 0147's `editor.scene`)
- **Related:** 0032, 0065, 0133, 0138, 0147, 0162

## Context

ADR 0138 hands a viewport tool its Editor World and treats a World as engine internals, so the context is internal tier. It says nothing about the play session's Worlds, and 0147's `editor.scene` offers only `playState`. Plugins that draw over the running game therefore read the shell's `playing` signal (`state.ts`, re-exported by `session.ts`) and the `PlaySession` type (`playMode.ts`), and each turns the session into Worlds itself with `session.engine.worlds()` and `engine._world(name)`:

- `plugins/navigation/editor/navGizmo.ts`: a runtime navigation overlay on every play World;
- `plugins/navigation/editor/NavDebugPanel.tsx`: the runtime's counters and warnings while playing;
- `plugins/audio/editor/OcclusionOverlay.ts`: occlusion rays on every play World (0162 E4).

That is two plugins and three callers, five entries in the internal-tier allowlist (`src/plugins/plugins.test.ts`), and the same five-line effect copied twice. The callers need only the Worlds and to hear when they change: none steps, pauses or stops the session, and none needs the rest of `PlaySession` (its view, net play setup, conditions).

## Decision

We will expose the play session's Worlds, read-only, on `editor.scene` (`src/editor/sdk/scene.ts`):

```ts
interface SceneSurface {
  /** The play session's Worlds, in creation (and step) order; empty while editing. Tracks. */
  readonly playWorlds: readonly World[];
  /** `playWorlds` without tracking. */
  peekPlayWorlds(): readonly World[];
}
```

- It is a `computed` over the shell's `playing` signal: a new frozen list when a session starts or stops, the same list otherwise, so an `effect` reading it adds per-World overlays (`addEditorOverlay`) and removes them from the previous list. Reading it is the change signal; there is no separate event.
- Read-only means the surface gives no way to change the session: stepping, pausing and stopping stay with the play bar. A plugin reads a World's state and draws over it (overlays, its own runtime's debug data, ray queries), as the three callers do.
- A play World is still engine internals, so `playWorlds` is internal tier like a viewport tool's `world` (0138): first-party plugins use it; a third-party plugin that does is on its own across engine versions. This amends 0138, under which a World reached a plugin only through a viewport tool's context, so far as `editor.scene` may also name the play Worlds; it doesn't make `World` public API.
- The three callers move onto it, and their five allowlist entries go. `playing` and `PlaySession` stay shell-only.

## Alternatives considered

- **Keep the allowlist entries.** Each new debug overlay would copy the effect again and widen the internal tier. The architecture review rated the seam speculative, worth it once more plugins need it; two plugins and three callers already do.
- **Expose `PlaySession` on the SDK.** Gives plugins `setPaused`, `step`, `stop` and the net play setup, which none needs and which would let a plugin fight the play bar.
- **A per-World overlay contribution** (`registerPlayOverlay(id, world => provider)`, the shell adds and removes it). Narrower for the two overlays, but the Nav Debug panel samples a World's runtime rather than drawing, so it would still need the Worlds. Can be built on `playWorlds` later if more overlays arrive.

## Consequences

**Positive**
- Plugin editor halves no longer import `editor/state`, `editor/session` or `editor/playMode` for play mode; the allowlist loses five entries.
- One place turns a session into its Worlds (`engine._world` stays inside the SDK).

**Negative / costs**
- `editor.scene` names an engine-internal type (`World`), as `ViewportToolContext` already does.
- The list follows the session, not Worlds created or disposed during it (as before: the callers computed it once per session too).

## Deprecates

The three callers' imports of `playing` and `PlaySession`, and their allowlist entries in `src/plugins/plugins.test.ts` (removed).

## Open questions

- Whether Worlds created during a session (a lobby's match World) should appear in `playWorlds` as they come; it would need a change signal from the Engine.

## References

- `src/editor/sdk/scene.ts`; `src/editor/state.ts` (`playing`); `src/editor/playModeWorlds.test.ts` (the test).
- [0138](0138-viewport-tools-are-an-editor-contribution-point-with-one-active-tool.md); [0147](0147-the-editor-sdk-gives-plugins-the-project-status-and-scene-through-one-editor-object.md).
