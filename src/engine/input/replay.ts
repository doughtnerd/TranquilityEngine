/**
 * Replay a hardware input recording (`recording.ts`) through the same adapter code a live
 * controller goes through: WebHID devices as stand-in `HIDDevice`s opened by the real WebHID
 * adapter and drivers (`webHidGamepads.ts`), SDL batches through `applyNativeBatch`, and Gamepad
 * API readings through the real Gamepad API adapter (`webGamepads.ts`) reading a stand-in
 * `navigator`. What reaches `sink` is what the recorded controller made the engine see: tests
 * check it, or give `devices` (or `Input.inject`) to drive a game with it.
 *
 * A stand-in HID device answers feature reports with the recorded replies and plays the recorded
 * setup exchange: input reports up to the next report the driver sent, then waits for the driver
 * to send one. Once its driver is ready, the device's recorded input reports follow in order.
 */
import type { DeviceEventSink } from "./devices";
import { loadInputMapping } from "./mapping";
import { fromHex, parseInputRecording, type InputRecording, type RecordedHidDevice, type RecordedWebPad, type WebPlatform } from "./recording";
import { applyNativeBatch } from "./tauriGamepads";
import { webGamepads } from "./webGamepads";
import type { Hid, HidConnectionEvent, HidDevice, HidInputReportEvent } from "./webHid/hidTypes";
import { webHidGamepads } from "./webHid/webHidGamepads";

/** A recording being replayed (`replayInputRecording`). */
export interface InputReplay {
  /** Milliseconds from the recording's start to its end. */
  readonly duration: number;
  /** How far it has played, in the recording's milliseconds. */
  readonly position: number;
  /** Resolves once the devices present when recording began are set up (their drivers ready, pads connected). */
  readonly ready: Promise<void>;
  /** Feed everything recorded up to `ms` into the recording (after `ready`); resolves once it has reached the sink. */
  advanceTo(ms: number): Promise<void>;
  /** Feed the rest. */
  finish(): Promise<void>;
  /** Stop: the adapters report their pads disconnected. */
  stop(): void;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A user agent the Gamepad API adapter reads as `platform` (it picks the controller database's platform from it). */
const USER_AGENTS: Record<WebPlatform, string> = {
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  linux: "Mozilla/5.0 (X11; Linux x86_64)",
  other: "Mozilla/5.0",
};

/** A recorded HID device standing in for the real one. */
class ReplayHidDevice implements HidDevice {
  opened = false;
  private readonly listeners = new Set<(e: HidInputReportEvent) => void>();
  /** The next setup step to play. */
  private cursor = 0;
  private pumping = false;
  private readonly featureCalls = new Map<number, number>();
  /** Set when every setup step has played. */
  setupDone = false;
  private readonly onSetupDone: (() => void)[] = [];

  constructor(readonly recorded: RecordedHidDevice) {}

  get vendorId() {
    return this.recorded.vendor;
  }
  get productId() {
    return this.recorded.product;
  }
  get productName() {
    return this.recorded.name;
  }
  get collections() {
    return this.recorded.collections;
  }

  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async sendReport(reportId: number) {
    const step = this.recorded.setup[this.cursor];
    if (step?.t === "out" && step.report === reportId) {
      this.cursor++;
      this.pump();
    }
  }
  async sendFeatureReport() {}
  async receiveFeatureReport(reportId: number) {
    const replies = this.recorded.features.filter((f) => f.report === reportId);
    if (!replies.length) throw new Error(`The recording has no reply to feature report ${reportId}.`);
    const n = this.featureCalls.get(reportId) ?? 0;
    this.featureCalls.set(reportId, n + 1);
    const bytes = fromHex(replies[Math.min(n, replies.length - 1)].data);
    return new DataView(bytes.buffer);
  }
  addEventListener(_type: "inputreport", l: (e: HidInputReportEvent) => void) {
    this.listeners.add(l);
    this.pump(); // the adapter listens before starting the driver: the reports before its first send can play
  }
  removeEventListener(_type: "inputreport", l: (e: HidInputReportEvent) => void) {
    this.listeners.delete(l);
  }

  emit(reportId: number, bytes: Uint8Array<ArrayBuffer>) {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const l of [...this.listeners]) l({ device: this, reportId, data });
  }

  /** Play setup input reports, a task later (as a device's arrive), up to the next report the driver must send. */
  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    setTimeout(() => {
      this.pumping = false;
      const steps = this.recorded.setup;
      while (this.cursor < steps.length) {
        const step = steps[this.cursor];
        if (step.t === "out") return;
        this.cursor++;
        this.emit(step.report, fromHex(step.data));
      }
      if (!this.setupDone) {
        this.setupDone = true;
        for (const f of this.onSetupDone.splice(0)) f();
      }
    }, 0);
  }

