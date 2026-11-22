import type { StorageNamespace } from "./Storage";
import type { RecordStore, StoredRecord } from "./storageScope";

/** How a record is kept in an object store (a value without the marker was written before ADR 0317). */
interface KeptRecord {
  myco: "record@1";
  text?: string;
  bytes?: Uint8Array;
}

const isKept = (v: unknown): v is KeptRecord => typeof v === "object" && v !== null && (v as KeptRecord).myco === "record@1";

/**
 * A value an exported game saved before ADR 0317, stored as itself (structured clone): read as the encoding
 * would have written it, so an exported web game's saves still load. Bytes stay bytes; anything else goes through
 * JSON, as the desktop build always stored it.
 */
function legacy(value: unknown): StoredRecord | undefined {
  if (value === undefined) return undefined;
  if (value instanceof ArrayBuffer) return { bytes: new Uint8Array(value) };
  if (ArrayBuffer.isView(value)) return { bytes: new Uint8Array(value.buffer, value.byteOffset, value.byteLength) };
  const text = JSON.stringify(value);
  return text === undefined ? undefined : { text };
}

/** Records in IndexedDB (ADR 0024, 0317): one database per storage scope, one object store per namespace. */
export class IndexedDbRecords implements RecordStore {
  private db: Promise<IDBDatabase> | null = null;

  constructor(private readonly name: string) {}

  private open(): Promise<IDBDatabase> {
    return (this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
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

  async put(ns: StorageNamespace, key: string, record: StoredRecord): Promise<void> {
    const kept: KeptRecord = "bytes" in record ? { myco: "record@1", bytes: record.bytes } : { myco: "record@1", text: record.text };
    await this.request(ns, "readwrite", (s) => s.put(kept, key));
  }

  async get(ns: StorageNamespace, key: string): Promise<StoredRecord | undefined> {
    const v: unknown = await this.request(ns, "readonly", (s) => s.get(key));
    if (!isKept(v)) return legacy(v);
    return v.bytes ? { bytes: v.bytes } : { text: v.text ?? "null" };
  }

  async remove(ns: StorageNamespace, key: string): Promise<void> {
    await this.request(ns, "readwrite", (s) => s.delete(key));
  }

  async keys(ns: StorageNamespace): Promise<string[]> {
    const keys = await this.request(ns, "readonly", (s) => s.getAllKeys());
    return keys.map(String);
  }
}
