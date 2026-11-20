// A small linear undo history of states with labels: what a project section (ADR 0151) keeps its draft in. Generic;
// the scene's CommandStack is per scene document and holds commands, not states.

/** A small linear undo history of panel states (the scene's CommandStack is per scene document). */
export class EditHistory<T> {
  private past: { label: string; state: T }[] = [];
  private future: { label: string; state: T }[] = [];

  constructor(public current: T) {}

  /** Record an edit that produced `next`; clears redo. */
  push(label: string, next: T): void {
    this.past.push({ label, state: this.current });
    this.future = [];
    this.current = next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoLabel(): string | null {
    return this.past.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.future.at(-1)?.label ?? null;
  }

  /** Go back one edit; returns the new current state, or null if there's nothing to undo. */
  undo(): T | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push({ label: entry.label, state: this.current });
    this.current = entry.state;
    return this.current;
  }

  redo(): T | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.past.push({ label: entry.label, state: this.current });
    this.current = entry.state;
    return this.current;
  }

  /** Rewrite every state, past and future too, keeping the labels (a project section adopting a key, ADR 0151). */
  map(fn: (state: T) => T): void {
    this.current = fn(this.current);
    for (const list of [this.past, this.future]) for (const entry of list) entry.state = fn(entry.state);
  }
}
