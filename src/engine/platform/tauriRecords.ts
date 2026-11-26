import { sha256Hex } from "../localisation/textHash";
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

/** The longest encoded name kept whole (before the extension): longer ones are shortened (ADR 0387). */
const NAME_MAX = 100;
/** How much of a shortened name's encoding it keeps, so the folder still shows what it is. */
const PREFIX_MAX = 64;
/** A shortened name: the encoding's start, `~` (which the encoding never leaves bare), 32 hex digits of the key's SHA-256. */
const SHORTENED = /^((?:[a-z0-9._-]|%[0-9A-F]{2})*)~([0-9a-f]{32})\.(json|bin)$/;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The 32 hex digits of a key's SHA-256 a shortened name ends with. */
const keyHash = (key: string): string => sha256Hex(utf8.encode(key)).slice(0, 32);

/**
 * A key's file name without its extension (ADR 0384), and whether it was shortened (ADR 0387): an encoding longer
 * than {@link NAME_MAX} keeps its first {@link PREFIX_MAX} characters (never splitting an escape), then `~` and a
 * hash of the full key. A shortened file holds its key on its first line, so `keys()` can give it back.
 */
function nameOf(key: string): { stem: string; shortened: boolean } {
  const full = fileNameOf(key);
  if (full.length <= NAME_MAX) return { stem: full, shortened: false };
  let cut = PREFIX_MAX;
  const escape = full.lastIndexOf("%", cut - 1);
  if (escape > cut - 3) cut = escape;
  return { stem: `${full.slice(0, cut)}~${keyHash(key)}`, shortened: true };
}

/** A shortened file's record: its key as a JSON string on the first line, then the record (ADR 0387). */
function wrap(key: string, record: StoredRecord): StoredRecord {
  const head = `${JSON.stringify(key)}\n`;
  if (!("bytes" in record)) return { text: head + record.text };
  const h = utf8.encode(head);
  const bytes = new Uint8Array(h.length + record.bytes.length);
  bytes.set(h);
  bytes.set(record.bytes, h.length);
  return { bytes };
}

/** A shortened file's key and record, or undefined when its first line isn't a key (not a file we shortened). */
function unwrap(stored: StoredRecord): { key: string; record: StoredRecord } | undefined {
  try {
    if ("bytes" in stored) {
      const end = stored.bytes.indexOf(10); // JSON never writes a bare newline, nor UTF-8 a 0x0A inside a character
      if (end < 0) return undefined;
      const key: unknown = JSON.parse(fromUtf8.decode(stored.bytes.subarray(0, end)));
      return typeof key === "string" ? { key, record: { bytes: stored.bytes.slice(end + 1) } } : undefined;
    }
    const end = stored.text.indexOf("\n");
    if (end < 0) return undefined;
    const key: unknown = JSON.parse(stored.text.slice(0, end));
    return typeof key === "string" ? { key, record: { text: stored.text.slice(end + 1) } } : undefined;
  } catch {
    return undefined;
  }
}

/** A record file in a namespace folder: its key, kind, and whether its name was shortened (its key read from inside). */
interface RecordFile {
  key: string;
  ext: "json" | "bin";
  shortened: boolean;
}

/** The key a whole (not shortened) record file's name holds and its kind, or undefined for a file that isn't a record (a stray file). */
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
 * key's even on a case-insensitive disk (ADR 0384), and a long one is shortened to a prefix and a hash of the key,
 * which the file then holds on its first line (ADR 0387); files an earlier build named are renamed the first time
 * a namespace is used. `storageScope.ts` picks the root.
 */
export class TauriRecords implements RecordStore {
  private readonly ready = new Map<StorageNamespace, Promise<void>>();
  private readonly renamed = new Map<StorageNamespace, Promise<void>>();

  constructor(private readonly fs: FileSystem, readonly root: string) {}

  async put(ns: StorageNamespace, key: string, record: StoredRecord): Promise<void> {
    await this.renameLegacy(ns);
    await this.ensureDir(ns);
    const { stem, shortened } = nameOf(key);
    await this.write(`${this.dir(ns)}/${stem}`, shortened ? wrap(key, record) : record);
  }

