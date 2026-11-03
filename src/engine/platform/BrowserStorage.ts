import type { StorageBackend, StorageNamespace, StorageValue } from "./Storage";

/** Browser storage backend on IndexedDB (ADR 0024). One database per game. */
export class BrowserStorage implements StorageBackend {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly gameName: string) {}

  private open(): Promise<IDBDatabase> {
    return (this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(`myco:${this.gameName}`, 1);
      req.onupgradeneeded = () => {
        for (const ns of ["saves", "settings", "cache"]) req.result.createObjectStore(ns);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  private async request<T>(ns: StorageNamespace, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const req = op(db.transaction(ns, mode).objectStore(ns));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async save(ns: StorageNamespace, key: string, value: StorageValue): Promise<void> {
    await this.request(ns, "readwrite", (s) => s.put(value, key));
  }

  load(ns: StorageNamespace, key: string): Promise<StorageValue | undefined> {
    return this.request(ns, "readonly", (s) => s.get(key));
  }

  async delete(ns: StorageNamespace, key: string): Promise<void> {
    await this.request(ns, "readwrite", (s) => s.delete(key));
  }

  async list(ns: StorageNamespace): Promise<string[]> {
    const keys = await this.request(ns, "readonly", (s) => s.getAllKeys());
    return keys.map(String);
  }
}
