// The Dialogue screen's state (ADR 0340 §1, §9, 0341 §7): the per-user preview language (`myco.audio.previewLanguage`,
// local storage; the header chip sets it for every screen), the tab, the Lines query and selection, the audition
// playing, whether the editor holds the project lock, the batch import and script import in progress, and the Events
// tab's selection, search, bench values, seed, memory and roll.
import { signal } from "@preact/signals";
import { persisted } from "../../../editor/preferences";
import type { AudioHandle } from "../../../plugins/audio/runtime/backend";
import type { BenchMemory, RollBar } from "./events/testBench";
import { EMPTY_MEMORY } from "./events/testBench";
import { ALL_LINES, type LinesQuery } from "./linesModel";
import type { ScriptDiff } from "./scriptCsv";

/** Per user (0340 §1): the language the Studio's auditions and previews start in; null: the project's start language. */
export const previewLanguage = persisted<string | null>("myco.audio.previewLanguage", null);

export type DialogueTab = "lines" | "languages" | "report" | "events";
export const dialogueTab = persisted<DialogueTab>("myco.studio.dialogue.tab", "lines");

export const linesQuery = signal<LinesQuery>(ALL_LINES);
export const selectedLine = signal<string | null>(null);

/** The line audition playing: which language, and its handle. */
export const auditioning = signal<{ readonly key: string; readonly code: string; readonly handle: AudioHandle } | null>(null);

/** The editor's lock on the open project, as last read. */
export const editorLock = signal<"held" | "none" | "unknown">("unknown");

/** Batch import in progress: picked files (by relative path), the pattern and choices, and how far applying got. */
export interface BatchState {
  readonly files: readonly File[];
  readonly pattern: string;
  readonly language: string;
  readonly createIn: string | null;
  readonly busy: { readonly done: number; readonly total: number } | null;
}
export const batch = signal<BatchState | null>(null);

export const pendingScript = signal<ScriptDiff | null>(null);

export const selectedEvent = signal<{ readonly path: string; readonly name: string } | null>(null);
export const eventSearch = signal("");
export const benchValues = signal<Readonly<Record<string, string>>>({});
export const benchSeed = signal(1);
export const benchMemory = signal<BenchMemory>(EMPTY_MEMORY);
export const rollBars = signal<readonly RollBar[] | null>(null);
