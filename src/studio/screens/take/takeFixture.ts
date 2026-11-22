// A take for the Take screen's stories and tests: the prototype's hover-bike canyon run (41 s: an engine loop the whole
// way, a held boost, a jump, a landing on rock, a held brake), with Speed and Surface parameters, a moving bike and
// listener, game marks and one-second keyframes. Built through the take record writers and read back through the
// decoder (`encodeTakeRecordBytes` / `decodeTakeRecord`), as a file's records would be, then opened as a `Take`.
import { Take } from "../../../engine/audio/take/reader";
import { TakeRecordType, decodeTakeRecord, encodeTakeRecordBytes, type TakeRecord, type TakeRecordInit } from "../../../engine/audio/take/records";
import { TAKE_NOTES_FORMAT, type TakeKeyframe, type TakeMeta, type TakeNotes, type TakeRequest } from "../../../engine/audio/take/types";

export const FIXTURE_DURATION = 41;

/** Surface's labels, as `audio.json` would define the labelled parameter. */
export const SURFACE_LABELS = ["Dirt", "Rock", "Metal bridge"] as const;

const META: TakeMeta = {
  project: "HoverBike", engine: "myco", audioHash: "5f3a", seed: 1234, device: "fixture", started: new Date(Date.UTC(2026, 10, 22, 9)).toISOString(),
  duration: FIXTURE_DURATION, emitters: { 0: "Camera", 1: "Bike" }, frames: false,
};

type Init = TakeRecordInit;
const play = (t: number, instance: number, path: string, parameters?: Record<string, number>, emitter: number | null = 1): Init => ({ type: TakeRecordType.PLAY, payload: { kind: "play", t, instance, path, emitter, options: parameters ? { parameters } : {} } });
const stop = (t: number, instance: number): Init => ({ type: TakeRecordType.STOP, payload: { kind: "stop", t, instance, fade: 0.1 } });
const release = (t: number, instance: number): Init => ({ type: TakeRecordType.RELEASE, payload: { kind: "release", t, instance } });
const param = (t: number, name: string, value: number, instance: number | null = null): Init => ({ type: TakeRecordType.PARAM, payload: { kind: "param", t, instance, name, value } });
const mark = (t: number, text: string): Init => ({ type: TakeRecordType.MARK, payload: { kind: "mark", t, text } });

/** The prototype's speed curve, km/h, over the run's fraction `x`. */
function speedAt(x: number): number {
  let s = 40 + 160 * Math.min(1, x / 0.15);
  if (x > 0.18 && x < 0.3) s += 20 * Math.sin(((x - 0.18) / 0.12) * Math.PI);
  if (x > 0.86) s *= Math.max(0.1, 1 - (x - 0.86) / 0.14);
  return Math.round(s);
}

function requests(): Init[] {
  const out: Init[] = [param(0, "Surface", 0), play(0, 1, "vehicles/engine.playlist.json", { Rpm: 900 })];
  for (let t = 0; t < FIXTURE_DURATION; t += 0.5) {
    const s = speedAt(t / FIXTURE_DURATION);
    out.push(param(t, "Speed", s), param(t, "Rpm", 900 + Math.round((6200 * s) / 220), 1));
  }
  out.push(
    play(5.6, 2, "vehicles/boost.playlist.json"), release(7.4, 2), stop(9.9, 2),
    param(12.3, "Surface", 1), mark(14, "Canyon entry"),
    play(17.6, 3, "vehicles/jump.playlist.json"), stop(18.4, 3),
    play(20.2, 4, "impacts/land.playlist.json", { Velocity: 0.71, Surface: 1 }), stop(21.4, 4),
    param(21.3, "Surface", 2), mark(22, "Bridge"), param(28.7, "Surface", 0),
    play(27.5, 5, "vehicles/brake.playlist.json"), release(29.1, 5), stop(30.6, 5),
    play(33, 6, "ui/checkpoint.wav", undefined, null),
    { type: TakeRecordType.MIX, payload: { kind: "mix", t: 35, op: "busFade", target: "Music", value: 0.5, seconds: 2 } },
    stop(40.5, 1),
  );
  for (let t = 0; t <= FIXTURE_DURATION; t += 1 / 10) {
    const x = (t / FIXTURE_DURATION) * 600;
    out.push({ type: TakeRecordType.POSE, payload: { t, poses: [{ emitter: 1, position: { x, y: 1, z: 0 }, velocity: { x: 15, y: 0, z: 0 } }, { emitter: 0, position: { x: x - 6, y: 3, z: -4 }, velocity: { x: 15, y: 0, z: 0 }, forward: { x: 1, y: 0, z: 0 } }] } });
  }
  return out.sort((a, b) => a.payload.t - b.payload.t);
}

