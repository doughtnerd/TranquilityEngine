// ADR 0171 amended by 0172 (M5a, task Pf8; api-and-models §7, §5): the open and save experience as a pure model (no DOM,
// no Preact). It owns three things:
//   1. the words for every refusal: `captureErrorMessage` has one headline per `CaptureError` code in `capture/format.ts`
//      (a `Record` over `CaptureErrorCode`, so a new code is a type error here until it has a message), and it appends the
//      reader's own detail, which for `newerFormat`, `olderFormat` and `wireMismatch` names both versions;
//   2. the open flow's progress (`OpenSaveFlow`: running with a fraction, cancelled, done, failed), fed by the Worker's
//      `onProgress(phase, done, total)` and by the controller's `busy`;
//   3. `describeFlow`, what the bar shows (text, fraction, whether Cancel is offered) as a pure function of that state and
//      the controller's view.
// A cancelled open leaves the previous capture open (the controller's rule); this model only says so. Saving has no
// progress from the recorder (`capture/save.ts` reports none), so a save is running without a fraction.
import { CAPTURE_ERROR_CODES, type CaptureErrorCode } from "../../runtime/capture/format";

/** Codes the open route adds beside the reader's (`openCapture.ts`, the controller): not `.mycap`, and any other failure. */
export type OpenRouteCode = "notCapture" | "open";
export type OpenErrorCode = CaptureErrorCode | OpenRouteCode;

/** One headline per code. The reader's detail follows it (`captureErrorMessage`), so a headline says what it means and what to do. */
export const CAPTURE_ERROR_HEADLINES: Readonly<Record<CaptureErrorCode, string>> = {
  badMagic: "Not a Myco capture file.",
  newerFormat: "This capture was saved by a newer build; update this editor to open it.",
  olderFormat: "This capture was saved by an older build and old captures are not migrated; re-record it with this build.",
  wireMismatch: "This capture was recorded by a different audio build, so its records can't be read.",
  tooLarge: "This capture is larger than this build can open.",
  inflateOverrun: "The capture's data is bigger than its header says; the file is damaged or not trusted.",
  badHeader: "The capture's header is invalid.",
  inflateFailed: "The capture's compressed data is corrupt.",
  sizeMismatch: "The capture's data length doesn't match its header; the file is cut short or damaged.",
  metaTooLarge: "The capture's description block is too large.",
  badMeta: "The capture's description block is invalid.",
  badUtf8: "The capture holds text that is not valid UTF-8.",
  textTooLong: "The capture holds a name or marker that is too long.",
  tooManyNames: "The capture holds more names than this build reads.",
  truncatedRecord: "The capture ends in the middle of a record; the file is cut short.",
  recordTooLarge: "The capture holds a record larger than this build reads.",
  tooManyRecords: "The capture holds more records than its header says.",
  countMismatch: "The capture holds fewer records than its header says; the file is cut short.",
  unknownRequired: "The capture uses a record type this build doesn't know.",
  badLength: "A record in the capture has the wrong length.",
  badValue: "A record in the capture holds a value out of range.",
  badRecord: "A record in the capture is invalid.",
  badSeq: "The capture's records are out of order (sequence numbers).",
  badEpoch: "The capture's records are out of order (epochs).",
  badFrame: "A record in the capture has an invalid time.",
  disorder: "The capture's records are out of time order.",
  badIndex: "The capture's index is invalid.",
  cancelled: "The open was cancelled.",
};

/** The route's own codes (`OPEN_REFUSALS` in `openCapture.ts` carries their full texts as the detail). */
export const OPEN_ROUTE_HEADLINES: Readonly<Record<OpenRouteCode, string>> = {
  notCapture: "Not a capture file.",
  open: "The file couldn't be opened.",
};

const KNOWN_CODES: ReadonlySet<string> = new Set<string>([...CAPTURE_ERROR_CODES, "notCapture", "open"]);

export const isOpenErrorCode = (code: string): code is OpenErrorCode => KNOWN_CODES.has(code);

