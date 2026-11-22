/**
 * Contract (ADR 0341 §1): dialogue events, `*.dialogue.json` (`myco.dialogue@1`). One file holds any number of events
 * (Wwise work units); each has ordered labelled arguments and a path table (argument values → weighted line keys, with
 * `*` wildcards), resolved by `decide.ts`. These are the parsed (canonical) shapes `format.ts` produces and writes.
 *
 * Pure; no plugin, no DOM.
 */

export const DIALOGUE_FORMAT = "myco.dialogue@1";
export const DIALOGUE_SUFFIX = ".dialogue.json";

/** The wildcard path entry. */
export const WILDCARD = "*";

/** An argument with its own labels (and a default, else the first). */
export interface LocalArgument {
  kind: "local";
  name: string;
  labels: string[];
  default: string;
}
/** An argument that reads a global labelled parameter of `audio.json` (0304); its name is the parameter's. */
export interface ParameterArgument {
  kind: "parameter";
  parameter: string;
}
export type DialogueArgument = LocalArgument | ParameterArgument;

/** One weighted line of a path. */
export interface DialogueLine {
  /** A line key (0340). */
  key: string;
  /** 0..100; 0 = never. */
  weight: number;
}

export interface DialoguePath {
  /** One entry per argument: a label or `*`. */
  path: string[];
  /** Empty: an explicit silence. */
  lines: DialogueLine[];
  /** 0..1: the chance this path is taken when it is reached. */
  probability: number;
  /** 0..100: the path's weight in weighted mode. */
  weight: number;
}

export type DialogueMode = "bestMatch" | "weighted";
export type WhenBusy = "queue" | "interrupt" | "drop";
export type InterruptRule = "never" | "lower" | "always";

export interface DialogueEvent {
  /** `[A-Za-z0-9_.-]{1,64}`, unique across the project. */
  name: string;
  arguments: DialogueArgument[];
  mode: DialogueMode;
  paths: DialoguePath[];
  /** 0..100; null: the picked line's table priority. */
  priority: number | null;
  whenBusy: WhenBusy;
  /** What this event may cut off. */
  interrupt: InterruptRule;
  /** Seconds a queued say may wait before it is dropped. */
  maxWait: number;
  /** Seconds since this event last spoke. */
  cooldown: number;
  /** 0..1 per say. */
  chance: number;
  /** 0..8: the last N lines this event spoke are skipped when possible. */
  avoidRepeat: number;
  /** A line with no file in the language chain is unavailable. */
  skipMissing: boolean;
  /** An event said (same arguments) when one of this event's lines is cut off; null: none. */
  onInterrupted: string | null;
}

/** The asset file. */
export interface DialogueAsset {
  format: typeof DIALOGUE_FORMAT;
  events: DialogueEvent[];
}

export interface DialogueParse {
  dialogue: DialogueAsset;
  problems: string[];
}

/** The name an argument is passed by (`args[name]`). */
export const argumentName = (a: DialogueArgument): string => (a.kind === "local" ? a.name : a.parameter);
