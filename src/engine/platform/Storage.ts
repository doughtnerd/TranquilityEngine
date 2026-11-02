/**
 * Saves and settings (ADR 0024). Game code uses the static `Storage` API; the platform adapter
 * supplies the backend (IndexedDB in browsers, files under Tauri, memory in tests).
 */
export type StorageNamespace = "saves" | "settings" | "cache";
export type StorageValue = unknown; // JSON-serializable data or ArrayBuffer

export interface StorageBackend {
  save(namespace: StorageNamespace, key: string, value: StorageValue): Promise<void>;
  load(namespace: StorageNamespace, key: string): Promise<StorageValue | undefined>;
  delete(namespace: StorageNamespace, key: string): Promise<void>;
  list(namespace: StorageNamespace): Promise<string[]>;
}

export class MemoryStorage implements StorageBackend {
  private data = new Map<string, StorageValue>();
  async save(ns: StorageNamespace, key: string, value: StorageValue): Promise<void> {
    this.data.set(`${ns}/${key}`, structuredClone(value));
  }
  async load(ns: StorageNamespace, key: string): Promise<StorageValue | undefined> {
    const v = this.data.get(`${ns}/${key}`);
    return v === undefined ? undefined : structuredClone(v);
  }
  async delete(ns: StorageNamespace, key: string): Promise<void> {
    this.data.delete(`${ns}/${key}`);
  }
  async list(ns: StorageNamespace): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(`${ns}/`)).map((k) => k.slice(ns.length + 1));
  }
}

/**
 * One backend per process, shared by every World of the Engine (ADR 0032): saves and settings
 * belong to the player, not to a World, so nothing here reads the current World. Worlds that need
 * separate saves (a local server and a client in one process) use different keys or namespaces.
 */
let backend: StorageBackend = new MemoryStorage();

export class Storage {
  /** @internal Set by the Engine from the platform adapter. */
  static use(b: StorageBackend): void {
    backend = b;
  }

  static save(key: string, value: StorageValue, namespace: StorageNamespace = "saves"): Promise<void> {
    return backend.save(namespace, key, value);
  }

  static async load<T = unknown>(key: string, namespace: StorageNamespace = "saves"): Promise<T | undefined> {
    return (await backend.load(namespace, key)) as T | undefined;
  }

  static delete(key: string, namespace: StorageNamespace = "saves"): Promise<void> {
    return backend.delete(namespace, key);
  }

  static list(namespace: StorageNamespace = "saves"): Promise<string[]> {
    return backend.list(namespace);
  }
}
