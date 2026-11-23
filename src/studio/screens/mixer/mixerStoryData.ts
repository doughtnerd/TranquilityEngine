// A Mixer session over a plain signal, for the Mixer's stories and session tests: edits replace the value (with their
// labels kept in `steps`), confirms answer as told, toasts and status lines are collected, and the runtime is
// optional (a fake applier when given). No asset document, no project, no audio.
import { signal } from "@preact/signals";
import type { ApplyResult, MixOp } from "../../../engine/audio/mixOps";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { BusReading, LoudnessReading } from "./boardModel";
import { createMixerSession, type MixerDeps, type MixerSession } from "./mixerScreen";

export interface FakeMixer {
  readonly session: MixerSession;
  readonly steps: { label: string; coalesce: boolean }[];
  readonly reports: string[];
  readonly toasts: { text: string; undo?: () => void }[];
  readonly applied: MixOp[];
  /** Answer the next confirms with this. */
  confirmWith(ok: boolean): void;
}

export interface FakeOptions {
  readonly readOnly?: boolean;
  /** The runtime is up: ops are applied to a fake mixer and meters read `readings`. */
  readonly running?: boolean;
  readonly readings?: Readonly<Record<string, BusReading>>;
  readonly loudness?: LoudnessReading;
  readonly usersOf?: (name: string) => string[];
  readonly extra?: Partial<MixerDeps>;
}

export function fakeMixer(project: AudioProject, options: FakeOptions = {}): FakeMixer {
  const value = signal(project);
  const steps: { label: string; coalesce: boolean }[] = [];
  const reports: string[] = [];
  const toasts: { text: string; undo?: () => void }[] = [];
  const applied: MixOp[] = [];
  let answer = true;
  const running = options.running ?? false;
  const session = createMixerSession({
    doc: {
      value,
      readOnly: options.readOnly ?? false,
      edit(next, o) {
        steps.push({ label: o?.label ?? "Edit", coalesce: !!o?.coalesce });
        value.value = next;
      },
    },
    path: "audio.json",
    confirm: async () => answer,
    toast: (t) => void toasts.push(t),
    report: (kind, text) => void reports.push(`${kind}: ${text}`),
    usersOf: options.usersOf,
    renameOutside: async () => [],
    live: running ? { running: () => true, apply: (op): ApplyResult => (applied.push(op), { ok: true, class: "smoothed" }) } : undefined,
    readBus: (name) => options.readings?.[name] ?? null,
    readLoudness: () => options.loudness ?? null,
    prefs: { pins: signal<string[]>(["Music", "Dialogue", "SFX", "Ambience"]), boardOpen: signal(true), view: signal<"list" | "strips">("list") },
    ...options.extra,
  });
  return { session, steps, reports, toasts, applied, confirmWith: (ok) => void (answer = ok) };
}
