import { describe, expect, it } from "vitest";
import { Input } from "../input/Input";
import type { DeviceEventSink, GamepadInfo, GamepadOutput } from "../input/devices";
import { loadInputMapping } from "../input/mapping";
import { webGamepads } from "../input/webGamepads";
import { crc32 } from "../input/webHid/crc32";
import type { HidPadDriver, HidPadFactory, HidPadLink } from "../input/webHid/driver";
import { dualSense } from "../input/webHid/dualSense";
import { dualShock4 } from "../input/webHid/dualShock4";
import type { Hid, HidCollectionInfo, HidConnectionEvent, HidDevice, HidDeviceFilter, HidInputReportEvent } from "../input/webHid/hidTypes";
import { switchPro } from "../input/webHid/switchPro";
import { webHidGamepads } from "../input/webHid/webHidGamepads";

// WebHID gamepads (ADR 0335 build notes): each family's driver through its own interface, and the
// adapter through its, with fake HID devices that emit constructed reports and record output.

const G = 9.80665;
const RAD = Math.PI / 180;
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Reply = (reportId: number, data: Uint8Array, device: FakeDevice) => void;

class FakeDevice implements HidDevice {
  opened = false;
  failOpen = false;
  readonly sent: { id: number; data: Uint8Array }[] = [];
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

  readonly collections: HidCollectionInfo[];

