/**
 * Hardware input recording (ADR 0336, build notes "the editor"): a controller's raw input as it
 * arrives at the adapter boundary, before any engine code reads it, saved as a fixture file that
 * `replay.ts` feeds back through the same adapter code (tests, bug reports).
 *
 * - **Taps.** The gamepad adapters call in here: the WebHID adapter wraps each device it opens
 *   (`tapHidDevice`) and passes every input report through the wrap; the SDL adapter passes each
 *   native batch (`tapNativeBatch`); the Gamepad API adapter passes each poll's pads
 *   (`tapWebPads`). While nothing records, a tap is one check, plus two small things kept so a
 *   recording started later can replay its devices' setup: each HID device's setup exchange (the
 *   reports sent and received until its driver is ready, and its feature-report replies) and the
 *   native pads' connect events.
 * - **Recording** (`startInputRecording`): from now until `stop()`, every report, batch and changed
 *   Gamepad API reading, timestamped; `stop()` returns the recording, a plain JSON value.
 *
 * The file format (`myco-input-recording`, version 1) is documented on `InputRecording` and in
 * docs/plans/2026-11-input-hardware-checklist.md ("Recording"). Nothing here is public API: the
 * editor reaches it through the editor SDK (`recordInput`).
 */
import type { NativeGamepadEvent } from "./tauriGamepads";
import type { HidCollectionInfo, HidDevice, HidInputReportEvent, HidReportInfo } from "./webHid/hidTypes";

export const RECORDING_FORMAT = "myco-input-recording";
export const RECORDING_VERSION = 1;

/** A native connect event (`NativeGamepadEvent` with `t: "connect"`). */
export type NativeConnectEvent = Extract<NativeGamepadEvent, { t: "connect" }>;

/** One step of a HID device's setup: a report the driver sent (its id), or an input report the device sent back. */
export type HidSetupStep = { readonly t: "out"; readonly report: number } | { readonly t: "in"; readonly report: number; readonly data: string };

/** A WebHID device as a recording keeps it: what its driver reads of the device, and its setup exchange. */
export interface RecordedHidDevice {
  readonly name: string;
  readonly vendor: number;
  readonly product: number;
  /** The report descriptor's collections (usage, and each report's id and item sizes). */
  readonly collections: readonly HidCollectionInfo[];
  /** Feature-report replies in the order the driver asked for them: report id and bytes (hex). */
  readonly features: readonly { readonly report: number; readonly data: string }[];
  /** The reports sent and received from opening the device until its driver was ready, in order (bytes in hex). */
  readonly setup: readonly HidSetupStep[];
  /** Milliseconds into the recording when it was ready (0: open before recording began). */
  readonly at: number;
}

/** A Gamepad API pad as one poll read it. */
export interface RecordedWebPad {
  readonly index: number;
  /** `Gamepad.id`. */
  readonly id: string;
  /** `Gamepad.mapping`: "standard" or "". */
  readonly mapping: string;
  readonly buttons: readonly number[];
  readonly axes: readonly number[];
}

/** One recorded arrival, `time` milliseconds after recording began. */
export type RecordedInputEvent =
  /** An input report of `hid[device]`: its id and bytes after the id (hex). */
  | { readonly time: number; readonly hid: number; readonly report: number; readonly data: string }
  /** A batch from the SDL adapter, as the native side sent it. */
  | { readonly time: number; readonly native: readonly NativeGamepadEvent[] }
  /** A Gamepad API poll whose reading changed: every pad the adapter reads (a pad missing has disconnected). */
  | { readonly time: number; readonly web: readonly RecordedWebPad[] };

/**
 * A recording (`myco-input-recording`, version 1): a JSON file, conventionally `*.input-recording.json`.
 *
 * ```json
 * { "format": "myco-input-recording", "version": 1, "recorded": "2026-11-22T10:30:00.000Z", "duration": 2150,
 *   "hid": [{ "name": "DualSense Wireless Controller", "vendor": 1356, "product": 3302, "collections": [...],
 *             "features": [{ "report": 5, "data": "0a00…" }], "setup": [{ "t": "out", "report": 2 }], "at": 0 }],
 *   "native": { "pads": [{ "t": "connect", "id": 3, "name": "Xbox Series X Controller", ... }] },
 *   "web": { "platform": "windows" },
 *   "events": [{ "time": 16.6, "hid": 0, "report": 1, "data": "80807f…" },
 *              { "time": 20.1, "native": [{ "t": "button", "id": 3, "index": 0, "value": 1, "time": 81234 }] },
 *              { "time": 33.3, "web": [{ "index": 0, "id": "Xbox 360 Controller (STANDARD GAMEPAD)", "mapping": "standard", "buttons": [1, 0, …], "axes": [0, 0, 0, 0] }] }] }
 * ```
 */
