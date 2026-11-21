# 0303. The World delivers behaviour messages; physics only says who hears them and with what

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0007, 0017, 0026, 0091, 0092, 0093, 0132, 0135

## Context

Lifecycle hooks reach a GameBehavior through one private method, `World.invoke`: it skips behaviours inside a scene being edited (ADR 0026), logs a throw as `[myco] Name.hook threw:`, and catches a returned Promise so a rejection is logged as `[myco] Name.hook rejected:`.

The hooks that carry an argument (ADR 0091-0093: `onCollision*`, `onTrigger*`, `onJointBreak`, `onControllerColliderHit`) did not go through it. Four places wrote the delivery loop by hand: `PhysicsCore.notify` and `breakJoint`, `CharacterController2D.move` and `CharacterController.ts`'s `dispatchHit`. Each collected nodes, snapshotted components, checked for an active GameBehavior, looked up the hook, and wrapped the call in try/catch. They had drifted:

- **Returned Promises were dropped.** An `async onCollisionEnter` that rejected was an unhandled rejection, with no behaviour name (confirmed by a test).
- **No edit-mode gate.** The physics stages run whatever the edit flag says (`pushCollider` reads `isActiveAndEnabled`), so a physics World holding an edited subtree could call scripts the World itself would not call. The editor creates no physics for the scenes it edits, so this was latent. It was still a second copy of a rule the World owns.
- **Two lookup styles:** `_componentsOf` plus `instanceof GameBehavior` in the core, `getBehaviors(GameBehavior)` in the controllers.
- **De-duplication twice:** the node, the owner and (for colliders) the body's node, put in a `Set` by hand in `notify` and in the controllers.

## Decision

**The World owns delivery.** `World._sendMessage(nodes, hook, ...args)` calls `hook` with `args` on every active GameBehavior of `nodes` that defines it. It delivers to each node once (repeats and destroyed nodes are skipped), snapshots each node's components before calling (a hook may add or remove components), and calls through the same `invoke` lifecycle hooks use: the edit-mode gate, a throw logged with the behaviour's name, a rejected Promise logged with the behaviour's name. Delivery order is the order of `nodes`, then each node's component order (ADR 0029).

**Typed by the hook.** `MessageHook` (in `core/Component.ts`) is every `LifecycleHooks` key whose hook takes an argument; `MessageArgs<H>` is its parameters. So `_sendMessage(nodes, "onJointBreak", j, force, torque)` is checked against the hook's declaration and a misspelt hook does not compile.

**Physics decides only who hears what.** `PhysicsCore.notify` passes `[collider node, owner, body node]` and the other collider or the `Collision`; `breakJoint` passes the joint's node; both character controllers pass `[node, owner]` and the hit, once per hit. The hand-written loops and `dispatchHit` are deleted.

**`@internal`, not public.** `_sendMessage` sits beside `_componentsOf` in the internal tier first-party plugins use (GLOSSARY: SDK). These messages are engine events: game code that could send `onCollisionEnter` could fake a collision, and Unity's string-named `SendMessage` is the untyped surface we want to avoid. A public, user-defined message API would be a separate decision.

## Alternatives considered

- **A shared helper in the physics plugin** — fixes physics' four copies but leaves the edit-mode and async rules duplicated between the plugin and the World; the next plugin with a hook copies them again.
- **Public `GameObject.sendMessage(name, arg)`** — Unity-shaped, but string-named and open to game code; see above.
- **Make `invoke` itself take nodes** — mixes "one behaviour" (lifecycle transitions, which have their own ordering) with "the behaviours of these nodes"; two entry points over one private call is clearer.

## Consequences

**Positive**
- An async physics hook that rejects is logged with its behaviour's name, like `async start`.
- One place holds the rules for every hook; physics code shrinks to who and what.
- Hook names and arguments are type-checked at the call site.

**Negative / costs**
- Plugins depend on one more internal World method.
- A hook in an edited subtree no longer runs from a physics message; nothing relied on that.

## Deprecates

The hand-written delivery loops in `PhysicsCore.notify` and `breakJoint`, `CharacterController2D.move`, and `dispatchHit` in `CharacterController.ts` (removed).

## Open questions

- The music hooks (`onMusicBeat`, `onMusicBar`, `onMusicCue`, ADR 0166) are message hooks too and are still delivered by hand in `plugins/audio/runtime/music/musicSystem.ts` (`deliverToComponents`), with the same missing async and edit-mode rules. Moving them onto `_sendMessage` is a one-call change, left to the audio runtime's owner.

## References

- `src/engine/core/World.ts` (`_sendMessage`, `invoke`), `src/engine/core/Component.ts` (`MessageHook`, `MessageArgs`).
- `src/plugins/physics/runtime/core/PhysicsCore.ts`, `CharacterController2D.ts`, `CharacterController.ts`.
- Tests: `src/engine/tests/behaviourMessages.test.ts`.
