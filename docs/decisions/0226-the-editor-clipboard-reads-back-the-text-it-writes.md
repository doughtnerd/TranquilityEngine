# 0226. The editor's clipboard is one module that reads back the text it writes

- **Status:** Accepted
- **Date:** 2026-11-17
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0026, 0046, 0048, 0060, 0133, 0174, 0180

## Context

Copying scene nodes (0022, 0026) and graph pieces (shader graphs 0048, particle graphs 0060) kept the copy in memory and also wrote it to the system clipboard as JSON tagged with a `format`. Nothing read that text back:

- `nodeClipboard.ts` wrote `myco.nodes@1` text, and paste used only the in-memory clipboard. Its test checked the shape of JSON nobody parsed.
- `editor/graph/clipboard.ts` (the shared graph layer, 0060) had `writeGraphClipboard` and `parseGraphClipboard`. The parser had no callers and no tests. Both graph panels wrote text and pasted from memory.

Detached panel windows share the main window's realm (0174, 0180), so memory already covers every window of one editor. What the text can add is pasting into another editor process: a second project window, or the editor after a restart. It can also move graph pieces between graphs as text.

A paste can't read the clipboard freely. `navigator.clipboard.read`/`readText` asks for permission (and Tauri's webviews differ). A `paste` event's `clipboardData` needs no permission, but it only fires if the Ctrl/Cmd+V keydown is not prevented. Every copier prevented it. Some platforms (WebKit outside text fields) may fire no event at all.

Nodes from another project raise one more question. `entriesForPaste` already clears references to nodes outside the source scene. But an instance of a prefab the target project doesn't have was pasted as is, and the loader then showed it as an empty node with a problem ("prefab … not found").

## Decision

We will have one editor clipboard module, `src/editor/clipboard.ts`, replacing `editor/graph/clipboard.ts`. The editor SDK (`myco/editor`) exports it, because the graph panels are plugin editor halves. It provides:

- `clipboardText(payload)`, the JSON for a `{ format, … }` payload.
- `writeClipboard(payload)`, which writes the text with `navigator.clipboard.writeText` (best effort) and remembers the text and whether it reached the clipboard.
- `readClipboard(text, format, valid)`, which returns the payload, or null for text that isn't JSON, has another format, or that `valid` rejects.
- `clipboardForPaste(text, memory, read)`, the rule for which copy a paste takes (below).
- `expectPaste(run)` and `takePaste(event, run?)`, which plumb paste events.

**Pastes read the system text only from `paste` events.** The Ctrl/Cmd+V keydown calls `expectPaste` and no longer prevents the default. The browser then fires `paste`, and `takePaste` hands the event's `text/plain` to the waiting paste. If no event comes by the next task, the paste runs with no text, so from memory. A `paste` event with no keydown waiting goes to the handler of the place it lands, so the browser's or the desktop window's Edit > Paste works too. Menu and context-menu Paste items (which have no event) keep using memory, and nothing calls `navigator.clipboard.read`, so there are no permission prompts.

**Which copy wins.** The system text wins when it parses and validates as the right kind, unless:

- it is exactly the text this editor last wrote (then the two are the same copy), or
- this editor's last write is known to have failed. In that case the text is older than the copy in memory.

Otherwise memory wins. Text that isn't a payload of that kind (plain text, another graph's pieces) falls back to memory. When one side is missing, the other is used. Nodes pasted from the text become this editor's in-memory node clipboard, so the Edit menu's Paste item can paste them again.

**Well-formed means the format's own reader accepts it.**

- **Nodes:** `nodeClipboardFromText` checks the payload. It needs a `source` string and at least one non-empty subtree. Each subtree is a root and then descendants whose `parent` appears earlier in that subtree. No id appears twice. Entries have string ids and correctly shaped `name`, `prefab`, `parent`, `components` and `overrides`.
- **Shader graphs:** `graphClipboardFromText` runs the pieces through `parseShaderGraph`.
- **Particle graphs:** `particleClipboardFromText` runs them through `parseParticleGraph`.

Each graph reader rejects the text if the parser reports any problem or drops any item.

**A prefab the project lacks is refused.** `whyNotPastable` returns "the prefab `<path>` isn't in this project" for an instance of a missing prefab. It names each missing prefab, nested instances added by overrides included. The clipboard holds only the instance and its overrides, not the prefab's contents, so the instance can't be unpacked into plain nodes. Pasting it would make the empty-node-with-a-problem the loader shows for a deleted prefab, on purpose and silently. The check uses the project's files (`Assets.has`, as the prefab tools do), so it also covers a prefab deleted since the copy in the same editor. Duplicate is not a paste: an instance whose prefab is missing duplicates as it is, because the scene already holds one.

## Alternatives considered

- **Read with `navigator.clipboard.readText()` on every paste:** this covers the menu items too, but it prompts for permission (Chromium on first use, Safari every time) and needs a secure context. Rejected.
- **The system text always wins when it parses:** this is simpler. But a refused write (no permission, document not focused) would make the paste pick up an older payload from another process instead of the copy just made here.
- **Unpack instances of missing prefabs into plain nodes:** impossible, because the clipboard doesn't carry the prefab's nodes. Carrying them would grow every copy and fork the prefab.
- **Paste missing-prefab instances anyway, as the loader tolerates them:** the user would get empty nodes and orphaned overrides with no warning at paste time.
- **Keep the clipboard in `editor/graph/`:** the node clipboard isn't a graph. One module, exported once by the SDK, keeps one rule for every copier.

## Consequences

**Positive**
- Nodes and graph pieces paste across editor processes and projects. Every copier uses the same tagged-JSON contract and the same rule for which copy wins.
- The text that copies write is now tested by round trips: copy, then text, then paste, through each module's interface.
- Cross-project pastes of prefab instances fail with a message that names the prefab, instead of making broken nodes.

**Negative / costs**
- Ctrl/Cmd+V in the Hierarchy and the graph panels now waits for the browser's `paste` event, or one task, before pasting.
- Where the platform fires no `paste` event outside text fields, only memory pastes, so another process's copy isn't seen there.
- The "last write failed" rule can't tell a later copy in another process from older text. In that case memory wins.

## Deprecates

- `src/editor/graph/clipboard.ts` (`writeGraphClipboard`, `parseGraphClipboard`) is removed. Its replacements are `writeClipboard` and `readClipboard` from `myco/editor`.
- `clipboardText(clip)` in `nodeClipboard.ts` is removed. It is replaced by `nodeClipboardPayload` plus the module's `clipboardText`.
- `pasteNodes`'s `verb` parameter is gone (Duplicate adds its copies itself).

## Open questions

- The Assets panel's file clipboard (`assetOps.ts`) is still memory only. Copying files between projects would need paths that resolve outside the project.

## References

- `src/editor/clipboard.ts`, `src/editor/nodeClipboard.ts`, `src/editor/hierarchyActions.ts`, `src/editor/shortcuts.ts`
- `src/plugins/materials/editor/shaderGraph/graphEdit.ts`, `src/plugins/particles/editor/particleGraph/graphEdit.ts` and their panels
