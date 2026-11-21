// A contribution point's registry (ADR 0133, 0134): plugins register entries by id; every
// registration can be undone, so disabling or reloading a plugin removes what it added. The registry
// also records which plugin registered each entry (ADR 0284), for every point alike.
import { signal, type ReadonlySignal } from "@preact/signals";

/** The plugin an entry came from (ADR 0174, 0284). */
export interface ContributionOwner {
  /** The plugin's name, e.g. "myco.sky". */
  readonly plugin: string;
  /** The plugin's title, e.g. "Sky". */
  readonly pluginTitle: string;
}

export interface Registry<T extends { readonly id: string }> {
  /** Add an entry, from `owner` when a plugin adds it. Throws if the id is taken. Returns a function that removes it again. */
  register(entry: T, owner?: ContributionOwner): () => void;
  get(id: string): T | undefined;
  /** Every entry, in registration order. */
  list(): readonly T[];
  /**
   * The plugin that registered `id`: the entry's now, or, once it's removed, the last one's this session, so a saved
   * layout can still name the plugin to turn back on. Undefined for an entry the editor itself registered.
   */
  ownerOf(id: string): ContributionOwner | undefined;
  /** The ids `plugin` registered this session, whether or not they're registered now. */
  idsOf(plugin: string): string[];
  /** Bumped on every register and unregister: read it inside a component or effect to follow changes. */
  readonly version: ReadonlySignal<number>;
}

export function createRegistry<T extends { readonly id: string }>(what: string): Registry<T> {
  const entries = new Map<string, T>();
  const owners = new Map<string, ContributionOwner>();
  const version = signal(0);
  return {
    register(entry, owner) {
      if (entries.has(entry.id)) throw new Error(`${what} "${entry.id}" is already registered.`);
      // The owner before the version bump, so whatever the change triggers already sees it.
      if (owner) owners.set(entry.id, owner);
      else owners.delete(entry.id);
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
    ownerOf: (id) => owners.get(id),
    idsOf: (plugin) => [...owners].filter(([, o]) => o.plugin === plugin).map(([id]) => id),
    version,
  };
}
