// A contribution point's registry (ADR 0133, 0134): plugins register entries by id; every
// registration can be undone, so disabling or reloading a plugin removes what it added.
import { signal, type ReadonlySignal } from "@preact/signals";

export interface Registry<T extends { readonly id: string }> {
  /** Add an entry. Throws if the id is taken. Returns a function that removes it again. */
  register(entry: T): () => void;
  get(id: string): T | undefined;
  /** Every entry, in registration order. */
  list(): readonly T[];
  /** Bumped on every register and unregister: read it inside a component or effect to follow changes. */
  readonly version: ReadonlySignal<number>;
}

export function createRegistry<T extends { readonly id: string }>(what: string): Registry<T> {
  const entries = new Map<string, T>();
  const version = signal(0);
  return {
    register(entry) {
      if (entries.has(entry.id)) throw new Error(`${what} "${entry.id}" is already registered.`);
      entries.set(entry.id, entry);
      version.value++;
      return () => {
        if (entries.get(entry.id) !== entry) return;
        entries.delete(entry.id);
        version.value++;
      };
    },
    get: (id) => entries.get(id),
    list: () => [...entries.values()],
    version,
  };
}
