// The Packages screen's state (ADR 0351 §6): the package and profile selected, the platform the sizes are for, the tab,
// Convert now's progress and the exact reports it answered (per platform, until `audio.json` or a sound changes).
import { signal } from "@preact/signals";
import { persisted } from "../../../editor/preferences";
import type { ImportPlatform } from "../../../engine/scene/importSettings";
import type { AudioReport } from "../../../export/audio";

export type PackagesTab = "contents" | "profiles" | "report";

export const selectedPackage = signal<string | null>(null);
export const selectedProfile = signal<string | null>(null);
/** Per user: the platform sizes and memory are shown for. */
export const packagesPlatform = persisted<ImportPlatform>("myco.studio.packages.platform", "web");
export const packagesTab = persisted<PackagesTab>("myco.studio.packages.tab", "contents");

/** Convert now running: for which platform, how far. */
export const converting = signal<{ platform: ImportPlatform; done: number; total: number; abort: AbortController } | null>(null);
/** The last Convert now's report per platform, with the `audio.json` value it ran against (stale once that changes). */
export const exactReports = signal<ReadonlyMap<ImportPlatform, { report: AudioReport; against: unknown }>>(new Map());