  /** Resolves once the setup exchange has played. */
  whenSetUp(): Promise<void> {
    return this.setupDone ? Promise.resolve() : new Promise((r) => this.onSetupDone.push(r));
  }
}

/** Replay `recording` into `sink` (see the file comment). `recording` is checked with `parseInputRecording`. */
export function replayInputRecording(recording: InputRecording | unknown, sink: DeviceEventSink): InputReplay {
  const rec = parseInputRecording(recording);
  let stopped = false;
  let position = 0;
  let next = 0;

  // WebHID: the real adapter, over a stand-in `navigator.hid` holding the recorded devices.
  const hidDevices = rec.hid.map((d) => new ReplayHidDevice(d));
  const hidListeners = new Set<(e: HidConnectionEvent) => void>();
  /** Pads the WebHID adapter has announced (it numbers them from its own first id). */
  let hidAnnounced = 0;
  const counting: DeviceEventSink = {
    ...sink,
    gamepadConnected: (info) => {
      hidAnnounced++;
      sink.gamepadConnected(info);
    },
  };
  const hid: Hid = {
    getDevices: async () => hidDevices.filter((d) => d.recorded.at <= 0),
    requestDevice: async () => [],
    addEventListener: (type, l) => void (type === "connect" && hidListeners.add(l)),
    removeEventListener: (_type, l) => void hidListeners.delete(l),
  };
  const hidAdapter = rec.hid.length ? webHidGamepads(counting, { hid } as unknown as Navigator) : null;
  /** Each HID device's readiness: its setup played and its pad announced (or a moment passed, for an adapter with no pad yet). */
  const hidReady = hidDevices.map(() => null as Promise<void> | null);
  const whenReady = (i: number): Promise<void> => {
    hidReady[i] ??= (async () => {
      await hidDevices[i].whenSetUp();
      const announced = hidAnnounced;
      for (let k = 0; k < 20 && hidAnnounced === announced; k++) await tick();
    })();
    return hidReady[i];
  };

  // The Gamepad API: the real adapter, reading a stand-in `navigator` whose pads are the recording's latest reading.
  let webPads: (Gamepad | null)[] = [];
  const known = new Set<number>();
  const webNav = { userAgent: USER_AGENTS[rec.web?.platform ?? "other"], getGamepads: () => webPads } as unknown as Navigator;
  const webAdapter = rec.web || rec.events.some((e) => "web" in e) ? webGamepads(sink, webNav) : null;

  const ready = (async () => {
    if (webAdapter) await loadInputMapping().catch(() => {}); // the adapter loads it on its first pad; have it ready
    if (rec.native?.pads.length) applyNativeBatch(sink, rec.native.pads);
    await Promise.all(hidDevices.map((d, i) => (d.recorded.at <= 0 ? whenReady(i) : null)));
  })();

  const applyWeb = async (reading: readonly RecordedWebPad[]) => {
    webPads = [];
    let fresh = false;
    for (const p of reading) {
      webPads[p.index] = fakeGamepad(p);
      if (!known.has(p.index)) {
        known.add(p.index);
        fresh = true;
      }
    }
    webAdapter!.poll();
    if (fresh) {
      await tick(); // a pad seen for the first time connects once the adapter's mapping promise settles
      webAdapter!.poll();
    }
  };

  const advanceTo = async (ms: number) => {
    await ready;
    const events = rec.events;
    while (!stopped && next < events.length && events[next].time <= ms) {
      const e = events[next++];
      // A HID device that was set up during recording joins when it did.
      for (let i = 0; i < hidDevices.length; i++) {
        const at = hidDevices[i].recorded.at;
        if (at > 0 && at <= e.time && !hidReady[i]) {
          for (const l of hidListeners) l({ device: hidDevices[i] });
          await whenReady(i);
        }
      }
      if ("hid" in e) {
        await whenReady(e.hid);
        hidDevices[e.hid].emit(e.report, fromHex(e.data));
      } else if ("native" in e) applyNativeBatch(sink, e.native);
      else await applyWeb(e.web);
      position = e.time;
    }
    position = Math.max(position, Math.min(ms, rec.duration));
  };

  return {
    duration: rec.duration,
    get position() {
      return position;
    },
    ready,
    advanceTo,
    finish: () => advanceTo(Infinity),
    stop() {
      if (stopped) return;
      stopped = true;
      hidAdapter?.stop();
      webAdapter?.stop();
    },
  };
}

/** A Gamepad API pad from a recorded reading. */
function fakeGamepad(p: RecordedWebPad): Gamepad {
  return {
    index: p.index,
    id: p.id,
    mapping: p.mapping as GamepadMappingType,
    connected: true,
    timestamp: 0,
    buttons: p.buttons.map((value) => ({ value, pressed: value >= 0.5, touched: value > 0 })),
    axes: [...p.axes],
    vibrationActuator: null,
  } as unknown as Gamepad;
}
