import { CommandGroup, type Change, type Command } from "./commands";
import type { SceneDocument } from "./SceneDocument";

/** What happened, passed to `CommandStack` listeners. */
export interface StackEvent {
  readonly reason: "execute" | "group" | "undo" | "redo" | "save";
  readonly label: string;
  readonly changes: readonly Change[];
}

export type StackListener = (event: StackEvent) => void;

interface Entry {
  readonly id: number;
  readonly command: Command;
}

/**
 * Undo/redo over a SceneDocument (ADR 0026). Every edit goes through `execute`. Wrap a gesture
 * (e.g. a gizmo drag) in `beginGroup`/`endGroup` to make it one undo step. `dirty` says whether
 * the document differs from the last `markSaved()`. Listeners hear every change, including each
 * command inside an open group, so the World and UI stay live during a drag.
 */
export class CommandStack {
  private done: Entry[] = [];
  private undone: Entry[] = [];
  private group: CommandGroup | null = null;
  private groupDepth = 0;
  private nextId = 1;
  private savedId = 0;
  private listeners = new Set<StackListener>();

  constructor(readonly doc: SceneDocument) {}

  /** Listen for changes. Returns an unsubscribe function. */
  subscribe(listener: StackListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply a command and record it. Clears the redo history. */
  execute(command: Command): void {
    const changes = command.apply(this.doc);
    if (this.group) this.group.commands.push(command);
    else this.push(command);
    this.undone = [];
    this.emit({ reason: "execute", label: command.label, changes });
  }

  /** Start a group: commands executed until the matching `endGroup` undo as one step. Groups nest. */
  beginGroup(label: string): void {
    if (this.groupDepth++ === 0) this.group = new CommandGroup(label);
  }

  /** Close the group opened by `beginGroup`. An empty group records nothing. */
  endGroup(): void {
    if (this.groupDepth === 0) throw new Error("endGroup() without beginGroup().");
    if (--this.groupDepth > 0) return;
    const group = this.group!;
    this.group = null;
    if (group.commands.length) {
      this.push(group);
      // Undo/redo availability and dirtiness change only now; the group's edits were already emitted.
      this.emit({ reason: "group", label: group.label, changes: [] });
    }
  }

  get canUndo(): boolean {
    return this.done.length > 0 && !this.group;
  }

  get canRedo(): boolean {
    return this.undone.length > 0 && !this.group;
  }

  /** Label of the step `undo()` would revert, or null. */
  get undoLabel(): string | null {
    return this.done.at(-1)?.command.label ?? null;
  }

  get redoLabel(): string | null {
    return this.undone.at(-1)?.command.label ?? null;
  }

  /** Revert the last step. Returns false if there's nothing to undo (or a group is open). */
  undo(): boolean {
    if (!this.canUndo) return false;
    const entry = this.done.pop()!;
    const changes = entry.command.undo(this.doc);
    this.undone.push(entry);
    this.emit({ reason: "undo", label: entry.command.label, changes });
    return true;
  }

  /** Re-apply the last undone step. */
  redo(): boolean {
    if (!this.canRedo) return false;
    const entry = this.undone.pop()!;
    const changes = entry.command.apply(this.doc);
    this.done.push(entry);
    this.emit({ reason: "redo", label: entry.command.label, changes });
    return true;
  }

  /** True if the document differs from the last save point. */
  get dirty(): boolean {
    return (this.done.at(-1)?.id ?? 0) !== this.savedId;
  }

  /** Record the current state as saved (call after writing the file). */
  markSaved(): void {
    this.savedId = this.done.at(-1)?.id ?? 0;
    this.emit({ reason: "save", label: "Save", changes: [] });
  }

  /** Forget all history (e.g. after opening another file). The current state counts as saved. */
  clear(): void {
    this.done = [];
    this.undone = [];
    this.group = null;
    this.groupDepth = 0;
    this.savedId = 0;
  }

  private push(command: Command): void {
    this.done.push({ id: this.nextId++, command });
  }

  private emit(event: StackEvent): void {
    for (const l of [...this.listeners]) l(event);
  }
}