export interface InputRecording {
  readonly format: typeof RECORDING_FORMAT;
  readonly version: typeof RECORDING_VERSION;
  /** When recording began (ISO 8601). */
  readonly recorded: string;
  /** Milliseconds from start to stop. */
  readonly duration: number;
  /** WebHID devices, referred to by index from the events. */
  readonly hid: readonly RecordedHidDevice[];
  /** SDL pads connected when recording began (later connects are in the batches); null when the SDL adapter wasn't running. */
  readonly native: { readonly pads: readonly NativeConnectEvent[] } | null;
  /** The OS whose controller database the Gamepad API adapter used; null when it wasn't running. */
  readonly web: { readonly platform: WebPlatform } | null;
  readonly events: readonly RecordedInputEvent[];
}

export type WebPlatform = "windows" | "mac" | "linux" | "other";

// --- bytes ---------------------------------------------------------------------------------------

/** Bytes as lower-case hex. */
export function toHex(bytes: ArrayLike<number>): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] & 0xff).toString(16).padStart(2, "0");
  return s;
}

/** Hex as bytes. */
export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const viewHex = (view: DataView) => toHex(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));

// --- the registry the adapters tap ---------------------------------------------------------------

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

interface Recorder {
  readonly start: number;
  readonly hid: RecordedHidDevice[];
  /** Each tapped HID device's index in `hid`. */
  readonly hidIndex: Map<HidTapState, number>;
  native: { pads: NativeConnectEvent[] } | null;
  web: { platform: WebPlatform } | null;
  readonly events: RecordedInputEvent[];
  /** The last Gamepad API reading recorded, to record only changes. */
  lastWeb: RecordedWebPad[];
}

const recorders = new Set<Recorder>();

/** At most this many input reports are kept between two sent reports during a device's setup (it streams reports meanwhile). */
const SETUP_INPUTS_PER_GAP = 8;

interface HidTapState {
  readonly device: HidDevice;
  readonly features: { report: number; data: string }[];
  readonly setup: HidSetupStep[];
  inputsSinceOut: number;
  ready: boolean;
}

/** Open HID devices whose drivers are ready. */
const readyHid = new Set<HidTapState>();
/** SDL pads connected now, by id. */
const nativePads = new Map<number, NativeConnectEvent>();
/** The OS the Gamepad API adapter maps for, once it has polled. */
let webPlatform: WebPlatform | null = null;

/** What the WebHID adapter gives the driver instead of the device, and passes reports through. */
export interface HidDeviceTap {
  /** The device as the driver should use it: the same device, its setup exchange noted. */
  readonly device: HidDevice;
  /** An input report arrived (call before the driver reads it). */
  input(e: HidInputReportEvent): void;
  /** The driver is ready: later reports are the pad's input. */
  ready(): void;
  /** The device closed or went away. */
  close(): void;
}

function copyReports(list: readonly HidReportInfo[] | undefined): HidReportInfo[] | undefined {
  return list?.map((r) => ({ reportId: r.reportId, items: r.items?.map((i) => ({ reportSize: i.reportSize, reportCount: i.reportCount })) }));
}

/** The collections as plain data (the browser's are objects whose fields JSON doesn't see). */
function copyCollections(list: readonly HidCollectionInfo[]): HidCollectionInfo[] {
  return list.map((c) => ({ usagePage: c.usagePage, usage: c.usage, inputReports: copyReports(c.inputReports), outputReports: copyReports(c.outputReports), featureReports: copyReports(c.featureReports) }));
}

function describeHid(state: HidTapState, at: number): RecordedHidDevice {
  const d = state.device;
  return { name: d.productName, vendor: d.vendorId, product: d.productId, collections: copyCollections(d.collections), features: [...state.features], setup: [...state.setup], at };
}

/** Wrap a HID device the WebHID adapter opened (see the file comment). */
export function tapHidDevice(device: HidDevice): HidDeviceTap {
  const state: HidTapState = { device, features: [], setup: [], inputsSinceOut: 0, ready: false };
  const wrapped: HidDevice = {
    get opened() {
      return device.opened;
    },
    get vendorId() {
      return device.vendorId;
    },
    get productId() {
      return device.productId;
    },
    get productName() {
      return device.productName;
    },
    get collections() {
      return device.collections;
    },
    open: () => device.open(),
    close: () => device.close(),
    sendReport(reportId, data) {
      if (!state.ready) {
        state.setup.push({ t: "out", report: reportId });
        state.inputsSinceOut = 0;
      }
      return device.sendReport(reportId, data);
    },
    sendFeatureReport: (reportId, data) => device.sendFeatureReport(reportId, data),
    async receiveFeatureReport(reportId) {
      const view = await device.receiveFeatureReport(reportId);
      if (!state.ready) state.features.push({ report: reportId, data: viewHex(view) });
      return view;
    },
    addEventListener: (type, listener) => device.addEventListener(type, listener),
    removeEventListener: (type, listener) => device.removeEventListener(type, listener),
  };
  return {
    device: wrapped,
    input(e) {
      if (!state.ready) {
        if (state.inputsSinceOut++ < SETUP_INPUTS_PER_GAP) state.setup.push({ t: "in", report: e.reportId, data: viewHex(e.data) });
        return;
      }
      if (recorders.size === 0) return;
      const t = now();
      let data: string | null = null;
      for (const r of recorders) {
        const index = r.hidIndex.get(state);
        if (index === undefined) continue;
        data ??= viewHex(e.data);
        r.events.push({ time: t - r.start, hid: index, report: e.reportId, data });
      }
    },
    ready() {
      if (state.ready) return;
      state.ready = true;
      readyHid.add(state);
      for (const r of recorders) addHid(r, state, now() - r.start);
    },
    close() {
      readyHid.delete(state);
    },
  };
}

