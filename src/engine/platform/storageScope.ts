// Player storage's scope and value encoding (ADR 0317, on 0024). One module answers "storage for this game":
// which place a backend reads and writes (an exported game's own app data, a project played in the editor, the
// editor's own data) and what a stored value is (JSON data or bytes, encoded once here, so the platform adapters
// below only keep text and bytes). Game code still uses the static `Storage` API; this module picks its backend.
import { getFileSystem, isTauri } from "./FileSystem";
import type { StorageBackend, StorageNamespace, StorageValue } from "./Storage";

/**
 * Whose storage a backend is.
 * - `game`: an exported game (the player, `node serve.mjs`, a desktop build): the app's own data folder under
 *   Tauri (its identifier names it), an IndexedDB database named after the game in a browser.
 * - `project`: a project played in the editor's Play mode, apart from every other project's and from the editor's;
 *   `id` names the project (its folder), `name` is for people reading the folder names.
 * - `editor`: data the editor itself keeps per user (history in per-user storage, user layouts), which game code
 *   never sees.
 */
export type StorageScope =
  | { readonly kind: "game"; readonly name: string }
  | { readonly kind: "project"; readonly id: string; readonly name: string }
  | { readonly kind: "editor" };

/** A stored value as the adapters keep it: JSON text, or bytes. */
export type StoredRecord = { readonly text: string } | { readonly bytes: Uint8Array };

/** What a platform adapter does: keep records per namespace and key. It never sees a game's values. */
export interface RecordStore {
  put(ns: StorageNamespace, key: string, record: StoredRecord): Promise<void>;
  get(ns: StorageNamespace, key: string): Promise<StoredRecord | undefined>;
  remove(ns: StorageNamespace, key: string): Promise<void>;
  keys(ns: StorageNamespace): Promise<string[]>;
}

const SUPPORTED =
  "a stored value is JSON data (null, booleans, finite numbers, strings, arrays and plain objects; object properties " +
  "that are undefined are left out) or bytes (an ArrayBuffer or a typed array, loaded back as an ArrayBuffer)";

/** Check that `value` is JSON data, naming the first part that isn't. */
function checkJson(value: unknown, path: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Storage can't save ${value} at ${path}: ${SUPPORTED}.`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`Storage can't save a ${typeof value} at ${path}: ${SUPPORTED}.`);
  if (seen.has(value)) throw new TypeError(`Storage can't save a value that contains itself (at ${path}).`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      if (item === undefined) throw new TypeError(`Storage can't save undefined at ${path}[${i}]: ${SUPPORTED}.`);
      checkJson(item, `${path}[${i}]`, seen);
    });
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`Storage can't save a ${value.constructor?.name ?? "non-plain object"} at ${path}: ${SUPPORTED}.`);
    }
    for (const [k, v] of Object.entries(value)) if (v !== undefined) checkJson(v, `${path}.${k}`, seen);
  }
  seen.delete(value);
}

/** The one encoding of a value (throws a TypeError for a value outside the contract). */
function encode(value: StorageValue): StoredRecord {
  if (value instanceof ArrayBuffer) return { bytes: new Uint8Array(value.slice(0)) };
  if (ArrayBuffer.isView(value)) return { bytes: new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)) };
  if (value === undefined) throw new TypeError(`Storage can't save undefined: ${SUPPORTED}. Delete the key instead.`);
  checkJson(value, "the value", new Set());
  return { text: JSON.stringify(value) };
}

function decode(record: StoredRecord): StorageValue {
  if ("bytes" in record) return record.bytes.buffer.slice(record.bytes.byteOffset, record.bytes.byteOffset + record.bytes.byteLength);
  return JSON.parse(record.text) as StorageValue;
}

/** A backend over a record store: every value goes through the one encoding on the way in and out. */
export class EncodedStorage implements StorageBackend {
  constructor(private readonly records: RecordStore) {}

  async save(ns: StorageNamespace, key: string, value: StorageValue): Promise<void> {
    await this.records.put(ns, key, encode(value));
  }

  async load(ns: StorageNamespace, key: string): Promise<StorageValue | undefined> {
    const record = await this.records.get(ns, key);
    return record === undefined ? undefined : decode(record);
  }

  delete(ns: StorageNamespace, key: string): Promise<void> {
    return this.records.remove(ns, key);
  }

  list(ns: StorageNamespace): Promise<string[]> {
    return this.records.keys(ns);
  }
}

/** Records in memory (tests, headless Engines, and a browser without IndexedDB). */
export class MemoryRecords implements RecordStore {
  private readonly data = new Map<string, StoredRecord>();
  async put(ns: StorageNamespace, key: string, record: StoredRecord): Promise<void> {
    this.data.set(`${ns}/${key}`, record);
  }
  async get(ns: StorageNamespace, key: string): Promise<StoredRecord | undefined> {
    return this.data.get(`${ns}/${key}`);
  }
  async remove(ns: StorageNamespace, key: string): Promise<void> {
    this.data.delete(`${ns}/${key}`);
  }
  async keys(ns: StorageNamespace): Promise<string[]> {
    return [...this.data.keys()].filter((k) => k.startsWith(`${ns}/`)).map((k) => k.slice(ns.length + 1));
  }
}

// --- where each scope lives ----------------------------------------------------------------------

/** FNV-1a, as eight hex digits: a stable short name for a project's folder path. */
function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

const slug = (name: string) => name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 40).toLowerCase() || "project";

/** A played project's place: its name for people, its folder's hash so same-named projects stay apart. */
const projectPlace = (scope: { id: string; name: string }) => `${slug(scope.name)}-${shortHash(scope.id)}`;

/** The folder (under the app data folder) or IndexedDB database each scope uses. */
function storagePlace(scope: StorageScope, platform: "tauri" | "browser"): string {
  if (platform === "tauri") {
    if (scope.kind === "game") return ""; // the app data folder itself, as since 0024: exported games keep their saves
    return scope.kind === "editor" ? "editor" : `play/${projectPlace(scope)}`;
  }
  if (scope.kind === "game") return `myco:${scope.name}`; // as since 0024
  return scope.kind === "editor" ? "myco-editor" : `myco-play:${projectPlace(scope)}`;
}

let editorDataMoved: Promise<void> | null = null;

/**
 * The storage for `scope` on this platform: files under the app data folder in Tauri, IndexedDB in a browser,
 * memory where there's neither (Node).
 */
export async function openStorage(scope: StorageScope): Promise<StorageBackend> {
  if (isTauri()) {
    const fs = await getFileSystem();
    const { appDataDir } = await import("@tauri-apps/api/path");
    const base = (await appDataDir()).replace(/[\\/]+$/, "");
    const place = storagePlace(scope, "tauri");
    const { TauriRecords, moveLegacyEditorData } = await import("./tauriRecords");
    if (scope.kind === "editor") await (editorDataMoved ??= moveLegacyEditorData(fs, base, `${base}/${place}`));
    return new EncodedStorage(new TauriRecords(fs, place ? `${base}/${place}` : base));
  }
  if (typeof indexedDB !== "undefined") {
    const { IndexedDbRecords } = await import("./indexedDbRecords");
    return new EncodedStorage(new IndexedDbRecords(storagePlace(scope, "browser")));
  }
  return new EncodedStorage(new MemoryRecords());
}
