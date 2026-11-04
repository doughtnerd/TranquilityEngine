// Where thumbnails are kept (ADR 0061): `.myco/thumbnails/` in a writable project folder, or memory
// for read-only projects (the samples, a browser without a writable folder).
import type { FileSystem } from "../../engine/platform/FileSystem";
import { joinPath } from "../projectPaths";

/** A cached thumbnail file: an image (`webp`, or `png` where the browser can't encode WebP) or waveform peaks. */
export type ThumbnailExt = "webp" | "png" | "peaks.json";

export interface ThumbnailStore {
  /** Where the files go (for messages), or null for memory. */
  readonly where: string | null;
  read(key: string, ext: ThumbnailExt): Promise<Uint8Array | null>;
  write(key: string, ext: ThumbnailExt, bytes: Uint8Array): Promise<void>;
  /** Every file name in the store. */
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}

export const THUMBNAIL_FOLDER = ".myco/thumbnails";

/** The project folder's `.myco/thumbnails/`. */
export function projectStore(fs: FileSystem, root: string): ThumbnailStore {
  const dir = joinPath(root, THUMBNAIL_FOLDER);
  const file = (name: string) => joinPath(dir, name);
  let made = false;
  return {
    where: dir,
    async read(key, ext) {
      const path = file(`${key}.${ext}`);
      try {
        return (await fs.exists(path)) ? await fs.readBinary(path) : null;
      } catch {
        return null;
      }
    },
    async write(key, ext, bytes) {
      if (!made) {
        await fs.mkdir(dir);
        made = true;
      }
      await fs.writeBinary(file(`${key}.${ext}`), bytes);
    },
    async list() {
      try {
        return (await fs.exists(dir)) ? (await fs.list(dir)).filter((e) => !e.isDirectory).map((e) => e.name) : [];
      } catch {
        return [];
      }
    },
    async remove(name) {
      await fs.remove(file(name));
    },
  };
}

/** Thumbnails kept for this session only. */
export function memoryStore(): ThumbnailStore & { readonly files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    where: null,
    files,
    async read(key, ext) {
      return files.get(`${key}.${ext}`) ?? null;
    },
    async write(key, ext, bytes) {
      files.set(`${key}.${ext}`, bytes);
    },
    async list() {
      return [...files.keys()];
    },
    async remove(name) {
      files.delete(name);
    },
  };
}
