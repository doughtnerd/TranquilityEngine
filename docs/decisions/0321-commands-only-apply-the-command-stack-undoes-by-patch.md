# 0321. Commands only apply; the command stack undoes by patch

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** 0026 in part ("a command can apply and undo itself")
- **Related:** 0026, 0027, 0077, 0231, 0267, 0287

## Context

ADR 0026 made every scene edit a command that "can apply and undo itself". Since ADR 0027 the `CommandStack` records each step as a patch of the document (`diffFiles(before, after)`) and undoes, redoes and jumps by applying stored patches (`applyPatch`, then `doc._replace`); a cancelled group (ADR 0231) puts back the snapshot taken when it began. Nothing in production calls a command's `undo`.

Yet the `Command` interface required `undo`, and every command carried hand-made undo code: 14 `undo` methods in `commands.ts`, `prefabCommands.ts` and `nodeCommands.ts`, the `snapshot`/`restore` helpers, `SetField`'s `undoState` closures, and `CommandGroup.undo` (never called; `CommandGroup` itself was unused, since `beginGroup` records a group as one diff). Applying paid for it: `ReplaceDocument.apply` cloned the whole document (`doc.toJSON()`) on top of the clone the stack already takes, and `SetTags`/`SetComponentWorlds` copied whole entries. The one test of command undo (`overrideWriter.test.ts`) called `command.undo(doc)` directly, a path no caller takes, so real undo could break while it passed. `RebuildInstances` had no caller at all.

## Decision

- **A command is a label, an `apply` and optional file writes.** `Command` is `{ label; apply(doc): Change[]; files? }`. `apply` edits the document in place and returns what changed for the Editor World (`WorldSync`); `files` are text files the stack writes (ADR 0077). A command keeps no state for undoing.
- **The stack is the only undo.** `CommandStack.execute` runs a command; undo, redo, jumps and `cancelGroup` stay as ADR 0027/0267/0231 built them (patches and snapshots), unchanged here.
- **Deleted:** every `undo` method, `snapshot`/`restore`, `SetField.undoState`, the `previous`/`before`/`removed`/`hadList` bookkeeping, `ReplaceDocument`'s extra clone, `CommandGroup`, the unused `RebuildInstances`, and `RevertOverrides.count` (unused).
- **One mutation route.** Commands edit the entries `SceneDocument.node()` returns, in place, from `apply` (all of them did; the tag and Worlds commands now place new keys with the same `setKey` helper as the rest). `node()`'s comment says so: commands edit it; everything else treats it as read-only.
- **Tests go through the stack.** Command tests use `stack.execute`, `stack.undo` and `stack.redo`; the override writer's undo check runs on a real `CommandStack`, and `document.test.ts` round-trips the remaining commands (tags, Worlds, enabled, component order, preload, `ReplaceDocument`, `RevertOverrides`) byte for byte, key order included.
- **Editor SDK.** `Command` reaches `myco/editor`'s declarations through `OpenScene.stack.execute`. A plugin's class that still has an `undo` method keeps compiling and working (the stack never called it); an object literal with `undo` passed straight to `execute` now fails the excess-property check, fixed by deleting the method. No first-party plugin implements `Command`.

## Alternatives considered

- **Keep `undo` optional** — leaves a second undo path that nothing runs and nothing tests; the next command author would still wonder whether to write one.
- **Undo by command again, dropping patches** — ADR 0027's persisted, tree-shaped history needs patches that outlive the command objects (they are written to `myco.history@1`); command undo can't be saved.

## Consequences

**Positive**
- Undo correctness has one owner (the history tree and its patches); a new command is about half the code.
- Applying no longer pays for undo: no whole-document clone in `ReplaceDocument`, no entry copies in tag and Worlds edits.
- The undo test exercises the path users take.

**Negative / costs**
- A command can't be undone outside a `CommandStack` (nothing did that).
- The small SDK typing change above for plugins that pass object literals with `undo`.

## Deprecates

`Command.undo`, `CommandGroup` and `RebuildInstances` (removed). ADR 0026's sentence "A command can apply and undo itself" is superseded; the rest of 0026, and 0027 and 0267, stand.

## Open questions

None.

## References

- `src/editor/document/commands.ts`, `prefabCommands.ts`, `nodeCommands.ts`, `CommandStack.ts`, `SceneDocument.ts`
- `src/editor/document/document.test.ts`, `src/editor/overrideWriter.test.ts`
- Architecture review pass 12, candidate 1 and the `SceneDocument.node()` comment fix
