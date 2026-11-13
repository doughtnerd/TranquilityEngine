// ADR 0171 amended by 0172 (M5a, task Pf8; api-and-models §7): the Profiler's `bar` slot. The record, stop, save and open
// buttons of the default bar plus the open/save experience: a progress bar and Cancel for an open, "Saving" for a save,
// the failure or the saved name, and the keyboard legend. Every control has an `aria-label`. The panel's keys are scoped
// to the panel's own element (`attachProfilerKeys`), found from the bar's DOM node. Open still goes through
// `profilerSlots.onDropFile` (X2's route). Fill: `profilerSlots.bar = ProfilerBar`.
import type { ComponentChild } from "preact";
import { useEffect, useReducer, useRef } from "preact/hooks";
import { profilerSlots, type BarSlotProps, type ProfilerController, type ProfilerView } from "./ProfilerPanel";
import { describeFlow, profilerFlow, syncFlow, type FlowStatus, type FlowViewInput, type OpenSaveFlow } from "./openSaveFlow";
import { KEY_BINDINGS, attachProfilerKeys } from "./profilerKeys";
import "./openSaveFlow.css";

/** The controller's view as the flow model reads it. */
export function flowInput(view: ProfilerView): FlowViewInput {
  return {
    busy: view.busy,
    flowError: view.flowError,
    savedAs: view.savedAs,
    fileName: view.fileName,
    origin: view.origin,
    openRefused: view.banners.some((b) => b.id === "error" || b.id === "wireMismatch"),
  };
}

export interface BarViewProps {
  readonly view: ProfilerView;
  readonly status: FlowStatus;
  readonly onRecord: () => void;
  readonly onStop: () => void;
  readonly onSave: () => void;
  /** The Open button: the caller clicks the hidden file input. */
  readonly onOpen: () => void;
  readonly onCancel: () => void;
  readonly onFile: (file: File, input: HTMLInputElement) => void;
  readonly fileInputRef?: { current: HTMLInputElement | null };
}

/** The bar as a pure function of its props (the tests walk this tree). */
export function BarView({ view, status, onRecord, onStop, onSave, onOpen, onCancel, onFile, fileInputRef }: BarViewProps): ComponentChild {
  const recording = view.recording === "recording" || view.recording === "loading";
  const busy = view.busy !== null;
  return (
    <div class="profiler-bar-wrap">
      <div class="profiler-bar" role="toolbar" aria-label="Capture">
        <button type="button" data-action="record" aria-label="Record a capture" disabled={recording || busy} onClick={onRecord}>
          Record
        </button>
        <button type="button" data-action="stop" aria-label="Stop recording" disabled={view.recording !== "recording"} onClick={onStop}>
          Stop
        </button>
        <button type="button" data-action="save" aria-label="Save the capture" disabled={(view.recording !== "stopped" && view.recording !== "recording") || busy} onClick={onSave}>
          Save
        </button>
        <button type="button" data-action="open" aria-label="Open a capture file" disabled={busy} onClick={onOpen}>
          Open
        </button>
        {view.busy === "opening" ? (
          <button type="button" data-action="cancel" aria-label="Cancel opening the capture" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        {status.phase === "running" ? (
          <progress
            class="profiler-progress"
            data-kind={status.kind ?? ""}
            aria-label={status.kind === "save" ? "Save progress" : "Open progress"}
            max={1}
            {...(typeof status.fraction === "number" ? { value: status.fraction } : {})}
          />
        ) : null}
        <input
          ref={fileInputRef}
          type="file"
          accept=".mycap"
          hidden
          aria-label="Choose a capture file"
          onChange={(e) => {
            const input = e.currentTarget as HTMLInputElement;
            const f = input.files?.[0];
            if (f) onFile(f, input);
          }}
        />
        <span class="profiler-status" role="status" aria-live="polite" aria-label="Capture status" data-severity={status.severity} data-phase={status.phase}>
          {status.text}
        </span>
      </div>
      <ul class="profiler-keys" aria-label="Keyboard shortcuts for the timeline cursor">
        {KEY_BINDINGS.map((b) => (
          <li key={b.id} data-key={b.id}>
            <kbd aria-label={b.shortcuts}>{b.keys}</kbd>
            <span>{b.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the bar does with a chosen file: clears the input (so the same file can be chosen again) and routes it. */
export function chooseFile(controller: ProfilerController, file: File, input: { value: string }, flow: OpenSaveFlow = profilerFlow): void {
  input.value = "";
  flow.reset(); // a new open replaces the last outcome
  profilerSlots.onDropFile(controller, file);
}

export function ProfilerBar({ view, controller }: BarSlotProps): ComponentChild {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const prevBusy = useRef<ProfilerView["busy"]>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  // The flow follows the controller's busy during render, so a progress report that lands right after the render finds it begun.
  const input = flowInput(view);
  if (prevBusy.current !== view.busy) {
    syncFlow(profilerFlow, prevBusy.current, input);
    prevBusy.current = view.busy;
  }
  useEffect(() => profilerFlow.subscribe(() => rerender(0)), []);
  useEffect(() => {
    const el = root.current?.closest(".profiler") as HTMLElement | null;
    return el ? attachProfilerKeys(el, controller) : undefined;
  }, [controller]);
  const status = describeFlow(profilerFlow.state, input);
  return (
    <div ref={root} class="profiler-bar-root">
      <BarView
        view={view}
        status={status}
        fileInputRef={fileInput}
        onRecord={() => void controller.record()}
        onStop={() => controller.stop()}
        onSave={() => void controller.save()}
        onOpen={() => fileInput.current?.click()}
        onCancel={() => {
          profilerFlow.cancel();
          controller.cancelOpen();
        }}
        onFile={(f, el) => chooseFile(controller, f, el)}
      />
    </div>
  );
}
