import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DeviceEventSink } from "../input/devices";
import { loadInputMapping } from "../input/mapping";
import { fromHex, parseInputRecording, startInputRecording, tapNativeBatch, toHex, type InputRecording } from "../input/recording";
import { replayInputRecording } from "../input/replay";
import { applyNativeBatch, type NativeGamepadEvent } from "../input/tauriGamepads";
import { webGamepads } from "../input/webGamepads";
import type { Hid, HidCollectionInfo, HidConnectionEvent, HidDevice, HidInputReportEvent } from "../input/webHid/hidTypes";
import { webHidGamepads } from "../input/webHid/webHidGamepads";

// Hardware input recording and replay (ADR 0336 build notes, docs/plans/2026-11-input-hardware-checklist.md
// "Recording"): what the gamepad adapters receive is recorded at their boundary, and a recording replayed through the
// same adapters gives the sink the same events. Fake devices stand in for real ones: a DualSense and a Switch Pro over
// WebHID (set up before recording begins, so their setup exchange comes from what the adapter kept), an SDL pad's
// native batches, and a Gamepad API pad.

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 30) => {
  for (let i = 0; i < n; i++) await tick();
};

type Reply = (reportId: number, data: Uint8Array, device: FakeDevice) => void;

class FakeDevice implements HidDevice {
  opened = false;
  readonly collections: HidCollectionInfo[];
  private readonly listeners = new Set<(e: HidInputReportEvent) => void>();