/** The headline of `code`, or null for a code this build has no words for. */
export function headlineOf(code: string): string | null {
  if (Object.prototype.hasOwnProperty.call(CAPTURE_ERROR_HEADLINES, code)) return CAPTURE_ERROR_HEADLINES[code as CaptureErrorCode];
  if (Object.prototype.hasOwnProperty.call(OPEN_ROUTE_HEADLINES, code)) return OPEN_ROUTE_HEADLINES[code as OpenRouteCode];
  return null;
}

/**
 * The message for a refusal: `<headline> (<code>) <detail>`. `detail` is the reader's message without its "code at offset"
 * prefix; for the version codes it names both sides ("capture format 2 is newer than this build's 1", "recorded with audio
 * ABI x ...; this build is ABI y"). An unknown code still shows its code and detail.
 */
export function captureErrorMessage(code: string, detail: string): string {
  const head = headlineOf(code);
  const tail = detail.trim();
  return [head, `(${code})`, tail].filter((s) => s !== null && s !== "").join(" ");
}

const BANNER_ERROR = new RegExp(`^Can't open (.+?): (${[...KNOWN_CODES].join("|")}): ([\\s\\S]*)$`);

/** The text of the controller's error banner, split back into its code and detail (`profilerBanners` writes it as `Can't open <file>: <code>: <message>`, and for `wireMismatch` without the code). */
export function parseErrorBanner(id: string, text: string): { file: string; code: string; detail: string } | null {
  if (id === "wireMismatch") {
    const m = /^Can't open (.+?): ([\s\S]*)$/.exec(text);
    return m ? { file: m[1]!, code: "wireMismatch", detail: m[2]! } : null;
  }
  if (id !== "error") return null;
  const m = BANNER_ERROR.exec(text);
  return m ? { file: m[1]!, code: m[2]!, detail: m[3]! } : null;
}

// ---- progress -----------------------------------------------------------------------------------------------------------

export type FlowKind = "open" | "save";
export type FlowPhase = "idle" | "running" | "cancelled" | "done" | "failed";
export type OpenProgressPhase = "inflate" | "records";

/** What the model holds. `fraction` is 0..1 or null when the flow can't say (a save, or an open before its first report). */
export interface FlowState {
  readonly kind: FlowKind | null;
  readonly phase: FlowPhase;
  readonly name: string | null;
  readonly fraction: number | null;
  readonly step: OpenProgressPhase | null;
}

const IDLE: FlowState = { kind: null, phase: "idle", name: null, fraction: null, step: null };

/** An open has two steps, inflating then scanning records; each fills half of the bar. */
export function openFraction(step: OpenProgressPhase, done: number, total: number): number {
  const part = total > 0 && Number.isFinite(done) ? Math.min(Math.max(done / total, 0), 1) : 0;
  return step === "inflate" ? part / 2 : 0.5 + part / 2;
}

export class OpenSaveFlow {
  private s: FlowState = IDLE;
  private readonly subs = new Set<() => void>();

