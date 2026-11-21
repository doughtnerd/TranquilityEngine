/**
 * Saves and settings (ADR 0024). Game code uses the static `Storage` API; `storageScope.ts` picks the backend for
 * the game (IndexedDB in browsers, files under Tauri, memory in tests) and owns the value contract (ADR 0317).
 */
import { EncodedStorage, MemoryRecords } from "./storageScope";

export type StorageNamespace = "saves" | "settings" | "cache";
/**
 * JSON data (null, booleans, finite numbers, strings, arrays, plain objects) or bytes (an ArrayBuffer or typed
 * array; loaded back as an ArrayBuffer). The built-in backends reject anything else when saving (ADR 0317).
 */
export type StorageValue = unknown;

export interface StorageBackend {
  save(namespace: StorageNamespace, key: string, value: StorageValue): Promise<void>;
  load(namespace: StorageNamespace, key: string): Promise<StorageValue | undefined>;
  delete(namespace: StorageNamespace, key: string): Promise<void>;
  list(namespace: StorageNamespace): Promise<string[]>;
}

/** Storage in memory (tests, headless Engines): the same value contract as every built-in backend (ADR 0317). */
export class MemoryStorage extends EncodedStorage {
  constructor() {
    super(new MemoryRecords());
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