  constructor(
    readonly vendorId: number,
    readonly productId: number,
    outputs: number[],
    private readonly features: Record<number, number[]> = {},
    private readonly reply?: Reply,
    readonly productName = "Fake pad",
  ) {
    this.collections = [{ outputReports: outputs.map((reportId) => ({ reportId })) }];
  }
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async sendReport(reportId: number, data: BufferSource) {
    this.reply?.(reportId, new Uint8Array((data as Uint8Array).slice()), this);
  }
  async sendFeatureReport() {}
  async receiveFeatureReport(reportId: number) {
    const f = this.features[reportId];
    if (!f) throw new Error("no such feature report");
    return new DataView(Uint8Array.from(f).buffer);
  }
  addEventListener(_type: "inputreport", l: (e: HidInputReportEvent) => void) {
    this.listeners.add(l);
  }
  removeEventListener(_type: "inputreport", l: (e: HidInputReportEvent) => void) {
    this.listeners.delete(l);
  }
  emit(reportId: number, bytes: Uint8Array) {
    for (const l of [...this.listeners]) l({ device: this, reportId, data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
  }
}

/** Every gamepad call that reaches the sink, in order. */
function sinkLog() {
  const log: unknown[][] = [];
  const none = () => {};
  const sink: DeviceEventSink = {
    keyDown: none,
    keyUp: none,
    buttonDown: none,
    buttonUp: none,
    pointerAt: none,
    move: none,
    scroll: none,
    releaseAll: none,
    touchStart: none,
    touchMove: none,
    touchEnd: none,
    penAt: none,
    penButtonDown: none,
    penButtonUp: none,
    penLeave: none,
    gamepadConnected: (info) => log.push(["connect", info.id, info.name, info.family ?? "generic"]),
    gamepadDisconnected: (id) => log.push(["disconnect", id]),
    gamepadButton: (id, i, v) => log.push(["button", id, i, v]),
    gamepadAxis: (id, i, v) => log.push(["axis", id, i, v]),
    gamepadSensor: (id, kind, x, y, z) => log.push(["sensor", id, kind, x, y, z]),
  };
  return { sink, log };
}

const bytes = (length: number, at: Record<number, number> = {}) => {
  const b = new Uint8Array(length);
  for (const [i, v] of Object.entries(at)) b[Number(i)] = v;
  return b;
};
const put16 = (b: Uint8Array | number[], at: number, v: number) => {
  b[at] = v & 0xff;
  b[at + 1] = (v >> 8) & 0xff;
};

/** A Sony calibration report body (gyro and accelerometer scales), as feature report 0x05 returns it with its id first. */
function sonyCalibration(): number[] {
  const b = new Array<number>(40).fill(0);
  for (let axis = 0; axis < 3; axis++) {
    put16(b, 6 + axis * 4, 8500);
    put16(b, 8 + axis * 4, -8500);
    put16(b, 22 + axis * 4, 8000);
    put16(b, 24 + axis * 4, -8400);
  }
  put16(b, 18, 500);
  put16(b, 20, 500);
  return [0x05, ...b];
}

/** A DualSense USB input report (0x01): left stick hard left and down, cross, hat right, L1, options. */
function dualSenseReport(cross: boolean) {
  const b = bytes(63);
  b.set([0, 255, 128, 128], 0);
  b[7] = (cross ? 0x20 : 0) | 2;
  b[8] = 0x01 | 0x20;
  return b;
}

/** Six 12-bit values packed into nine bytes, as the Switch's SPI calibration stores them. */
function pack12(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 6; i += 2) {
    const [a, c] = [values[i], values[i + 1]];
    out.push(a & 0xff, ((a >> 8) & 0x0f) | ((c & 0x0f) << 4), c >> 4);
  }
  return out;
}

/** A USB Switch Pro controller that answers the handshake and subcommands from its SPI flash. */
function fakeSwitch() {
  const spi = new Map<number, number>();
  const write = (address: number, data: number[]) => data.forEach((v, i) => spi.set(address + i, v));
  write(0x603d, [...pack12([1500, 1500, 2000, 2100, 1400, 1400]), ...pack12([2048, 2048, 1500, 1500, 1500, 1500])]);
  const reply: Reply = (id, data, device) => {
    if (id === 0x80 && data[0] !== 0x04) queueMicrotask(() => device.emit(0x81, bytes(63, { 0: data[0] })));
    else if (id === 0x01) {
      const r = bytes(48, { 12: 0x80, 13: data[9] });
      if (data[9] === 0x10) {
        const address = data[10] | (data[11] << 8) | (data[12] << 16) | (data[13] << 24);
        r.set(data.subarray(10, 15), 14);
        for (let i = 0; i < data[14]; i++) r[19 + i] = spi.get(address + i) ?? 0xff;
      }
      queueMicrotask(() => device.emit(0x21, r));
    }
  };
  return new FakeDevice(0x057e, 0x2009, [0x01, 0x10, 0x80], {}, reply, "Pro Controller");
}

/** A Switch full report (0x30): A held, left stick raw (3500, 1400), right centred. */
function switchReport() {
  const b = bytes(48, { 2: 0x08 });
  const stick = (o: number, x: number, y: number) => b.set([x & 0xff, ((x >> 8) & 0x0f) | ((y & 0x0f) << 4), y >> 4], o);
  stick(5, 3500, 1400);
  stick(8, 2048, 2048);
  return b;
}

function fakeHid(granted: HidDevice[]): Hid {
  return {
    getDevices: async () => granted,
    requestDevice: async () => [],
    addEventListener: (_type: string, _l: (e: HidConnectionEvent) => void) => {},
    removeEventListener: () => {},
  };
}

/** A Gamepad API pad whose readings the test changes. */
function webPad(index: number) {
  const buttons = Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false }));
  const axes = [0, 0, 0, 0];
  const pad = { index, id: "Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)", mapping: "standard", connected: true, buttons, axes, timestamp: 0 } as unknown as Gamepad;
  return { pad, press: (i: number, value: number) => (buttons[i] = { value, pressed: value >= 0.5, touched: value > 0 }), tilt: (i: number, v: number) => (axes[i] = v) };
}

const nativeConnect: NativeGamepadEvent = { t: "connect", id: 3, name: "Xbox Series X Controller", vendor: 0x045e, product: 0x0b12, family: 1, sensors: false, rumble: true, triggerRumble: true, led: false };

