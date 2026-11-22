// ADR 0334: the request records' codecs round-trip every request kind, a FRAME and a take KEYFRAME, and refuse rather
// than misread (lengths, counts, strings, values).
import { describe, expect, it } from "vitest";
import {
  TAKE_FRAME_MAX_BYTES, TAKE_NAME_MAX_BYTES, TAKE_NONE, TakeRecordError, TakeRecordType, decodeTakeRecord, encodeTakeRecordBytes,
  isTakeRecordType, takeRecordBytes, type TakeRecordInit,
} from "./records";

const decode = (r: TakeRecordInit) => {
  const b = encodeTakeRecordBytes(r);
  expect(b.byteLength).toBe(takeRecordBytes(r));
  return decodeTakeRecord(r.type, new DataView(b.buffer), 0, b.byteLength);
};

const codeOf = (f: () => unknown): string => {
  try {
    f();
    return "none";
  } catch (e) {
    return e instanceof TakeRecordError ? e.code : `other: ${String(e)}`;
  }
};

describe("take request records (ADR 0334)", () => {
  it("every request kind round-trips", () => {
    const requests: TakeRecordInit[] = [
      { type: TakeRecordType.PLAY, payload: { kind: "play", t: 1.25, instance: 7, path: "sfx/steps.playlist.json", emitter: 3, options: { volume: 0.5, pitch: 1.25, bus: "SFX", priority: 200, parameters: { Speed: 0.75, Surface: 2 } } } },
      { type: TakeRecordType.PLAY, payload: { kind: "play", t: 0, instance: 0x4000_0001, path: "ui/click.wav", emitter: null, options: {} } },
      { type: TakeRecordType.STOP, payload: { kind: "stop", t: 2, instance: 7, fade: 0.125 } },
      { type: TakeRecordType.RELEASE, payload: { kind: "release", t: 2.5, instance: 7 } },
      { type: TakeRecordType.PARAM, payload: { kind: "param", t: 3, instance: null, name: "Intensity", value: 0.3 } },
      { type: TakeRecordType.PARAM, payload: { kind: "param", t: 3, instance: 9, name: "Speed", value: -2 } },
      { type: TakeRecordType.MIX, payload: { kind: "mix", t: 4, op: "busFade", target: "Music", value: 0.25, seconds: 1.5 } },
      { type: TakeRecordType.MIX, payload: { kind: "mix", t: 4, op: "snapshotStop", target: "", value: 0, seconds: 0.5 } },
      { type: TakeRecordType.TRIGGER, payload: { kind: "trigger", t: 5, instance: 9, name: "Hit" } },
      { type: TakeRecordType.MARK, payload: { kind: "mark", t: 6, text: "boss — phase 2" } },
    ];
    for (const r of requests) expect(decode(r)).toEqual({ type: "request", requests: [r.payload] });
  });

  it("a POSE carries several emitters, the listener with its forward", () => {
    const r: TakeRecordInit = {
      type: TakeRecordType.POSE,
      payload: { t: 1, poses: [
        { emitter: 0, position: { x: 1, y: 2, z: 3 }, velocity: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 } },
        { emitter: 4, position: { x: -1.5, y: 0, z: 8 }, velocity: { x: 2, y: 0, z: -1 } },
      ] },
    };
    expect(decode(r)).toEqual({ type: "request", requests: r.payload.poses.map((p) => ({ kind: "pose", t: 1, ...p })) });
  });

  it("a FRAME and a take KEYFRAME round-trip", () => {
    const frame: TakeRecordInit = { type: TakeRecordType.FRAME, payload: { t: 1, width: 160, height: 90, jpeg: new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]) } };
    expect(decode(frame)).toEqual({ type: "frame", frame: frame.payload });
    const kf: TakeRecordInit = {
      type: TakeRecordType.KEYFRAME,
      payload: { t: 2, globals: { Intensity: 0.5 }, instances: [
        { instance: 7, path: "a.playlist.json", started: -0.5, emitter: 1, parameters: { Speed: 1 } },
        { instance: 8, path: "b.wav", started: 1.5, emitter: null, parameters: {} },
      ] },
    };
    expect(decode(kf)).toEqual({ type: "keyframe", keyframe: kf.payload });
  });

  it("names the request record types and only those", () => {
    for (const t of Object.values(TakeRecordType)) expect(isTakeRecordType(t)).toBe(true);
    for (const t of [0x01, 0x08, 0x0f, 0x1a, 0x7f, 0x80]) expect(isTakeRecordType(t)).toBe(false);
  });

  it("cuts long names on a code-point boundary when writing", () => {
    const long = "é".repeat(TAKE_NAME_MAX_BYTES); // 2 bytes each
    const r = decode({ type: TakeRecordType.PARAM, payload: { kind: "param", t: 0, instance: null, name: long, value: 1 } });
    const q = r.type === "request" ? r.requests[0]! : null;
    expect(q && q.kind === "param" && q.name.length).toBe(TAKE_NAME_MAX_BYTES / 2);
  });

  describe("refuses rather than misreads", () => {
    const play: TakeRecordInit = { type: TakeRecordType.PLAY, payload: { kind: "play", t: 1, instance: 1, path: "a", emitter: null, options: { parameters: { P: 1 } } } };
    const bytes = encodeTakeRecordBytes(play);
    const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
    const edit = (f: (v: DataView) => void): Uint8Array => {
      const b = bytes.slice();
      f(view(b));
      return b;
    };
    const run = (type: number, b: Uint8Array, len = b.byteLength) => codeOf(() => decodeTakeRecord(type, view(b), 0, len));

    it("a payload cut short or longer than its fields", () => {
      for (let n = 0; n < bytes.byteLength; n++) expect(run(TakeRecordType.PLAY, bytes, n), `${n} B`).toBe("badLength");
      const longer = new Uint8Array(bytes.byteLength + 1);
      longer.set(bytes);
      expect(run(TakeRecordType.PLAY, longer)).toBe("badLength");
    });

    it("a negative or non-finite time, unknown flags, a non-finite option", () => {
      expect(run(TakeRecordType.PLAY, edit((v) => v.setFloat64(0, -1, true)))).toBe("badValue");
      expect(run(TakeRecordType.PLAY, edit((v) => v.setFloat64(0, NaN, true)))).toBe("badValue");
      expect(run(TakeRecordType.PLAY, edit((v) => v.setUint8(16, 0x80)))).toBe("badValue");
      expect(run(TakeRecordType.PLAY, edit((v) => v.setFloat32(17, Infinity, true)))).toBe("badValue");
    });

    it("a string past its cap, invalid UTF-8, a count past its cap", () => {
      // The path's u16 length sits after t, instance, emitter, flags, volume, pitch and priority (8+4+4+1+4+4+2 = 27).
      expect(run(TakeRecordType.PLAY, edit((v) => v.setUint16(27, 5000, true)))).toBe("textTooLong");
      expect(run(TakeRecordType.PLAY, edit((v) => v.setUint8(29, 0xff)))).toBe("badUtf8");
      const param = encodeTakeRecordBytes({ type: TakeRecordType.POSE, payload: { t: 0, poses: [] } });
      new DataView(param.buffer).setUint16(8, 2000, true);
      expect(run(TakeRecordType.POSE, param)).toBe("badValue");
      const fits = encodeTakeRecordBytes({ type: TakeRecordType.POSE, payload: { t: 0, poses: [] } });
      new DataView(fits.buffer).setUint16(8, 3, true);
      expect(run(TakeRecordType.POSE, fits)).toBe("badLength");
    });

    it("enum values outside their domain, a FRAME too large", () => {
      const mix = encodeTakeRecordBytes({ type: TakeRecordType.MIX, payload: { kind: "mix", t: 0, op: "busVolume", target: "Music", value: 1, seconds: 0 } });
      new DataView(mix.buffer).setUint8(8, 9);
      expect(run(TakeRecordType.MIX, mix)).toBe("badValue");
      const stop = encodeTakeRecordBytes({ type: TakeRecordType.STOP, payload: { kind: "stop", t: 0, instance: 1, fade: 0 } });
      new DataView(stop.buffer).setFloat32(12, -1, true);
      expect(run(TakeRecordType.STOP, stop)).toBe("badValue");
      const frame = encodeTakeRecordBytes({ type: TakeRecordType.FRAME, payload: { t: 0, width: 2, height: 2, jpeg: new Uint8Array(4) } });
      new DataView(frame.buffer).setUint32(12, TAKE_FRAME_MAX_BYTES + 1, true);
      expect(run(TakeRecordType.FRAME, frame)).toBe("badValue");
      new DataView(frame.buffer).setUint16(8, 0, true);
      expect(run(TakeRecordType.FRAME, frame)).toBe("badValue");
    });

    it("a global parameter is TAKE_NONE on the wire", () => {
      const b = encodeTakeRecordBytes({ type: TakeRecordType.PARAM, payload: { kind: "param", t: 0, instance: null, name: "G", value: 1 } });
      expect(new DataView(b.buffer).getUint32(8, true)).toBe(TAKE_NONE);
    });
  });
});