function addHid(r: Recorder, state: HidTapState, at: number): void {
  if (r.hidIndex.has(state)) return;
  r.hidIndex.set(state, r.hid.length);
  r.hid.push(describeHid(state, at));
}

/** A batch from the SDL adapter arrived (call before it's applied). */
export function tapNativeBatch(batch: readonly NativeGamepadEvent[]): void {
  for (const e of batch) {
    if (e.t === "connect") nativePads.set(e.id, e);
    else if (e.t === "disconnect") nativePads.delete(e.id);
  }
  if (recorders.size === 0 || batch.length === 0) return;
  const t = now();
  for (const r of recorders) {
    r.native ??= { pads: [] };
    r.events.push({ time: t - r.start, native: batch.map((e) => ({ ...e })) });
  }
}

/** The Gamepad API adapter polled: `pads` as `getGamepads()` returned them; pads `skip` accepts aren't its (WebHID reports them). */
export function tapWebPads(pads: ArrayLike<Gamepad | null>, platform: WebPlatform, skip?: (pad: Gamepad) => boolean): void {
  webPlatform = platform;
  if (recorders.size === 0) return;
  const reading: RecordedWebPad[] = [];
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    if (!p || !p.connected || skip?.(p)) continue;
    reading.push({ index: p.index, id: p.id, mapping: p.mapping, buttons: Array.from(p.buttons, (b) => b.value), axes: Array.from(p.axes) });
  }
  const t = now();
  for (const r of recorders) {
    r.web ??= { platform };
    if (sameReading(r.lastWeb, reading)) continue;
    r.lastWeb = reading;
    r.events.push({ time: t - r.start, web: reading });
  }
}

function sameReading(a: readonly RecordedWebPad[], b: readonly RecordedWebPad[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.index !== y.index || x.id !== y.id || x.mapping !== y.mapping || !sameNumbers(x.buttons, y.buttons) || !sameNumbers(x.axes, y.axes)) return false;
  }
  return true;
}

const sameNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);

// --- recording -------------------------------------------------------------------------------------

/** A recording in progress (`startInputRecording`). */
export interface InputRecorder {
  /** Events recorded so far. */
  readonly events: number;
  /** Milliseconds since recording began. */
  readonly elapsed: number;
  /** Stop recording and return what was recorded. Later calls return the same recording. */
  stop(): InputRecording;
}

/** Start recording every gamepad adapter's raw input (see the file comment). */
export function startInputRecording(): InputRecorder {
  const started = new Date();
  const r: Recorder = {
    start: now(),
    hid: [],
    hidIndex: new Map(),
    native: nativePads.size ? { pads: [...nativePads.values()].map((e) => ({ ...e })) } : null,
    web: webPlatform ? { platform: webPlatform } : null,
    events: [],
    lastWeb: [],
  };
  for (const state of readyHid) addHid(r, state, 0);
  recorders.add(r);
  let result: InputRecording | null = null;
  return {
    get events() {
      return r.events.length;
    },
    get elapsed() {
      return now() - r.start;
    },
    stop() {
      if (result) return result;
      recorders.delete(r);
      result = { format: RECORDING_FORMAT, version: RECORDING_VERSION, recorded: started.toISOString(), duration: now() - r.start, hid: r.hid, native: r.native, web: r.web, events: r.events };
      return result;
    },
  };
}

/** Check that `json` is a recording this engine reads (format and version); throws with the reason if not. */
export function parseInputRecording(json: unknown): InputRecording {
  const r = json as Partial<InputRecording> | null;
  if (!r || typeof r !== "object" || r.format !== RECORDING_FORMAT) throw new Error(`Not an input recording: expected "format": "${RECORDING_FORMAT}".`);
  if (r.version !== RECORDING_VERSION) throw new Error(`Input recording version ${String(r.version)} isn't supported (this engine reads version ${RECORDING_VERSION}).`);
  if (!Array.isArray(r.events) || !Array.isArray(r.hid)) throw new Error("The input recording has no events or hid list.");
  return r as InputRecording;
}