/**
 * Record a short session from every adapter: devices set up first (as they are when someone presses Record), then a
 * few presses on each. Returns the recording (through JSON, as a file holds it) and what the live sink saw meanwhile.
 */
async function recordSession(): Promise<{ recording: InputRecording; live: unknown[][] }> {
  const live = sinkLog();
  const ds = new FakeDevice(0x054c, 0x0ce6, [0x02], { 0x05: sonyCalibration() }, undefined, "DualSense Wireless Controller");
  const sw = fakeSwitch();
  const xbox = webPad(0);
  const pads: (Gamepad | null)[] = [xbox.pad];
  const nav = { hid: fakeHid([ds, sw]), userAgent: "Mozilla/5.0 (X11; Linux x86_64)", getGamepads: () => pads } as unknown as Navigator;
  const hid = webHidGamepads(live.sink, nav)!;
  const web = webGamepads(live.sink, nav, (p) => hid.owns(p))!;
  const batch = (b: NativeGamepadEvent[]) => {
    tapNativeBatch(b); // as the SDL adapter's channel does with each batch
    applyNativeBatch(live.sink, b);
  };
  batch([nativeConnect]);
  await loadInputMapping();
  web.poll();
  await settle();
  web.poll();
  expect(live.log.filter((e) => e[0] === "connect").map((e) => e[2])).toEqual(expect.arrayContaining(["DualSense Wireless Controller", "Pro Controller", "Xbox Series X Controller", xbox.pad.id]));

  live.log.length = 0;
  const recorder = startInputRecording();
  ds.emit(0x01, dualSenseReport(true));
  sw.emit(0x30, switchReport());
  xbox.press(0, 1);
  xbox.tilt(1, -0.75);
  web.poll();
  web.poll(); // unchanged: not recorded again
  batch([{ t: "button", id: 3, index: 1, value: 1, time: 5000 }, { t: "axis", id: 3, index: 4, value: 0.5, time: 5001 }]);
  ds.emit(0x01, dualSenseReport(false));
  xbox.press(0, 0);
  web.poll();
  batch([{ t: "disconnect", id: 3 }]);
  const recording = JSON.parse(JSON.stringify(recorder.stop())) as InputRecording;
  hid.stop();
  web.stop();
  return { recording, live: live.log.filter((e) => e[0] !== "disconnect" || e[1] === 3) };
}

describe("input recording (recording.ts)", () => {
  it("keeps raw reports, native batches and changed Gamepad API readings, with the HID devices' setup", async () => {
    const { recording } = await recordSession();
    expect(parseInputRecording(recording)).toBe(recording);
    expect(recording).toMatchObject({ format: "myco-input-recording", version: 1, web: { platform: "linux" }, native: { pads: [nativeConnect] } });
    const [ds, sw] = recording.hid;
    expect(ds).toMatchObject({ name: "DualSense Wireless Controller", vendor: 0x054c, product: 0x0ce6, at: 0, collections: [{ outputReports: [{ reportId: 0x02 }] }] });
    expect(ds.features).toEqual([{ report: 0x05, data: toHex(sonyCalibration()) }]);
    // The Switch's handshake and subcommands, each with its reply.
    expect(sw.setup.filter((s) => s.t === "out").length).toBeGreaterThanOrEqual(10);
    expect(sw.setup.filter((s) => s.t === "in" && s.report === 0x21).length).toBeGreaterThanOrEqual(6);
    const kinds = recording.events.map((e) => ("hid" in e ? `hid${e.hid}:${e.report}` : "native" in e ? `native${e.native.length}` : `web${e.web.length}`));
    expect(kinds).toEqual(["hid0:1", "hid1:48", "web1", "native2", "hid0:1", "web1", "native1"]);
    const first = recording.events[0];
    expect("hid" in first && fromHex(first.data)).toEqual(dualSenseReport(true));
    expect(recording.events.every((e, i, all) => e.time >= 0 && (i === 0 || e.time >= all[i - 1].time))).toBe(true);
  });

  it("refuses a file that isn't a recording, or a later version", () => {
    expect(() => parseInputRecording({ format: "something" })).toThrow(/Not an input recording/);
    expect(() => parseInputRecording({ format: "myco-input-recording", version: 2, events: [], hid: [] })).toThrow(/version 2/);
  });
});

