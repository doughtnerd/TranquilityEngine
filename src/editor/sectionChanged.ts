// The section-changed registry behind `editor.project.onSectionChanged` (ADR 0147's 2026-11-13 amendment, ADR 0172 §1.8).
// A leaf module: `projectSection.ts` fires it and `sdk/project.ts` exposes it, and it imports nothing (no plugin, no shell
// state), so neither import creates a cycle.

/** One change to a top-level `project.json` key, as the section's valid draft moved. */
export interface SectionChange {
  /** The top-level `project.json` key: "audio". */
  readonly key: string;
  /** The key's value before and after, as the drafts hold them; the undo history preserves their object identity. */
  readonly before: unknown;
  readonly after: unknown;
  /** What moved the draft. ("external", an outside edit, is reserved: nothing fires it yet.) */
  readonly cause: "edit" | "undo" | "redo" | "external";
}

export type SectionListener = (change: SectionChange) => void;

const listeners = new Map<string, Set<SectionListener>>();

/** Listen for valid changes to `key`; returns the unsubscribe. */
export function onSectionChanged(key: string, listener: SectionListener): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  // A fresh wrapper, so subscribing the same function twice gives two independent subscriptions.
  const entry: SectionListener = (change) => listener(change);
  set.add(entry);
  return () => {
    set!.delete(entry);
    if (set!.size === 0 && listeners.get(key) === set) listeners.delete(key);
  };
}

/** @internal Called by project sections, synchronously, for a valid draft whose `key` value differs. A throwing listener doesn't stop the rest or the edit. */
export function emitSectionChanged(change: SectionChange): void {
  const set = listeners.get(change.key);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(change);
    } catch (err) {
      console.error(`onSectionChanged("${change.key}") listener threw`, err);
    }
  }
}
