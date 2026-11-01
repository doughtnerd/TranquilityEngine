# 0027. Persistent, tree-shaped edit history

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0024, 0026

## Context

0026 made every edit a command on a scene document, with an undo/redo stack in memory. A crash, or closing the editor by accident, loses that history, and with it any unsaved work. Undoing and then making a new edit also throws the undone edits away for good.

The owner wants history to behave like Neovim's undo tree: undoing and making a different edit starts a new branch instead of discarding the old one, any earlier state can be revisited, and history survives restarts via a persistent undo file. Writing that file must not risk corrupting it if the editor dies mid-write.

Commands are objects holding closures and live references, so they can't be written to disk as they are.

## Decision

- **History is a tree of document states.** State 0 is the document as history began. Each later state records its parent, a label, a time, a sequence number (the order states were made), a hash of the document in that state, and two patches: one to reach it from its parent, one to go back.
- **Patches are document diffs, not commands.** A patch holds the full new value of each node entry that changed (or `null` for a removed node), the new node order when the order or set of nodes changed, and any changed top-level keys. Live edits still run through commands (0026), so the Editor World gets fine-grained updates while dragging. History records the diff between the document before and after each step (a command, or a group such as a drag).
- **Navigation.** Undo goes to the parent. Redo goes to the child last visited, which is the newest branch unless you navigated elsewhere. A new edit after undoing adds a sibling branch; nothing is discarded. You can jump to any state: the editor undoes up to the common ancestor, then redoes down. Stepping through states in creation order (like Vim's `g-` / `g+`) uses the sequence numbers. History keeps at most 1000 states: branches off the current path go first (oldest first); after that the root advances along the current path.
- **Persistence.** History is saved per scene file after every step, undo, redo, jump and save (writes are queued and coalesced). The format is `tranquility.history@1` JSON with the scene path, states, the current state, and the saved state.
  - **Location:** by default the project folder, at `.tranquility/history/<scene path>.history.<a|b>.json`. Hidden folders aren't listed as assets. A per-user setting switches to user storage outside the project: the app data folder under Tauri, IndexedDB in a browser. Projects that can't be written to, such as the bundled demo, always use user storage.
  - **Crash safety:** writes alternate between two slots (`a` and `b`). Each slot carries a generation number and a checksum of its content, and each write goes through the platform's temp-file-then-rename write (0024). Loading reads both slots and takes the newest valid one, so a failure mid-write can only damage the slot being written; the other still holds the previous generation.
- **Reopening a scene** finds the history state whose hash matches the file on disk: the saved state if it matches, otherwise any matching state. If none matches (the file was changed outside the editor), that history is set aside and a new one starts, as Vim ignores an undo file whose hash doesn't match. If the history's last current state was past the matching state (unsaved changes when the editor closed), the editor offers to restore them. Declining keeps them in the tree, reachable with redo or the History panel.
- **History panel**, dockable like the other panels (0025): it draws the tree with labels and times, marks the current and saved states, and jumps to a state on click.

## Alternatives considered

- **Serialize commands.** Every command would need a serializable form and a deserializer, and replaying them depends on code versions. Diffs of the document are self-contained.
- **Store a full document snapshot per state.** Simplest, but grows with scene size times edit count. Node-level diffs stay small.
- **A linear stack with persistence only.** Loses the branches the owner asked for.
- **An append-only log file.** Efficient writes, but needs compaction and its own recovery logic. Two alternating slots are simpler and survive a torn write.
- **A single file with temp + rename only.** Atomic on most file systems, but the second slot plus checksums also covers file systems and sync tools where rename isn't atomic, and silent truncation.

## Consequences

**Positive**
- Crashes and accidental closes keep both the history and unsaved work.
- No edit is lost by undoing and editing again.
- History files are plain JSON and independent of command classes.

**Negative / costs**
- Each step clones and diffs the document. That's cheap for scenes of the current size; very large scenes may need incremental diffs.
- Undo and redo rebuild changed nodes in the Editor World instead of patching fields in place.
- Project-folder history adds files that projects will usually want to keep out of version control.

## Deprecates

- The in-memory `CommandStack` as the editor's history: the history tree replaces it behind the same interface.

## Open questions

- Sharing history between machines (it's tied to file contents, so it travels with the project folder but isn't merged).
- Pruning by age as well as count.

## References

- Neovim `:help undo-tree`, `:help undo-persistence`
- https://github.com/mbbill/undotree