  async open() {
    if (this.failOpen) throw new Error("NotAllowedError");
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async sendReport(reportId: number, data: BufferSource) {
    const bytes = new Uint8Array((data as Uint8Array).slice());
    this.sent.push({ id: reportId, data: bytes });
    this.reply?.(reportId, bytes, this);
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
  last(id: number): Uint8Array {
    const all = this.sent.filter((s) => s.id === id);
    return all[all.length - 1].data;
  }
}

/** What reached the snapshot: the latest value of each control, sensors, and a log. */
function recorder() {
  const log: unknown[][] = [];
  const buttons = new Map<string, number>();
  const axes = new Map<string, number>();
  const sensors = new Map<string, number[]>();
  const infos: GamepadInfo[] = [];
  const sink: DeviceEventSink = {
    keyDown: () => {},
    keyUp: () => {},
    buttonDown: () => {},
    buttonUp: () => {},
    pointerAt: () => {},
    move: () => {},
    scroll: () => {},
    releaseAll: () => {},
    touchStart: () => {},
    touchMove: () => {},
    touchEnd: () => {},
    penAt: () => {},
    penButtonDown: () => {},
    penButtonUp: () => {},
    penLeave: () => {},
    gamepadConnected: (info) => (infos.push(info), log.push(["connect", info.id, info.family])),
    gamepadDisconnected: (id) => log.push(["disconnect", id]),
    gamepadButton: (id, i, v) => (buttons.set(`${id}:${i}`, v), log.push(["button", id, i, v])),
    gamepadAxis: (id, i, v) => (axes.set(`${id}:${i}`, v), log.push(["axis", id, i, v])),
    gamepadSensor: (id, kind, x, y, z) => (sensors.set(`${id}:${kind}`, [x, y, z]), log.push(["sensor", id, kind])),
  };
  return { sink, log, buttons, axes, sensors, infos };
}

/** Start a family's driver on `device` with a link that reports to a recorder as pad 1. */
async function startDriver(factory: HidPadFactory, device: FakeDevice, slot = 0) {
  const rec = recorder();
  let present = false;
  const link: HidPadLink = {
    id: 1,
    sink: rec.sink,
    slot,
    connected: (info) => ((present = true), rec.sink.gamepadConnected({ ...info, id: 1 })),
    disconnected: () => ((present = false), rec.sink.gamepadDisconnected(1)),
  };
  const driver: HidPadDriver = factory(device, link);
  device.addEventListener("inputreport", (e) => driver.report(e.reportId, e.data));
  await driver.start();
  return { driver, ...rec, present: () => present };
}

function bytes(length: number, at: Record<number, number> = {}): Uint8Array {
  const b = new Uint8Array(length);
  for (const [i, v] of Object.entries(at)) b[Number(i)] = v;
  return b;
}

function put16(b: Uint8Array | number[], at: number, v: number) {
  b[at] = v & 0xff;
  b[at + 1] = (v >> 8) & 0xff;
}

const le32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** A Sony calibration report body: gyro 100 deg/s per 1700 steps from bias, accelerometer 1 g per 8200 steps from -200. */
function sonyCalibration(layout: "interleaved" | "grouped"): number[] {
  const b = new Array<number>(40).fill(0);
  const bias = [10, -5, 0];
  bias.forEach((v, i) => put16(b, i * 2, v));
  for (let axis = 0; axis < 3; axis++) {
    const plus = bias[axis] + 8500;
    const minus = bias[axis] - 8500;
    if (layout === "interleaved") {
      put16(b, 6 + axis * 4, plus);
      put16(b, 8 + axis * 4, minus);
    } else {
      put16(b, 6 + axis * 2, plus);
      put16(b, 12 + axis * 2, minus);
    }
    put16(b, 22 + axis * 4, 8000);
    put16(b, 24 + axis * 4, -8400);
  }
  put16(b, 18, 500);
  put16(b, 20, 500);
  return b;
}

/** With its report id first, as some browsers return feature reports. */
const withId = (id: number, body: number[], fullLength: number) => [id, ...body, ...new Array(Math.max(0, fullLength - 1 - body.length)).fill(0)].slice(0, fullLength);

/** Write a Bluetooth input report's CRC (header 0xA1). */
function sealInput(reportId: number, b: Uint8Array): Uint8Array {
  const crc = crc32(b.subarray(0, b.length - 4), crc32([0xa1, reportId]));
  b[b.length - 4] = crc & 0xff;
  b[b.length - 3] = (crc >>> 8) & 0xff;
  b[b.length - 2] = (crc >>> 16) & 0xff;
  b[b.length - 1] = (crc >>> 24) & 0xff;
  return b;
}

/** An output report's CRC is right (header 0xA2). */
function outputCrcOk(reportId: number, b: Uint8Array): boolean {
  return le32(b, b.length - 4) === crc32(b.subarray(0, b.length - 4), crc32([0xa2, reportId]));
}

describe("crc32", () => {
  it("is zlib's CRC-32, continued across pieces", () => {
    const digits = Array.from("123456789", (c) => c.charCodeAt(0));
    expect(crc32(digits)).toBe(0xcbf43926);
    expect(crc32(digits.slice(4), crc32(digits.slice(0, 4)))).toBe(0xcbf43926);
    expect(crc32([])).toBe(0);
  });
});

/** A DualSense state block (sticks, triggers, buttons, motion) at `o` in `b`. */
function dualSenseState(b: Uint8Array, o: number, s: { gyro?: number[]; accel?: number[]; time?: number } = {}) {
  b.set([0, 255, 128, 128], o); // left stick hard left and down; right centred
  b[o + 4] = 0; // L2 analog 0, but its digital bit is set below
  b[o + 5] = 255;
  b[o + 7] = 0x20 | 2; // cross, hat right
  b[o + 8] = 0x01 | 0x04 | 0x20; // L1, L2 digital, options
  b[o + 9] = 0x02 | 0x04 | 0x40; // touchpad click, mute, Edge left paddle
  (s.gyro ?? [0, 0, 0]).forEach((v, i) => put16(b, o + 15 + i * 2, v));
  (s.accel ?? [0, 0, 0]).forEach((v, i) => put16(b, o + 21 + i * 2, v));
  const t = s.time ?? 0;
  b[o + 27] = t & 0xff;
  b[o + 28] = (t >>> 8) & 0xff;
  b[o + 29] = (t >>> 16) & 0xff;
  b[o + 30] = (t >>> 24) & 0xff;
  return b;
}

describe("DualSense (dualSense.ts)", () => {
  it("USB: reports sticks, buttons, the hat, triggers and extras on the wire indices", async () => {
    const device = new FakeDevice(0x054c, 0x0ce6, [0x02], { 0x05: withId(0x05, sonyCalibration("interleaved"), 41) });
    const pad = await startDriver(dualSense, device);
    expect(pad.infos[0]).toMatchObject({ id: 1, family: "playstation", vendor: 0x054c, product: 0x0ce6, sensors: true, triggerRumble: true, led: true });
    device.emit(0x01, dualSenseState(bytes(63), 0));
    const b = (i: number) => pad.buttons.get(`1:${i}`) ?? 0;
    expect([pad.axes.get("1:0"), pad.axes.get("1:1"), pad.axes.get("1:2") ?? 0]).toEqual([-1, 1, 0]);
    expect([b(0), b(1), b(4), b(6), b(7), b(9)]).toEqual([1, 0, 1, 1, 1, 1]); // L2 at 0 with its digital bit: fully pulled
    expect([b(12), b(13), b(14), b(15)]).toEqual([0, 0, 0, 1]);
    expect([b(22), b(17), b(19), b(16)]).toEqual([1, 1, 1, 0]); // touchpadPress, misc1 (mute), leftPaddle1
    // Only changes are reported.
    pad.log.length = 0;
    device.emit(0x01, dualSenseState(bytes(63), 0));
    expect(pad.log).toEqual([]);
  });

  it("USB: scales gyro and accelerometer through the factory calibration, only while sensors are on", async () => {
    const device = new FakeDevice(0x054c, 0x0ce6, [0x02], { 0x05: withId(0x05, sonyCalibration("interleaved"), 41) });
    const pad = await startDriver(dualSense, device);
    const state = dualSenseState(bytes(63), 0, { gyro: [10 + 1700, -5 - 1700, 0], accel: [-200 + 8200, -200, -200 - 8200] });
    device.emit(0x01, state);
    expect(pad.sensors.size).toBe(0);
    pad.driver.output.setSensors(true);
    device.emit(0x01, state);
    const gyro = pad.sensors.get("1:gyro")!;
    const accel = pad.sensors.get("1:accel")!;
    [100 * RAD, -100 * RAD, 0].forEach((v, i) => expect(gyro[i]).toBeCloseTo(v, 4));
    [G, 0, -G].forEach((v, i) => expect(accel[i]).toBeCloseTo(v, 4));
  });

  it("USB output: lights at start, then rumble, adaptive triggers and trigger rumble in report 0x02", async () => {
    const device = new FakeDevice(0x054c, 0x0ce6, [0x02]);
    const pad = await startDriver(dualSense, device, 1);
    const first = device.last(0x02);
    expect(first.length).toBe(47);
    expect(first[1] & 0x14).toBe(0x14); // light bar and player lights
    expect([...first.subarray(43, 47)]).toEqual([0x0a | 0x20, 0x40, 0x00, 0x00]); // second slot: two lights, red
    pad.driver.output.rumble(0.5, 1, 10);
    let e = device.last(0x02);
    expect([e[0] & 0x03, e[2], e[3]]).toEqual([0x03, 127, 64]); // right (high) and left (low) motors, halved as SDL does
    await sleep(30);
    e = device.last(0x02);
    expect([e[2], e[3]]).toEqual([0, 0]);
    pad.driver.output.setLed!(255, 128, 0);
    expect([...device.last(0x02).subarray(44, 47)]).toEqual([255, 128, 0]);
    pad.driver.output.triggerEffect!("right", { mode: "weapon", start: 0.3, end: 0.6, strength: 1 });
    e = device.last(0x02);
    expect(e[0] & 0x0c).toBe(0x04);
    expect([...e.subarray(10, 21)]).toEqual([0x25, 0x28, 0, 7, 0, 0, 0, 0, 0, 0, 0]);
    pad.driver.output.triggerEffect!("left", { mode: "resistance", start: 0, strength: 0.5 });
    e = device.last(0x02);
    expect([...e.subarray(21, 28)]).toEqual([0x21, 0xff, 0x03, 0xdb, 0xb6, 0x6d, 0x1b]); // force 3 (strength 4 of 8) in all ten zones
    pad.driver.output.triggerRumble!(0, 1, 10);
    e = device.last(0x02);
    expect([...e.subarray(10, 21)]).toEqual([0x26, 0xff, 0x03, 0xff, 0xff, 0xff, 0x3f, 0, 0, 50, 0]);
    expect(e[21]).toBe(0x21); // the left trigger keeps its effect
    await sleep(30);
    expect(device.last(0x02)[10]).toBe(0x25); // trigger rumble over: the game's weapon effect is back
    pad.driver.stop();
    e = device.last(0x02);
    expect([e[10], e[21]]).toEqual([0x05, 0x05]); // triggers freed
  });

  it("Bluetooth: report 0x31 with its CRC; output 0x31 sealed; lights wait for the connection to settle", async () => {
    const device = new FakeDevice(0x054c, 0x0ce6, [0x31], { 0x05: withId(0x05, sonyCalibration("interleaved"), 41) });
    const pad = await startDriver(dualSense, device);
    const first = device.last(0x31);
    expect(first.length).toBe(77);
    expect(first[1]).toBe(0x10);
    expect(first[2 + 1]).toBe(0); // no light changes yet
    expect(outputCrcOk(0x31, first)).toBe(true);
    device.emit(0x31, sealInput(0x31, dualSenseState(bytes(77), 1, { time: 1000 })));
    expect(pad.buttons.get("1:0")).toBe(1);
    expect(pad.axes.get("1:0")).toBe(-1);
    const before = device.sent.length;
    device.emit(0x31, sealInput(0x31, dualSenseState(bytes(77), 1, { time: 10200000 })));
    const [reset, lights] = device.sent.slice(before).map((s) => s.data);
    expect(reset[2 + 1] & 0x08).toBe(0x08);
    expect(lights[2 + 1] & 0x0c).toBe(0x04);
    expect([lights[2 + 44], lights[2 + 45], lights[2 + 46]]).toEqual([0, 0, 0x40]);
    expect(outputCrcOk(0x31, reset) && outputCrcOk(0x31, lights)).toBe(true);
    expect(reset[0] >> 4).not.toBe(lights[0] >> 4); // sequence numbers advance
    // Once three good reports have arrived, one with a bad CRC is dropped.
    device.emit(0x31, sealInput(0x31, dualSenseState(bytes(77), 1, { time: 10250000 })));
    pad.log.length = 0;
    const bad = sealInput(0x31, dualSenseState(bytes(77), 1, { time: 10300000 }));
    bad[1] = 128; // left stick centred, CRC now wrong
    device.emit(0x31, bad);
    expect(pad.log).toEqual([]);
  });

  it("Bluetooth simple mode: reads report 0x01's nine bytes and switches the pad to full reports", async () => {
    const device = new FakeDevice(0x054c, 0x0df2, []); // no descriptor: transport learned from the reports
    const pad = await startDriver(dualSense, device);
    expect(pad.infos[0].name).toContain("Edge");
    device.emit(0x01, bytes(9, { 0: 128, 1: 0, 2: 128, 3: 128, 4: 0x80 | 8, 5: 0x02, 6: 0x01, 7: 51, 8: 0 }));
    expect([pad.axes.get("1:1"), pad.buttons.get("1:3"), pad.buttons.get("1:5"), pad.buttons.get("1:16"), pad.buttons.get("1:6")]).toEqual([-1, 1, 1, 1, 0.2]);
    const switched = device.last(0x31);
    expect(switched.length).toBe(77);
    expect(outputCrcOk(0x31, switched)).toBe(true);
  });
});

/** A DualShock 4 state block at `o`. */
function dualShock4State(b: Uint8Array, o: number, s: { gyro?: number[]; accel?: number[] } = {}) {
  b.set([255, 128, 128, 0], o);
  b[o + 4] = 0x80 | 0x40 | 6; // triangle, circle, hat left
  b[o + 5] = 0x02 | 0x10 | 0x80; // R1, share, R3
  b[o + 6] = 0x01 | 0x02 | 0xfc; // PS, touchpad, counter bits
  b[o + 7] = 255;
  b[o + 8] = 0;
  (s.gyro ?? [0, 0, 0]).forEach((v, i) => put16(b, o + 12 + i * 2, v));
  (s.accel ?? [0, 0, 0]).forEach((v, i) => put16(b, o + 18 + i * 2, v));
  return b;
}

describe("DualShock 4 (dualShock4.ts)", () => {
  it("USB: buttons, hat, triggers, calibrated motion, and output report 0x05", async () => {
    const device = new FakeDevice(0x054c, 0x09cc, [0x05], { 0x02: withId(0x02, sonyCalibration("interleaved"), 37) });
    const pad = await startDriver(dualShock4, device);
    expect(pad.infos[0]).toMatchObject({ family: "playstation", led: true, triggerRumble: false });
    pad.driver.output.setSensors(true);
    device.emit(0x01, dualShock4State(bytes(63), 0, { gyro: [10 + 1700, 0, 0], accel: [0, -200 + 8200, 0] }));
    const b = (i: number) => pad.buttons.get(`1:${i}`) ?? 0;
    expect([pad.axes.get("1:0"), pad.axes.get("1:3")]).toEqual([1, -1]);
    expect([b(1), b(3), b(5), b(8), b(11), b(16), b(22), b(14), b(6)]).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(b(17)).toBe(0); // the counter bits aren't buttons
    expect(pad.sensors.get("1:gyro")![0]).toBeCloseTo(100 * RAD, 4);
    expect(pad.sensors.get("1:accel")![1]).toBeCloseTo(G, 4);
    const start = device.last(0x05);
    expect([start.length, start[0], start[5], start[6], start[7]]).toEqual([31, 0x03, 0, 0, 0x40]);
    pad.driver.output.rumble(1, 0.5, 100);
    pad.driver.output.setLed!(255, 0, 128);
    expect([...device.last(0x05).subarray(3, 8)]).toEqual([128, 255, 255, 0, 128]);
    pad.driver.stop();
    expect([...device.last(0x05).subarray(3, 5)]).toEqual([0, 0]);
  });

  it("without calibration, uses Sony's nominal scales", async () => {
    const device = new FakeDevice(0x054c, 0x05c4, [0x05]);
    const pad = await startDriver(dualShock4, device);
    pad.driver.output.setSensors(true);
    device.emit(0x01, dualShock4State(bytes(63), 0, { gyro: [160, 0, -16], accel: [8192, 0, 0] }));
    const gyro = pad.sensors.get("1:gyro")!;
    expect(gyro[0]).toBeCloseTo(10 * RAD, 5);
    expect(gyro[2]).toBeCloseTo(-1 * RAD, 5);
    expect(pad.sensors.get("1:accel")![0]).toBeCloseTo(G, 5);
  });

  it("Bluetooth: report 0x11 (grouped calibration), output 0x11 with its CRC", async () => {
    const device = new FakeDevice(0x054c, 0x05c4, [0x11], { 0x05: withId(0x05, sonyCalibration("grouped"), 41) });
    const pad = await startDriver(dualShock4, device);
    pad.driver.output.setSensors(true);
    const report = dualShock4State(bytes(77), 2, { gyro: [0, -5 + 1700, 0] });
    report[0] = 0xc0;
    device.emit(0x11, sealInput(0x11, report));
    expect(pad.buttons.get("1:3")).toBe(1);
    expect(pad.sensors.get("1:gyro")![1]).toBeCloseTo(100 * RAD, 4);
    pad.driver.output.rumble(0.25, 0, 50);
    const out = device.last(0x11);
    expect([out.length, out[0], out[2], out[5], out[6], out[9]]).toEqual([77, 0xc4, 0x03, 0, 64, 0x40]);
    expect(outputCrcOk(0x11, out)).toBe(true);
  });

  it("the wireless adapter: reports a pad only while a controller is paired with it", async () => {
    const device = new FakeDevice(0x054c, 0x0ba0, [0x05]);
    const pad = await startDriver(dualShock4, device);
    expect(pad.present()).toBe(false);
    const absent = dualShock4State(bytes(63), 0);
    absent[30] = 0x04;
    device.emit(0x01, absent);
    expect(pad.log).toEqual([]);
    device.emit(0x01, dualShock4State(bytes(63), 0));
    expect(pad.present()).toBe(true);
    expect(pad.buttons.get("1:3")).toBe(1);
    device.emit(0x01, absent);
    expect(pad.log[pad.log.length - 1]).toEqual(["disconnect", 1]);
  });
});

/** Six 12-bit values packed into nine bytes, as the Switch's SPI calibration stores them. */
function pack12(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 6; i += 2) {
    const [a, c] = [values[i], values[i + 1]];
    out.push(a & 0xff, ((a >> 8) & 0x0f) | ((c & 0x0f) << 4), c >> 4);
  }
  return out;
}

/** A Switch Pro controller that answers the handshake and subcommands, with SPI flash contents. */
function fakeSwitch(usb: boolean) {
  const spi = new Map<number, number>();
  const write = (address: number, data: number[]) => data.forEach((v, i) => spi.set(address + i, v));
  // Factory sticks: left (max above, centre, min below), right (centre, min, max).
  write(0x603d, [...pack12([1500, 1500, 2000, 2100, 1400, 1400]), ...pack12([2048, 2048, 1500, 1500, 1500, 1500])]);
  // Factory IMU: accelerometer origin 0 and coefficient 16384; gyro origin 10, 20, 30 with coefficients 13371 above.
  const imu: number[] = [];
  [0, 0, 0, 16384, 16384, 16384, 10, 20, 30, 13381, 13391, 13401].forEach((v, i) => put16(imu, i * 2, v));
  write(0x6020, imu);
  const reply: Reply = (id, data, device) => {
    if (id === 0x80 && data[0] !== 0x04) {
      queueMicrotask(() => device.emit(0x81, bytes(63, { 0: data[0] })));
    } else if (id === 0x01) {
      const r = bytes(48, { 12: 0x80, 13: data[9] });
      if (data[9] === 0x10) {
        const address = data[10] | (data[11] << 8) | (data[12] << 16) | (data[13] << 24);
        r.set(data.subarray(10, 15), 14);
        for (let i = 0; i < data[14]; i++) r[19 + i] = spi.get(address + i) ?? 0xff;
      }
      queueMicrotask(() => device.emit(0x21, r));
    }
  };
  return new FakeDevice(0x057e, 0x2009, usb ? [0x01, 0x10, 0x80] : [0x01, 0x10], {}, reply, "Pro Controller");
}

/** A Switch full report (0x30): A, capture, d-pad up, ZL; sticks raw; IMU sample 0. */
function switchState(left: [number, number], right: [number, number], imu: { accel?: number[]; gyro?: number[] } = {}) {
  const b = bytes(48, { 2: 0x08, 3: 0x20, 4: 0x02 | 0x80 });
  const stick = (o: number, [x, y]: [number, number]) => b.set([x & 0xff, ((x >> 8) & 0x0f) | ((y & 0x0f) << 4), y >> 4], o);
  stick(5, left);
  stick(8, right);
  (imu.accel ?? [0, 0, 0]).forEach((v, i) => put16(b, 12 + i * 2, v));
  (imu.gyro ?? [0, 0, 0]).forEach((v, i) => put16(b, 18 + i * 2, v));
  return b;
}

describe("Switch Pro Controller (switchPro.ts)", () => {
  it("USB: the handshake, calibration reads, vibration, full reports and player lights, in order", async () => {
    const device = fakeSwitch(true);
    const pad = await startDriver(switchPro, device, 2);
    expect(pad.infos[0]).toMatchObject({ name: "Pro Controller", family: "switch", sensors: true, rumble: true, led: false });
    const steps = device.sent.map((s) => (s.id === 0x80 ? `usb ${s.data[0]}` : s.id === 0x01 ? `sub ${s.data[9].toString(16)}` : `report ${s.id}`));
    expect(steps).toEqual(["usb 2", "usb 3", "usb 2", "usb 4", "sub 10", "sub 10", "sub 10", "sub 10", "sub 48", "sub 3", "sub 30", "usb 4"]);
    const subs = device.sent.filter((s) => s.id === 0x01);
    expect(subs[0].data.length).toBe(63);
    expect([...subs[0].data.subarray(10, 15)]).toEqual([0x3d, 0x60, 0, 0, 18]); // SPI read: address, size
    expect([...subs[0].data.subarray(1, 9)]).toEqual([0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40]); // neutral rumble
    expect(subs.map((s) => s.data[0])).toEqual([0, 1, 2, 3, 4, 5, 6]); // packet counter
    expect(subs[5].data[10]).toBe(0x30);
    expect(subs[6].data[10]).toBe(0x7); // third slot: three lights
  });

  it("reports buttons by position, calibrated sticks (+Y down on the wire) and the IMU in SDL's axes", async () => {
    const device = fakeSwitch(true);
    const pad = await startDriver(switchPro, device);
    device.emit(0x30, switchState([3500, 1400], [2048, 2048]));
    const b = (i: number) => pad.buttons.get(`1:${i}`) ?? 0;
    expect([b(1), b(0), b(17), b(12), b(6), b(7)]).toEqual([1, 0, 1, 1, 1, 0]); // A is buttonEast; capture is misc1
    expect(pad.axes.get("1:0")).toBe(1);
    expect(pad.axes.get("1:1")).toBeCloseTo(0.5, 5); // 700 below a 2100 centre with a 1400 range: half down
    expect(pad.axes.get("1:2") ?? 0).toBe(0);
    expect(pad.sensors.size).toBe(0);
    pad.driver.output.setSensors(true);
    await tick();
    const enable = device.sent.filter((s) => s.id === 0x01).pop()!.data;
    expect([enable[9], enable[10]]).toEqual([0x40, 1]);
    device.emit(0x30, switchState([2000, 2100], [2048, 2048], { accel: [0, 0, 4096], gyro: [10 + 1337, 20, 30 - 1337] }));
    const accel = pad.sensors.get("1:accel")!;
    [0, 0, 0].forEach((_, i) => expect(accel[i]).toBeCloseTo([0, G, 0][i], 4)); // z up on the pad is +Y
    const gyro = pad.sensors.get("1:gyro")!;
    const dps = (1337 * 936) / 13371;
    expect(gyro[0]).toBeCloseTo(0, 6);
    expect(gyro[1]).toBeCloseTo(-dps * RAD, 4);
    expect(gyro[2]).toBeCloseTo(-dps * RAD, 4);
  });

  it("Bluetooth: no handshake, 48-byte reports; rumble in report 0x10, neutral when it ends", async () => {
    const device = fakeSwitch(false);
    const pad = await startDriver(switchPro, device);
    expect(device.sent.some((s) => s.id === 0x80)).toBe(false);
    expect(device.sent[0].data.length).toBe(48);
    pad.driver.output.rumble(1, 1, 10);
    expect([...device.last(0x10).subarray(1, 9)]).toEqual([0x74, 0xc8, 0x3d, 0x72, 0x74, 0xc8, 0x3d, 0x72]);
    pad.driver.output.rumble(0, 0.5, 1000);
    const half = device.last(0x10);
    expect([half[1], half[2], half[3], half[4]]).toEqual([0x74, 2 * 68, 0x3d, 0x40]); // high band only
    pad.driver.output.rumble(0.5, 0, 10);
    await sleep(30);
    expect([...device.last(0x10).subarray(1, 9)]).toEqual([0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40]);
  });
});

/** A fake `navigator.hid` with granted devices and a chooser that picks `chooser`. */
function fakeHid(granted: FakeDevice[], chooser: FakeDevice[] | Error = []) {
  const listeners = { connect: new Set<(e: HidConnectionEvent) => void>(), disconnect: new Set<(e: HidConnectionEvent) => void>() };
  const filters: HidDeviceFilter[][] = [];
  const hid: Hid = {
    getDevices: async () => granted,
    requestDevice: async ({ filters: f }) => {
      filters.push(f);
      if (chooser instanceof Error) throw chooser;
      return chooser;
    },
    addEventListener: (type, l) => listeners[type].add(l),
    removeEventListener: (type, l) => listeners[type].delete(l),
  };
  const fire = (type: "connect" | "disconnect", device: FakeDevice) => listeners[type].forEach((l) => l({ device }));
  return { hid, fire, filters, listeners };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

const sonyPad = (index: number) =>
  ({ index, id: "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)", mapping: "standard", connected: true, buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })), axes: [0, 0, 0, 0], timestamp: 0 }) as unknown as Gamepad;
