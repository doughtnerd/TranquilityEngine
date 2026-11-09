# 0144. One plugin set module resolves, orders and activates plugins for every host

- **Status:** Accepted
- **Date:** 2026-11-09
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0135's and 0139's activation sections)
- **Related:** 0133, 0134, 0135, 0137, 0139

## Context

Turning plugins on is spread across two activation engines, three failure policies and about eight hosts:

- **Two engines.** `plugins/runtimeContext.ts` (`activateRuntimePlugins`, plus a stub context for disabled halves that only unclaims their decorated Components) and `editor/sdk/plugins.ts` (`activatePlugins`). Each implements "one undo list per plugin, roll back on throw" with its own module-global `active` map.
- **Three failure policies.**
  - The runtime engine rolls back and rethrows, so a failing plugin stops the player or the server.
  - `plugins/editorApply.ts` loops: it drops whichever plugin failed and retries the rest.
  - `plugins/thirdPartyEditor.ts` keeps its own `activeRuntime`/`activeEditor` lists and marks dependents of a failed plugin as blocked ("needs X, which failed").
- **"Enabled" worked out in several places.** `editorApply.ts` resolves over first-party manifests and `thirdPartyEditor.ts` over first- and third-party together. `player/main.ts` and `server/run.ts` each activate twice with the same code, the second time with the enabled list concatenated by hand. `playMode.ts` calls `syncRuntimePlugins`, and `testSetup.ts` activates everything.
- **`editor/session.ts` coordinates it.** It applies first-party plugins, then loads project code (which activates third-party halves), re-applies and rebuilds on a settings change, and keeps a `pendingPlugins` flag for changes made during Play.

Tests reach this through module globals: about 70 `activate…`/`deactivate…` calls in test files, and 4 files that re-activate everything in `afterEach`. A rule that spans hosts, such as "a third-party plugin whose first-party dependency is disabled is off in the editor and the player alike", has no single place to be tested.

## Decision

We will add one **plugin set** module that every host uses to make a set of plugins active.

- **Where.** `src/plugins/pluginSet.ts`, host-neutral: it imports no editor code, so the player and the server use it.
- **Halves through adapters.** The set drives each half through a small activator: the runtime activator (today's runtime context, including the stub that unclaims a disabled half's Components) and the editor activator (today's editor context). The editor host passes the editor activator in. These are the set's two adapters. Plugins still see only their per-half context (ADR 0134, 0135); the set is the hosts' interface, not the plugins'.
- **Apply.** A host gives the set:
  - every plugin it knows: first- and third-party, each a manifest with an optional runtime half and an optional editor half;
  - the project's `plugins.disabled`;
  - host traits: whether it is the server, whether it is the editor.

  The set then does the rest:
  - resolves the enabled set once, with `resolveEnabledPlugins` over all manifests;
  - drops runtime halves marked `server: false` on the server;
  - orders by dependencies (`orderPlugins`);
  - diffs against what is active. Halves no longer wanted, or whose module object changed (a script reload), are deactivated dependents first, together with the same half of the plugins that need them. Then the missing ones activate in order: every runtime half, then every editor half.
- **Order of each half.** Entries with the same name are one plugin, and each half keeps the position of the entry that gave it, so a host can list runtime halves in one order and editor halves in another. The editor needs this: `RUNTIME_PLUGINS`' order breaks ties between systems and render features, and `EDITOR_PLUGINS`' order decides panel tabs and settings sections, and the two differ. (Found while building.)
- **Reloads during Play.** The apply input also takes `keepRuntime`: runtime halves are left exactly as they are and only editor halves are diffed, for a script reload while the game runs. (Found while building.)
- **One failure policy.** When a half throws, both halves of that plugin are rolled back, and its dependents are skipped with "needs X, which failed to activate". Apply never throws. It returns the active plugin names and a list of problems (`{ plugin, where, message }`).
- **Hosts decide what a problem means.** The editor shows problems in the status bar with the script problems (as today). The player and the dedicated server stop with the first problem's message, keeping ADR 0139's rule that a broken plugin fails like a broken script.
- **Applying again is cheap.** A host may apply several times as it learns more. The editor applies the first-party plugins at boot, then applies first- and third-party together once project code has loaded. Unchanged active halves are kept. Play still keeps the plugins it started with until Stop (`session.ts`'s pending flag stays a host concern).
- **Hosts.** `player/main.ts`, `server/run.ts`, `editor/playMode.ts`, `plugins/editorBoot.ts`, `editor/session.ts` (open, settings change, reload, close) and `plugins/testSetup.ts` each call the set. `plugins/editorApply.ts` is removed. The activation loop in `thirdPartyEditor.ts` goes; its discovery, checks and module loading stay, and they hand halves to the set. `enabledRuntimePlugins` goes.
- **Instances.** The set is created per host, so a test builds one with fake plugins and fake activators and checks the policy without touching the global registries. Contributions themselves still land in the existing global registries; that is unchanged.

## Alternatives considered

- **Keep the two engines and share only a helper for the undo list.** That removes about 20 duplicated lines but leaves three failure policies and several ways of working out "enabled".
- **A central plugin host with one large lifecycle interface for plugins** (rejected in ADR 0133). This record doesn't do that: the plugin-facing interface stays the per-half context; only the host-facing side is unified.
- **Make every registry per-instance, so a plugin set owns its contributions.** That would give the cleanest tests, but it touches the Component registry, World services and render features engine-wide for little gain over injected activators.

## Consequences

**Positive**
- Locality: enabling, ordering, failure and diffing live in one module.
- Leverage: each host makes one call; the player and the server lose their duplicated two-step activation.
- Cross-host rules are testable with fake plugins.
- `session.ts` and `thirdPartyEditor.ts` shed their bookkeeping.

**Negative / costs**
- The player and the server now report a failing plugin through the returned problems instead of an exception, so a host that ignores them would start without the plugin. Each host must check (covered by a test per host).
- A broad migration of tests that call `activatePlugins`/`deactivatePlugin` directly. The low-level calls stay available inside the adapters, but tests move to the set or to a test helper.

## Deprecates

- `plugins/editorApply.ts` (`applyEnabledPlugins`'s retry loop): removed.
- `thirdPartyEditor.ts`'s `activeRuntime`/`activeEditor` lists and `activateThirdParty`: removed.
- `enabledRuntimePlugins`, and `syncRuntimePlugins` as a host call: removed or made internal.
- Direct host calls to `activateRuntimePlugins`/`activatePlugins`: they become the adapters' internals.

## Open questions

- Whether the editor shows "needs X, which failed" inline in the Plugins category as well as in the status bar.

## References

- `src/plugins/runtimeContext.ts`, `src/editor/sdk/plugins.ts`, `src/plugins/editorApply.ts`, `src/plugins/thirdPartyEditor.ts`, `src/plugins/enabled.ts`, `src/plugins/order.ts`, `src/player/main.ts`, `src/server/run.ts`, `src/editor/playMode.ts`, `src/editor/session.ts`, `src/plugins/testSetup.ts`.
- Architecture review, 2026-11-09 (candidate 2).
