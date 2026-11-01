// Crash-safe storage for edit history files (ADR 0027). Each scene's history lives in two slots,
// `a` and `b`, written alternately. Every slot carries a generation number and a checksum of its
// content; loading takes the newest slot that parses and checks out. A failure mid-write can only
// damage the slot being written, so the other still holds the previous generation. On top of
// that, project files go through the platform's temp-file-then-rename write.
import type { FileSystem } from "../engine/platform/FileSystem";
import type { StorageBackend } from "../engine/platform/Storage";
import { hashText, type HistoryFile } from "./document";
import { joinPath } from "./projects";

/** Where slot texts are read and written. */
export interface SlotBackend {
  /** A short description for messages, e.g. the folder. */
  readonly where: string;
  read(slot: "a" | "b"): Promise<string | null>;
  write(slot: "a" | "b", text: string): Promise<void>;
}

interface Envelope {
  format: "tranquility.history-slot@1";
  generation: number;
  /** `hashText` of `JSON.stringify(history)`. */
  checksum: string;
  history: HistoryFile;
}

/** Parse and verify a slot; null if it's missing, torn or tampered with. */
export function readSlot(text: string | null): Envelope | null {
  if (!text) return null;
  try {
    const e = JSON.parse(text) as Envelope;
    if (e?.format !== "tranquility.history-slot@1" || typeof e.generation !== "number" || !e.history) return null;
    return hashText(JSON.stringify(e.history)) === e.checksum ? e : null;
  } catch {
    return null;
  }
}

export class HistoryStore {
  private generation = 0;

  constructor(readonly backend: SlotBackend) {}

  /** The newest valid history, or null if there's none (or neither slot survived). */
  async load(): Promise<HistoryFile | null> {
    const [a, b] = await Promise.all([this.read("a"), this.read("b")]);
    const best = [a, b].filter((e): e is Envelope => e !== null).sort((x, y) => y.generation - x.generation)[0];
    this.generation = best?.generation ?? Math.max(a?.generation ?? 0, b?.generation ?? 0);
    return best?.history ?? null;
  }

  /** Write `history` as the next generation, into the slot that doesn't hold the current one. */
  async save(history: HistoryFile): Promise<void> {
    const generation = this.generation + 1;
    const envelope: Envelope = { format: "tranquility.history-slot@1", generation, checksum: hashText(JSON.stringify(history)), history };
    await this.backend.write(generation % 2 === 1 ? "a" : "b", JSON.stringify(envelope));
    this.generation = generation;
  }

  private async read(slot: "a" | "b"): Promise<Envelope | null> {
    try {
      return readSlot(await this.backend.read(slot));
    } catch {
      return null;
    }
  }
}

/** History files in the project folder: `.tranquility/history/<scene path>.history.<slot>.json`. */
export function projectSlots(fs: FileSystem, root: string, scene: string): SlotBackend {
  const folder = scene.includes("/") ? scene.slice(0, scene.lastIndexOf("/")) : "";
  const dir = joinPath(root, `.tranquility/history${folder ? `/${folder}` : ""}`);
  const file = (slot: "a" | "b") => joinPath(root, `.tranquility/history/${scene}.history.${slot}.json`);
  return {
    where: joinPath(root, ".tranquility/history"),
    async read(slot) {
      return (await fs.exists(file(slot))) ? fs.readText(file(slot)) : null;
    },
    async write(slot, text) {
      await fs.mkdir(dir);
      await fs.writeText(file(slot), text);
    },
  };
}

/** History in per-user storage, keyed by project and scene (app data under Tauri, IndexedDB in browsers). */
export function userSlots(storage: StorageBackend, projectKey: string, scene: string): SlotBackend {
  const slug = scene.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const key = (slot: "a" | "b") => `history-${hashText(`${projectKey}|${scene}`)}-${slug}.${slot}`;
  return {
    where: "per-user storage",
    async read(slot) {
      const v = await storage.load("cache", key(slot));
      return typeof v === "string" ? v : null;
    },
    async write(slot, text) {
      await storage.save("cache", key(slot), text);
    },
  };
}