const xboxPad = (index: number) =>
  ({ index, id: "Xbox 360 Controller (STANDARD GAMEPAD Vendor: 045e Product: 028e)", mapping: "standard", connected: true, buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false, touched: false })), axes: [0, 0, 0, 0], timestamp: 0 }) as unknown as Gamepad;

describe("the WebHID adapter (webHidGamepads.ts)", () => {
  it("doesn't exist without navigator.hid; Input.requestHidGamepads resolves 0 there", async () => {
    expect(webHidGamepads(recorder().sink, { getGamepads: () => [] } as unknown as Navigator)).toBeNull();
    await expect(Input.requestHidGamepads()).resolves.toBe(0);
  });

  it("reopens granted devices, reports them under its own ids, and the Gamepad API skips them until they go", async () => {
    const ds = new FakeDevice(0x054c, 0x0ce6, [0x02]);
    const other = new FakeDevice(0x1234, 0x5678, []); // granted but not a controller it knows
    const { hid, fire } = fakeHid([ds, other]);
    const rec = recorder();
    const pads = [sonyPad(0), xboxPad(1)];
    const nav = { hid, getGamepads: () => pads, userAgent: "Linux" } as unknown as Navigator;
    const adapter = webHidGamepads(rec.sink, nav)!;
    await settle();
    expect(ds.opened && !other.opened).toBe(true);
    const id = rec.infos[0].id;
    expect(id).toBeGreaterThanOrEqual(0x4000);
    expect(rec.infos[0].family).toBe("playstation");
    ds.emit(0x01, dualSenseState(bytes(63), 0));
    expect(rec.buttons.get(`${id}:0`)).toBe(1);

    // The Gamepad API adapter, skipping what WebHID owns: only the Xbox pad.
    const web = webGamepads(rec.sink, nav, (p) => adapter.owns(p))!;
    web.poll();
    await loadInputMapping();
    await tick();
    rec.log.length = 0;
    web.poll();
    expect(rec.log.filter((e) => e[0] === "connect")).toEqual([["connect", 1, "xbox"]]);

    // Unplugged from WebHID (or failed): the Gamepad API reports the DualSense again.
    rec.log.length = 0;
    fire("disconnect", ds);
    web.poll();
    expect(rec.log).toEqual([["disconnect", id], ["connect", 0, "playstation"]]);
    web.stop();
    adapter.stop();
  });

  it("with two identical pads and one opened over WebHID, the Gamepad API skips only the first", async () => {
    const ds = new FakeDevice(0x054c, 0x0ce6, [0x02]);
    const { hid } = fakeHid([ds]);
    const pads = [sonyPad(0), sonyPad(1)];
    const adapter = webHidGamepads(recorder().sink, { hid, getGamepads: () => pads } as unknown as Navigator)!;
    await settle();
    expect([adapter.owns(pads[0]), adapter.owns(pads[1]), adapter.owns(xboxPad(2))]).toEqual([true, false, false]);
    adapter.stop();
  });

  it("routes output: its pads' to their drivers, others' to the Gamepad API's", async () => {
    const ds4 = new FakeDevice(0x054c, 0x05c4, [0x05]);
    const { hid } = fakeHid([ds4]);
    const rec = recorder();
    const adapter = webHidGamepads(rec.sink, { hid, getGamepads: () => [] } as unknown as Navigator)!;
    await settle();
    const id = rec.infos[0].id;
    const calls: unknown[][] = [];
    const fallback: GamepadOutput = {
      rumble: (...a) => calls.push(["rumble", ...a]),
      setLed: (...a) => calls.push(["led", ...a]),
      triggerEffect: (...a) => calls.push(["effect", ...a]),
    };
    const output = adapter.output(fallback);
    output.setLed!(id, 1, 2, 3);
    expect([...ds4.last(0x05).subarray(5, 8)]).toEqual([1, 2, 3]);
    output.rumble(0, 1, 1, 100);
    output.setLed!(0, 9, 9, 9);
    output.triggerEffect!(0, "left", { mode: "off" });
    output.triggerEffect!(id, "left", { mode: "off" }); // a DualShock 4 has no adaptive triggers: nothing happens
    expect(calls).toEqual([["rumble", 0, 1, 1, 100], ["led", 0, 9, 9, 9], ["effect", 0, "left", { mode: "off" }]]);
    adapter.stop();
  });

  it("request(): the chooser lists the supported controllers; picked ones open; a refusal resolves 0", async () => {
    const pro = fakeSwitch(false);
    const { hid, filters } = fakeHid([], [pro]);
    const rec = recorder();
    const adapter = webHidGamepads(rec.sink, { hid, getGamepads: () => [] } as unknown as Navigator)!;
    await expect(adapter.request()).resolves.toBe(1);
    expect(filters[0]).toEqual([
      { vendorId: 0x054c, productId: 0x0ce6 },
      { vendorId: 0x054c, productId: 0x0df2 },
      { vendorId: 0x054c, productId: 0x05c4 },
      { vendorId: 0x054c, productId: 0x09cc },
      { vendorId: 0x054c, productId: 0x0ba0 },
      { vendorId: 0x057e, productId: 0x2009 },
    ]);
    expect(rec.infos.map((i) => i.family)).toEqual(["switch"]);
    adapter.stop();
    expect(pro.opened).toBe(false);
    expect(rec.log[rec.log.length - 1]).toEqual(["disconnect", rec.infos[0].id]);

    const refused = fakeHid([], new Error("SecurityError: no user gesture"));
    const again = webHidGamepads(rec.sink, { hid: refused.hid, getGamepads: () => [] } as unknown as Navigator)!;
    await expect(again.request()).resolves.toBe(0);
    again.stop();
  });

  it("adopts a granted device plugged in later; one that won't open stays with the Gamepad API", async () => {
    const { hid, fire } = fakeHid([]);
    const rec = recorder();
    const adapter = webHidGamepads(rec.sink, { hid, getGamepads: () => [sonyPad(0)] } as unknown as Navigator)!;
    const locked = new FakeDevice(0x054c, 0x0ce6, [0x02]);
    locked.failOpen = true;
    const warn = console.warn;
    console.warn = () => {};
    fire("connect", locked);
    await settle();
    console.warn = warn;
    expect(rec.infos).toEqual([]);
    expect(adapter.owns(sonyPad(0))).toBe(false);
    const ds = new FakeDevice(0x054c, 0x0ce6, [0x02]);
    fire("connect", ds);
    await settle();
    expect(rec.infos.length).toBe(1);
    expect(adapter.owns(sonyPad(0))).toBe(true);
    adapter.stop();
  });
});