  get state(): FlowState {
    return this.s;
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  /** An open or a save starts (replacing whatever the last one left). */
  begin(kind: FlowKind, name: string | null = null): void {
    this.set({ kind, phase: "running", name, fraction: null, step: null });
  }

  /** The Worker's `onProgress`; ignored unless an open is running (a late report after a cancel changes nothing). */
  progress(step: OpenProgressPhase, done: number, total: number): void {
    if (this.s.kind !== "open" || this.s.phase !== "running") return;
    // Never backwards within an open: a step's own report can't undo the one before it.
    const f = openFraction(step, done, total);
    this.set({ ...this.s, step, fraction: Math.max(f, this.s.fraction ?? 0) });
  }

  /** The user cancelled a running flow. */
  cancel(): void {
    if (this.s.phase !== "running") return;
    this.set({ ...this.s, phase: "cancelled", fraction: null, step: null });
  }

  /** The running flow ended well (or, for a flow that isn't running, nothing). */
  finish(): void {
    if (this.s.phase !== "running") return;
    this.set({ ...this.s, phase: "done", fraction: 1, step: null });
  }

  /** The running flow ended in a refusal or error. */
  fail(): void {
    if (this.s.phase !== "running") return;
    this.set({ ...this.s, phase: "failed", fraction: null, step: null });
  }

  reset(): void {
    this.set(IDLE);
  }

  private set(next: FlowState): void {
    this.s = next;
    for (const cb of [...this.subs]) cb();
  }
}

// ---- what the bar shows -------------------------------------------------------------------------------------------------

/** The parts of the controller's `ProfilerView` the bar reads. */
export interface FlowViewInput {
  readonly busy: "opening" | "saving" | null;
  readonly flowError: string | null;
  readonly savedAs: string | null;
  readonly fileName: string | null;
  readonly origin: "none" | "file" | "live";
  /** An error banner (`error` or `wireMismatch`) is up: the last open was refused. */
  readonly openRefused: boolean;
}

/**
 * Keeps `flow` in step with the controller: call it with each view. A busy that starts begins a flow; one that ends
 * finishes it (or fails it when an error banner or `flowError` is up). A cancel the flow already recorded stays.
 */
export function syncFlow(flow: OpenSaveFlow, prevBusy: FlowViewInput["busy"], view: FlowViewInput): void {
  if (view.busy && view.busy !== prevBusy) flow.begin(view.busy === "opening" ? "open" : "save", view.fileName);
  else if (!view.busy && prevBusy) {
    if (view.flowError !== null || (prevBusy === "opening" && view.openRefused)) flow.fail();
    else flow.finish();
  }
}

export interface FlowStatus {
  readonly phase: FlowPhase;
  readonly kind: FlowKind | null;
  /** The status line. Empty when nothing is worth saying. */
  readonly text: string;
  /** 0..1 for a determinate bar, null for an indeterminate one, undefined when no bar is shown. */
  readonly fraction: number | null | undefined;
  readonly cancellable: boolean;
  readonly severity: "info" | "error";
}

/** The bar's status as a pure function of the flow and the controller's view. */
export function describeFlow(state: FlowState, view: FlowViewInput): FlowStatus {
  const file = state.name ?? view.fileName ?? "the file";
  if (view.busy === "opening") {
    const step = state.step === "records" ? "Reading records" : state.step === "inflate" ? "Unpacking" : "Opening";
    const pct = state.fraction === null ? "" : ` ${Math.round(state.fraction * 100)}%`;
    return { phase: "running", kind: "open", text: `${step} ${file}${pct}`, fraction: state.fraction, cancellable: true, severity: "info" };
  }
  if (view.busy === "saving") return { phase: "running", kind: "save", text: "Saving", fraction: null, cancellable: false, severity: "info" };
  if (view.flowError !== null) return { phase: "failed", kind: state.kind, text: view.flowError, fraction: undefined, cancellable: false, severity: "error" };
  if (state.phase === "cancelled" && state.kind === "open") {
    const keep = view.origin === "file" && view.fileName ? ` ${view.fileName} stays open.` : " The previous capture is unchanged.";
    return { phase: "cancelled", kind: "open", text: `Open cancelled.${keep}`, fraction: undefined, cancellable: false, severity: "info" };
  }
  if (view.savedAs) return { phase: "done", kind: "save", text: `Saved ${view.savedAs}`, fraction: undefined, cancellable: false, severity: "info" };
  if (view.openRefused) return { phase: "failed", kind: "open", text: `Couldn't open ${file}; see the notice below.`, fraction: undefined, cancellable: false, severity: "error" };
  if (view.origin === "file" && view.fileName) return { phase: "done", kind: "open", text: view.fileName, fraction: undefined, cancellable: false, severity: "info" };
  return { phase: "idle", kind: null, text: "", fraction: undefined, cancellable: false, severity: "info" };
}

/** The flow the bar and the profiler's default deps share (one panel at a time in the editor). */
export const profilerFlow = new OpenSaveFlow();
