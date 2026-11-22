import type { FileSystem } from "./FileSystem";
import type { StorageNamespace } from "./Storage";
import type { RecordStore, StoredRecord } from "./storageScope";

/**
 * Records as files (ADR 0024, 0317): `<root>/<namespace>/<key>.json` for JSON text, `.bin` for bytes, written
 * atomically by the FileSystem. Keys are URI-encoded so any string makes a safe file name. `storageScope.ts`
 * picks the root.
 */
export class TauriRecords implements RecordStore {
  private readonly ready = new Map<StorageNamespace, Promise<void>>();

  constructor(private readonly fs: FileSystem, private readonly root: string) {}

  async put(ns: StorageNamespace, key: string, record: StoredRecord): Promise<void> {
    await this.ensureDir(ns);
    if ("bytes" in record) {
      await this.fs.writeBinary(this.file(ns, key, "bin"), record.bytes);
      await this.removeIfExists(this.file(ns, key, "json"));
    } else {
      await this.fs.writeText(this.file(ns, key, "json"), record.text);
      await this.removeIfExists(this.file(ns, key, "bin"));
    }
  }

  async get(ns: StorageNamespace, key: string): Promise<StoredRecord | undefined> {
    const json = this.file(ns, key, "json");
    if (await this.fs.exists(json)) return { text: await this.fs.readText(json) };
    const bin = this.file(ns, key, "bin");
    if (await this.fs.exists(bin)) return { bytes: await this.fs.readBinary(bin) };
    return undefined;
  }

  async remove(ns: StorageNamespace, key: string): Promise<void> {
    await this.removeIfExists(this.file(ns, key, "json"));
    await this.removeIfExists(this.file(ns, key, "bin"));
  }

  async keys(ns: StorageNamespace): Promise<string[]> {
    const dir = this.dir(ns);
    if (!(await this.fs.exists(dir))) return [];
    const keys = new Set<string>();
    for (const e of await this.fs.list(dir)) {
      const m = !e.isDirectory && /^(.*)\.(json|bin)$/.exec(e.name);
      if (m) keys.add(decodeURIComponent(m[1]));
    }
    return [...keys];
  }

  private dir(ns: StorageNamespace): string {
    return `${this.root.replace(/[\\/]+$/, "")}/${ns}`;
  }

  private file(ns: StorageNamespace, key: string, ext: "json" | "bin"): string {
    return `${this.dir(ns)}/${encodeURIComponent(key)}.${ext}`;
  }

  private ensureDir(ns: StorageNamespace): Promise<void> {
    let p = this.ready.get(ns);
    if (!p) {
      p = this.fs.mkdir(this.dir(ns));
      this.ready.set(ns, p);
      p.catch(() => this.ready.delete(ns));
    }
    return p;
  }

  private async removeIfExists(path: string): Promise<void> {
    if (await this.fs.exists(path)) await this.fs.remove(path);
  }
}

/** The editor's own files that lived beside Play's saves in the app data folder before ADR 0317. */
const LEGACY_EDITOR_FILES: readonly [StorageNamespace, RegExp][] = [
  ["cache", /^(asset-)?history-.*\.(json|bin)$/],
  ["settings", /^layouts%2F.*\.(json|bin)$/],
];

/**
 * Move the editor's per-user history and user layouts from the app data folder's root into the editor's own
 * folder (`to`), once: before ADR 0317 they shared the root (and its `cache` namespace) with every project's Play
 * saves. A file already at the destination is left where it is. Failures are logged, not thrown: the editor still
 * opens, with that file missing.
 */
export async function moveLegacyEditorData(fs: FileSystem, base: string, to: string): Promise<void> {
  for (const [ns, pattern] of LEGACY_EDITOR_FILES) {
    const from = `${base}/${ns}`;
    try {
      if (!(await fs.exists(from))) continue;
      const files = (await fs.list(from)).filter((e) => !e.isDirectory && pattern.test(e.name));
      if (files.length === 0) continue;
      await fs.mkdir(`${to}/${ns}`);
      for (const f of files) {
        const target = `${to}/${ns}/${f.name}`;
        if (!(await fs.exists(target))) await fs.rename(`${from}/${f.name}`, target);
      }
    } catch (err) {
      console.warn(`[myco] couldn't move the editor's ${ns} files to ${to}:`, err);
    }
  }
}
