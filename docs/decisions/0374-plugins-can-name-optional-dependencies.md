# 0374. Plugins can name optional dependencies

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0133 (the manifest gains `optionalDependencies`)
- **Related:** 0372

## Context

A plugin manifest (`src/plugins/manifest.ts`) has one kind of dependency, `dependencies`. `order.ts` throws when one is missing, and `pluginSet.ts` refuses to activate a plugin whose dependency failed.

Animation's beat-timed plays (0372) want the audio plugin when it is enabled and nothing when it isn't. The ragdoll plugin (0375) and later integrations will have the same shape. Today such a plugin must either hard-depend, forcing audio on every animated project, or probe globals, which breaks the activation order.

## Decision

We will add **`optionalDependencies`** to `PluginManifest`, with the same shape as `dependencies` (name → version range):

- **Ordering:** when the named plugin is enabled, it activates first and deactivates after, exactly like a dependency. `order.ts` sorts by the union of both lists, and cycles through either kind are refused, as today.
- **Absence is fine:** a missing or disabled optional dependency never blocks activation and never warns.
- **Failure is fine:** an optional dependency that fails to activate doesn't block the plugin. The plugin activates without it, and the Plugins category shows "Audio integration unavailable: myco.audio failed".
- **A version outside the range** is treated as absent, with one warning naming both versions.
- **Runtime check:** the runtime context gains `ctx.plugins.isActive(name): boolean`, read at activation. A plugin registers its integration code only when the optional dependency is active.
- **Re-activation:** enabling or disabling an optional dependency later re-activates the dependent plugin through the existing diff-and-activate path (`pluginSet.ts`), so the integration appears or goes without a reload.
- **Editor halves** follow the same rules.
- **Third-party plugins** (`thirdParty.ts`) may use it too.

## Alternatives considered

- **Hard dependency on audio.** Simple, but every animated project would carry the audio core.
- **Probe for the other plugin's exports at call time.** No ordering guarantee, and it breaks on re-activation.
- **A third "integration" plugin per pair** (`myco.animation-audio`). Correct but noisy: every cross-feature hook would become a plugin the user must enable.

## Consequences

**Positive**
- Integrations stay inside the plugin that owns them and switch on by themselves.

**Negative / costs**
- Plugins with optional integrations have two activation paths to test.

## Deprecates

Nothing.

## Open questions

None.

## References

`src/plugins/manifest.ts`, `order.ts`, `pluginSet.ts`, `enabled.ts`, `runtimeContext.ts`.
