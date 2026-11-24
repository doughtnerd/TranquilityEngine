import type { FileSystem } from "./FileSystem";
import type { StorageNamespace } from "./Storage";
import type { RecordStore, StoredRecord } from "./storageScope";

/** Windows device names, reserved whatever follows the first dot (`con.json`, `nul.tar.gz`). */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/;

/**
 * A record key as a file name (ADR 0384): URI-encoded, and then every character but `a-z 0-9 . _ -` percent-encoded
 * too (upper-case letters among them, so names that differ only in case on a case-insensitive disk are different
 * keys' files; `*` and the other characters Windows refuses), with a reserved device name's first letter encoded.
 * `decodeURIComponent` reads it back, as it reads the plain URI-encoded names earlier builds wrote.
 */
function fileNameOf(key: string): string {
  const uri = encodeURIComponent(key);
  let out = "";
  for (let i = 0; i < uri.length; i++) {
    const ch = uri[i];
    if (ch === "%") {
      out += uri.slice(i, i + 3);
      i += 2;
    } else if (/[a-z0-9._-]/.test(ch)) out += ch;
    else out += `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return RESERVED.test(out) ? `%${out.charCodeAt(0).toString(16).toUpperCase()}${out.slice(1)}` : out;
}

/** The key a record file's name holds and its kind, or undefined for a file that isn't a record (a stray file). */
function recordOf(name: string): { key: string; ext: "json" | "bin" } | undefined {
  const m = /^(.*)\.(json|bin)$/.exec(name);
  if (!m) return undefined;
  try {
    return { key: decodeURIComponent(m[1]), ext: m[2] as "json" | "bin" };
  } catch {
    return undefined; // not percent-encoding we wrote
  }
}

/**
 * Records as files (ADR 0024, 0317): `<root>/<namespace>/<key>.json` for JSON text, `.bin` for bytes, written
 * atomically by the FileSystem. Keys are encoded so any string makes a safe file name, distinct from every other
 * key's even on a case-insensitive disk (ADR 0384); files an earlier build named are renamed the first time a
 * namespace is used. `storageScope.ts` picks the root.
 */
export class TauriRecords implements RecordStore {
  private readonly ready = new Map<StorageNamespace, Promise<void>>();
  private readonly renamed = new Map<StorageNamespace, Promise<void>>();

  constructor(private readonly fs: FileSystem, readonly root: string) {}

  async put(ns: StorageNamespace, key: string, record: StoredRecord): Promise<void> {
    await this.renameLegacy(ns);
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
    await this.renameLegacy(ns);
    const json = this.file(ns, key, "json");
    if (await this.fs.exists(json)) return { text: await this.fs.readText(json) };
    const bin = this.file(ns, key, "bin");
    if (await this.fs.exists(bin)) return { bytes: await this.fs.readBinary(bin) };
    return undefined;
  }

  async remove(ns: StorageNamespace, key: string): Promise<void> {
    await this.renameLegacy(ns);
    await this.removeIfExists(this.file(ns, key, "json"));
    await this.removeIfExists(this.file(ns, key, "bin"));
  }

  async keys(ns: StorageNamespace): Promise<string[]> {
    const dir = this.dir(ns);
    if (!(await this.fs.exists(dir))) return [];
    await this.renameLegacy(ns);
    const keys = new Set<string>();
    for (const e of await this.fs.list(dir)) {
      const record = e.isDirectory ? undefined : recordOf(e.name);
      if (record) keys.add(record.key);
    }
    return [...keys];
  }

  private dir(ns: StorageNamespace): string {
    return `${this.root.replace(/[\\/]+$/, "")}/${ns}`;
  }

  private file(ns: StorageNamespace, key: string, ext: "json" | "bin"): string {
    return `${this.dir(ns)}/${fileNameOf(key)}.${ext}`;
  }

  /**
   * Once per namespace: rename the files an earlier build named with plain URI-encoding (`Slot1.json`, `a*b.json`)
   * to today's names, before anything is read or written (on a case-insensitive disk a new `slot1.json` would
   * otherwise land in `Slot1.json`). A file whose new name is taken is left as it is; failures are logged.
   */
  private renameLegacy(ns: StorageNamespace): Promise<void> {
    let p = this.renamed.get(ns);
    if (!p) {
      p = (async () => {
        const dir = this.dir(ns);
        try {
          if (!(await this.fs.exists(dir))) return;
          for (const e of await this.fs.list(dir)) {
            const record = e.isDirectory ? undefined : recordOf(e.name);
            if (!record) continue;
            const name = `${fileNameOf(record.key)}.${record.ext}`;
            if (name === e.name || (await this.fs.exists(`${dir}/${name}`))) continue;
            await this.fs.rename(`${dir}/${e.name}`, `${dir}/${name}`);
          }
        } catch (err) {
          console.warn(`[myco] couldn't rename the ${ns} files in ${dir} to their current names:`, err);
        }
      })();
      this.renamed.set(ns, p);
    }
    return p;
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