/** One-second keyframes from the requests: what is alive and the parameters, as the recorder writes them. */
function keyframes(reqs: readonly TakeRequest[]): Init[] {
  const out: Init[] = [];
  const alive = new Map<number, TakeKeyframe["instances"][number]>();
  const globals: Record<string, number> = {};
  let i = 0;
  for (let k = 0; k <= Math.floor(FIXTURE_DURATION); k++) {
    for (; i < reqs.length && reqs[i]!.t < k; i++) {
      const q = reqs[i]!;
      if (q.kind === "play") alive.set(q.instance, { instance: q.instance, path: q.path, started: q.t, emitter: q.emitter, parameters: { ...q.options.parameters } });
      else if (q.kind === "stop") alive.delete(q.instance);
      else if (q.kind === "param") {
        if (q.instance === null) globals[q.name] = q.value;
        else {
          const a = alive.get(q.instance);
          if (a) a.parameters = { ...a.parameters, [q.name]: q.value };
        }
      }
    }
    out.push({ type: TakeRecordType.KEYFRAME, payload: { t: k, instances: [...alive.values()].map((a) => ({ ...a, parameters: { ...a.parameters } })), globals: { ...globals } } });
  }
  return out;
}

/** Through the writer and back through the decoder, as a take file's records. */
const roundTrip = (r: Init): TakeRecord => {
  const bytes = encodeTakeRecordBytes(r);
  return decodeTakeRecord(r.type, new DataView(bytes.buffer), 0, bytes.byteLength);
};

/** A tiny picture of the game view (48 x 27: sky, ground and the bike), as a take's FRAME holds a 320 px one. */
const PICTURE = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABsSFBcUERsXFhceHBsgKEIrKCUlKFE6PTBCYFVlZF9VXVtqeJmBanGQc1tdhbWGkJ6jq62rZ4C8ybqmx5moq6T/2wBDARweHigjKE4rK06kbl1upKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKT/wAARCAAbADADASIAAhEBAxEB/8QAGAABAAMBAAAAAAAAAAAAAAAAAAIDBAH/xAAcEAACAgMBAQAAAAAAAAAAAAAAAQIDBBESMSH/xAAWAQEBAQAAAAAAAAAAAAAAAAABBAX/xAAXEQEBAQEAAAAAAAAAAAAAAAAAEQES/9oADAMBAAIRAxEAPwC8AFScBdjUK6T29RXuvSWTjKmKlFtpvX0OssM2VnAAhlABmr0qrZ1T6rlyzt11lzTsl1rwgBoAABf/2Q==";

/** The picture's bytes. */
function pictureBytes(): Uint8Array {
  const s = atob(PICTURE);
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** One picture a second, as the recorder takes them (`FRAME`). */
function frames(): Init[] {
  const jpeg = pictureBytes();
  const out: Init[] = [];
  for (let t = 0; t < FIXTURE_DURATION; t++) out.push({ type: TakeRecordType.FRAME, payload: { t: t + 0.02, width: 48, height: 27, jpeg } });
  return out;
}

/** The fixture take; `pictures: false` leaves out its FRAME pictures. */
export function fixtureTake(opts: { pictures?: boolean } = {}): Take {
  const pictures = opts.pictures !== false;
  const reqs = requests();
  const decoded = reqs.map(roundTrip);
  const flat = decoded.flatMap((r) => (r.type === "request" ? r.requests : []));
  return new Take({ ...META, frames: pictures }, [...decoded, ...keyframes(flat).map(roundTrip), ...(pictures ? frames().map(roundTrip) : [])]);
}

/** Notes a designer left on the fixture take. */
export const FIXTURE_NOTES: TakeNotes = {
  format: TAKE_NOTES_FORMAT,
  markers: [
    { id: "m1", at: 6.2, text: "Boost attack too soft", color: 0xeb5757 },
    { id: "m2", at: 20.3, text: "Landing: check rock layer", color: 0xf2c94c },
  ],
  regions: [{ id: "r1", from: 27, to: 31, text: "Brake squeal sits on top of the music", color: 0x56ccf2 }],
};