  async get(ns: StorageNamespace, key: string): Promise<StoredRecord | undefined> {
    await this.renameLegacy(ns);
    const { stem, shortened } = nameOf(key);
    const stored = await this.read(`${this.dir(ns)}/${stem}`);
    if (!stored || !shortened) return stored;
    const inside = unwrap(stored);
    return inside?.key === key ? inside.record : undefined; // another key's record under this name: not this key's
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
      const record = e.isDirectory ? undefined : await this.recordFile(dir, e.name);
      if (record) keys.add(record.key);
    }
    return [...keys];
  }

  private dir(ns: StorageNamespace): string {
    return `${this.root.replace(/[\\/]+$/, "")}/${ns}`;
  }

  private file(ns: StorageNamespace, key: string, ext: "json" | "bin"): string {
    return `${this.dir(ns)}/${nameOf(key).stem}.${ext}`;
  }

  /** Write a record as `<base>.json` or `<base>.bin`, removing the other. */
  private async write(base: string, record: StoredRecord): Promise<void> {
    if ("bytes" in record) {
      await this.fs.writeBinary(`${base}.bin`, record.bytes);
      await this.removeIfExists(`${base}.json`);
    } else {
      await this.fs.writeText(`${base}.json`, record.text);
      await this.removeIfExists(`${base}.bin`);
    }
  }

  /** The record in `<base>.json` or `<base>.bin`, if either is there. */
  private async read(base: string): Promise<StoredRecord | undefined> {
    if (await this.fs.exists(`${base}.json`)) return { text: await this.fs.readText(`${base}.json`) };
    if (await this.fs.exists(`${base}.bin`)) return { bytes: await this.fs.readBinary(`${base}.bin`) };
    return undefined;
  }

  /**
   * The record a file in `dir` holds, or undefined for a stray file. A shortened name's key is read from inside the
   * file and must hash to the name; a name that only looks shortened is read as a whole one (an earlier build's
   * plain URI-encoding left `~` bare).
   */
  private async recordFile(dir: string, name: string): Promise<RecordFile | undefined> {
    const short = SHORTENED.exec(name);
    if (short) {
      const ext = short[3] as "json" | "bin";
      const path = `${dir}/${name}`;
      try {
        const inside = unwrap(ext === "json" ? { text: await this.fs.readText(path) } : { bytes: await this.fs.readBinary(path) });
        if (inside && keyHash(inside.key) === short[2]) return { key: inside.key, ext, shortened: true };
      } catch (err) {
        console.warn(`[myco] couldn't read the save file ${path}:`, err);
        return undefined;
      }
    }
    const whole = recordOf(name);
    return whole && { ...whole, shortened: false };
  }

  /**
   * Once per namespace: rename the files an earlier build named with plain URI-encoding (`Slot1.json`, `a*b.json`)
   * to today's names, before anything is read or written (on a case-insensitive disk a new `slot1.json` would
   * otherwise land in `Slot1.json`). A long key's file named in full moves to its shortened name with its key
   * written inside (ADR 0387). A file whose new name is taken is left as it is; failures are logged.
   */
  private renameLegacy(ns: StorageNamespace): Promise<void> {
    let p = this.renamed.get(ns);
    if (!p) {
      p = (async () => {
        const dir = this.dir(ns);
        try {
          if (!(await this.fs.exists(dir))) return;
          for (const e of await this.fs.list(dir)) {
            const record = e.isDirectory ? undefined : await this.recordFile(dir, e.name);
            if (!record) continue;
            const { stem, shortened } = nameOf(record.key);
            const name = `${stem}.${record.ext}`;
            if (name === e.name || (await this.fs.exists(`${dir}/${name}`))) continue;
            const from = `${dir}/${e.name}`;
            if (shortened && !record.shortened) {
              const whole: StoredRecord = record.ext === "json" ? { text: await this.fs.readText(from) } : { bytes: await this.fs.readBinary(from) };
              await this.write(`${dir}/${stem}`, wrap(record.key, whole));
              await this.fs.remove(from);
            } else await this.fs.rename(from, `${dir}/${name}`);
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