describe("input replay (replay.ts)", () => {
  it("replays a recording through the same adapters: the sink gets what it got live", async () => {
    const { recording, live } = await recordSession();
    const replayed = sinkLog();
    const replay = replayInputRecording(recording, replayed.sink);
    await replay.ready;
    // Set up again from the recording: the HID pads (calibrated from the recorded replies) and the native pad.
    expect(replayed.log.filter((e) => e[0] === "connect").map((e) => e[2])).toEqual(expect.arrayContaining(["DualSense Wireless Controller", "Pro Controller", "Xbox Series X Controller"]));
    replayed.log.length = 0;
    await replay.finish();
    replay.stop();
    // The Gamepad API pad was connected before recording began; replayed, it connects with its first reading.
    const inputs = (log: unknown[][]) => log.filter((e) => e[0] !== "connect" && (e[0] !== "disconnect" || e[1] === 3));
    expect(replayed.log.filter((e) => e[0] === "connect").map((e) => e[3])).toEqual(["xbox"]);
    expect(inputs(replayed.log)).toEqual(inputs(live));
  });

  it("replays the committed sample recording (fixtures/input/sample.input-recording.json)", async () => {
    const file = fileURLToPath(new URL("./fixtures/input/sample.input-recording.json", import.meta.url));
    const recording = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const { sink, log } = sinkLog();
    const replay = replayInputRecording(recording, sink);
    await replay.ready;
    const connected = new Map(log.filter((e) => e[0] === "connect").map((e) => [e[2] as string, { id: e[1] as number, family: e[3] }]));
    const dualSense = connected.get("DualSense Wireless Controller")!;
    const proController = connected.get("Pro Controller")!;
    expect(dualSense.family).toBe("playstation");
    expect(proController.family).toBe("switch");
    expect(connected.get("Xbox Series X Controller")).toEqual({ id: 3, family: "xbox" });
    log.length = 0;
    await replay.advanceTo(replay.duration / 2);
    await replay.finish();
    replay.stop();
    const has = (...e: unknown[]) => expect(log).toContainEqual(e);
    // DualSense: cross (buttonSouth) down then up, left stick hard left and down, d-pad right, L1, options.
    has("button", dualSense.id, 0, 1);
    has("button", dualSense.id, 0, 0);
    has("axis", dualSense.id, 0, -1);
    has("axis", dualSense.id, 1, 1);
    has("button", dualSense.id, 15, 1);
    has("button", dualSense.id, 4, 1);
    has("button", dualSense.id, 9, 1);
    // Switch Pro: A is buttonEast; the left stick through the calibration read during setup (full right, half down).
    has("button", proController.id, 1, 1);
    has("axis", proController.id, 0, 1);
    expect(log.find((e) => e[0] === "axis" && e[1] === proController.id && e[2] === 1)?.[3]).toBeCloseTo(0.5, 5);
    // SDL: buttonEast and the left trigger axis, then the pad goes.
    has("button", 3, 1, 1);
    has("axis", 3, 4, 0.5);
    has("disconnect", 3);
    // Gamepad API: buttonSouth pressed with the left stick up, then released.
    const xbox = log.find((e) => e[0] === "connect" && e[3] === "xbox" && e[1] !== 3);
    expect(xbox).toBeDefined();
    has("button", xbox![1], 0, 1);
    has("axis", xbox![1], 1, -0.75);
    has("button", xbox![1], 0, 0);
  });
});
