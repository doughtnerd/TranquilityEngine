// ADR 0162 E8: the Sound Lab's spatial page (samples/sound-lab, scenes/spatial.scene.json) loaded headless from disk.
// The scene loads on the fake audio backend without a warning and is not silent (the ambience, the radio and the machine
// start; the flyover starts on its key), the project's audio keys parse without a problem, the ambience clip is a
// first-order ambisonic file with its sidecar, and the real occlusion pass over the scene's real 3D physics World
// muffles the radio behind the door, lets it through when the door script has opened the door, and finds the curtain.
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, AudioOccluder, AudioReverbZone, Engine, GameObject, Input, SceneManager } from "../../myco";
import { parseAudioSettings } from "../audio/settings";
import { readProject } from "../../server/project";
// The sample's scripts, registered as loading the project's scripts would (ADR 0031).
import { Door } from "../../../samples/sound-lab/scripts/behaviors/Door";
import { PassBy } from "../../../samples/sound-lab/scripts/behaviors/PassBy";
import "../../../samples/sound-lab/scripts/behaviors/SceneSwitch";
import "../../../samples/sound-lab/scripts/behaviors/Toggle";
import "../../../samples/sound-lab/scripts/behaviors/Walker";
import "../../../samples/sound-lab/scripts/behaviors/Orbit";
import "../../../samples/sound-lab/scripts/behaviors/PauseToggle";
import "../../../samples/sound-lab/scripts/behaviors/OneShots";
import "../../../samples/sound-lab/scripts/behaviors/Buses";
import "../../../samples/sound-lab/scripts/behaviors/Snapshots";
import "../../../samples/sound-lab/scripts/behaviors/Effects";
import { ListeningBench } from "../../../samples/sound-lab/scripts/behaviors/ListeningBench";
import "../../../samples/sound-lab/scripts/behaviors/Tape";
import "../../../samples/sound-lab/scripts/behaviors/LoopCycler";
import { setAudioBackend } from "../../plugins/audio/runtime/backend";
import { makeFakeBackend } from "../../plugins/audio/runtime/testing";
import { engineOcclusionEnvironment, OcclusionPass } from "../../plugins/audio/runtime/core/occlusion";
import { encodeVoiceId } from "../../plugins/audio/runtime/core/ids";
import { ListenerFrame, SendCurveTable, SpatialViewFlag, type SpatialVoiceView } from "../../plugins/audio/runtime/core/spatial";

const SAMPLE = fileURLToPath(new URL("../../../samples/sound-lab", import.meta.url));
const fake = makeFakeBackend();
const warnings: string[] = [];
const errors: string[] = [];
let engine: Engine | null = null;
const db = (v: number) => Math.pow(10, v / 20);

/** The world plays audio only with a render host; this stub is enough for scene loads. */
const RENDER = { release() {}, warmUp: async () => {}, preloadTextures: async () => {} } as never;

async function boot(scene: string) {
  const project = await readProject(SAMPLE);
  Assets.clearSources();
  Assets.addSource(project.assets);
  engine = await Engine.create({ headless: true, project: project.settings });
  engine.world.render = RENDER;
  await SceneManager.load(scene);
  return project;
}

const advance = (seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 60) {
    (fake as { time: number }).time += 1 / 60;
    engine!.step(1 / 60);
  }
};

beforeEach(() => {
  fake.clear();
  (fake as { time: number }).time = 0;
  fake.ready = true;
  setAudioBackend(fake);
  warnings.length = 0;
  errors.length = 0;
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warnings.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
});

afterEach(() => {
  if (engine) engine.world.render = undefined as never;
  engine?.dispose();
  engine = null;
  Assets.clearSources();
  vi.restoreAllMocks();
  setAudioBackend(null);
});

describe("the Sound Lab spatial page (ADR 0162 E8)", () => {
  it("loads without a warning and is not silent; the flyover starts on its key", async () => {
    const project = await boot("scenes/spatial.scene.json");
    advance(0.5);
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);
    const paths = fake.plays.map((p) => p.path);
    expect(paths).toContain("audio/ambience-o1.wav");
    expect(paths).toContain("audio/radio-loop.wav");
    expect(paths).toContain("audio/noise-loop.wav");
    expect(paths).not.toContain("audio/hum-loop.wav");
    expect(paths).not.toContain("audio/orbit-pulse-loop.wav"); // the orbit waits for key 5
    // The spatial sources are positioned and keep the default Doppler.
    const radio = fake.voices.find((v) => v.request.path === "audio/radio-loop.wav")!;
    expect(radio.position).toMatchObject({ x: 0, y: 1, z: -12.5 });
    expect(radio.request.dopplerLevel ?? 1).toBe(1);
    // Audio Debug's Source column: each AudioSource's voice carries its node's name.
    expect(radio.request.owner).toBe("Radio (behind the door)");
    // The scene's structure: three zones with the three presets, a door with a wooden occluder and the Door script.
    const zones = GameObject.findObjectsOfType(AudioReverbZone);
    expect(zones.map((z) => z.preset).sort()).toEqual(["cave", "corridor", "room"]);
    const door = GameObject.findObjectOfType(Door)!;
    expect(door.node.getComponent(AudioOccluder)).toMatchObject({ material: "wood", openness: 0 });
    expect(GameObject.findObjectOfType(PassBy)).not.toBeNull();
    // The project's audio keys are valid, and Ambience asks for its own bed.
    const parsed = parseAudioSettings(project.settings.audio, { physicsLayers: project.settings.physics?.layers });
    expect(parsed.problems).toEqual([]);
    expect(parsed.settings.occlusion.layers).toEqual(["Walls"]);
    expect(parsed.settings.buses.find((b) => b.name === "Ambience")).toMatchObject({ bed: "own", bedPriority: 200 });
  });

  it("ships the ambience as a small first-order ambisonic clip with its sidecar", () => {
    const wav = `${SAMPLE}/audio/ambience-o1.wav`;
    const bytes = readFileSync(wav);
    expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
    expect(bytes.readUInt16LE(22)).toBe(4); // channels: (order + 1)² for order 1
    expect(bytes.readUInt32LE(24)).toBe(44100);
    expect(statSync(wav).size).toBeLessThan(1_000_000);
    expect(JSON.parse(readFileSync(`${wav}.meta.json`, "utf8"))).toEqual({ format: "myco.import@1", ambisonic: { order: 1, convention: "ambix" } });
  });

  it("the occlusion pass muffles the radio behind the door and the door script opens it", async () => {
    await boot("scenes/spatial.scene.json");
    engine!.step(1 / 60); // colliders reach the physics World
    const view = (x: number, y: number, z: number) => {
      const n = 2;
      const v = {
        capacity: n,
        slots: Uint16Array.of(0),
        count: 1,
        gen: Uint16Array.of(1, 0),
        viewFlags: Uint8Array.of(SpatialViewFlag.SPATIAL | SpatialViewFlag.MIXED | SpatialViewFlag.OCCLUSION, 0),
        world: Int32Array.of(1, 0),
        posX: Float64Array.of(x, 0),
        posY: Float64Array.of(y, 0),
        posZ: Float64Array.of(z, 0),
        minDist: new Float32Array(n),
        maxDist: new Float32Array(n),
        volume: new Float32Array(n),
        audibility0: Float64Array.of(0.5, 0),
        dopplerLevel: new Float32Array(n),
        reverbSend: new Float32Array(n),
        sendCurve: new Uint16Array(n),
        curves: new SendCurveTable(),
        gain: 1,
        lp: 24000,
        setOcclusion(_i: number, gain: number, lpHz: number) {
          v.gain = gain;
          v.lp = lpHz;
        },
        setDopplerRate() {},
      };
      return v satisfies SpatialVoiceView & { gain: number; lp: number };
    };
    const settings = parseAudioSettings(JSON.parse(readFileSync(`${SAMPLE}/project.json`, "utf8")).audio).settings;
    /** One occlusion pass (smoothing starts settled) for a voice at (x, y, z) heard from (0, 1.6, listenerZ). */
    const cast = (src: [number, number, number], listenerZ: number) => {
      const v = view(...src);
      const pass = new OcclusionPass(2, engineOcclusionEnvironment());
      const f = new ListenerFrame();
      f.set(engine!.world, 1, null, { position: { x: 0, y: 1.6, z: listenerZ }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } }, 1 / 60);
      for (let i = 0; i < 400; i++) pass.run(f, v, settings);
      return { v, pass };
    };

    const closed = cast([0, 1, -12.5], -2);
    expect(closed.v.gain).toBeCloseTo(db(-12), 2); // the wooden door
    expect(closed.v.lp).toBeLessThan(3000);
    expect(closed.pass.voiceDebug(0)).toMatchObject({ hits: 1, material: "wood" });

    const door = GameObject.findObjectOfType(Door)!;
    door.setOpen(true);
    advance(1.2); // the script moves openness to 1 over 0.8 s
    expect(door.node.getComponent(AudioOccluder)!.openness).toBe(1);
    expect(cast([0, 1, -12.5], -2).v.gain).toBeGreaterThan(0.95);

    // The curtain between the corridor and the cave: cloth, a little duller.
    const curtain = cast([0.8, 1, 18], 0);
    expect(curtain.v.gain).toBeCloseTo(db(-4), 2);
    // The walls are concrete but run along the corridor: a listener and a source in the same stretch never cross one (the door and the curtain are behind them).
    expect(cast([0.8, 1, 6], -2).v.gain).toBe(1);
  });

  it("the flyover moves along the corridor at its speed and turns round at the ends", async () => {
    await boot("scenes/spatial.scene.json");
    const fly = GameObject.findObjectOfType(PassBy)!;
    advance(1);
    const z = () => fly.node.transform!.position.z;
    expect(Math.abs(z() + 10)).toBeLessThan(1);
    advance(1.6); // 2.6 s in: 78 m along the 80 m run
    expect(Math.abs(z() - 38)).toBeLessThan(1.5);
    advance(0.8); // 3.4 s in: 102 m, so 22 m of the way back
    expect(Math.abs(z() - 18)).toBeLessThan(1.5);
  });
  it("key 8 turns the listener a quarter turn to the left each press, so four presses make a full turn", async () => {
    await boot("scenes/spatial.scene.json");
    const bench = GameObject.findObjectOfType(ListeningBench)!;
    const start = bench.transform.rotation.clone();
    // ADR 0164: eulerAngles are radians, yaw (y) outermost and read back in [0, 2π); a left turn lowers it.
    const yaw0 = bench.transform.eulerAngles.y;
    const seen: number[] = [];
    for (let k = 0; k < 4; k++) {
      Input.simulate("down", "8");
      engine!.step(1 / 60);
      Input.simulate("up", "8");
      engine!.step(1 / 60);
      seen.push(Math.round((((bench.transform.eulerAngles.y - yaw0) * 180) / Math.PI + 720) % 360) % 360);
    }
    expect(seen).toEqual([270, 180, 90, 0]);
    const q = bench.transform.rotation;
    expect(Math.abs(q.x * start.x + q.y * start.y + q.z * start.z + q.w * start.w)).toBeCloseTo(1, 6);
  });
  it("key 5 moves the orbit on a level circle (front, right, behind, left), then a vertical one, then stops it", async () => {
    await boot("scenes/spatial.scene.json");
    const press = (k: string) => {
      Input.simulate("down", k);
      engine!.step(1 / 60);
      Input.simulate("up", k);
    };
    // Where the orbit is in the listener's own axes (it is the listener's child): +Z ahead, +X right, +Y up.
    const at = () => {
      const p = fake.voices.filter((v) => v.request.path === "audio/orbit-pulse-loop.wav").at(-1)!.position!;
      const l = fake.listener!;
      const o = { x: p.x - l.position.x, y: p.y - l.position.y, z: p.z - l.position.z };
      const right = { x: l.up.y * l.forward.z - l.up.z * l.forward.y, y: l.up.z * l.forward.x - l.up.x * l.forward.z, z: l.up.x * l.forward.y - l.up.y * l.forward.x };
      const dot = (a: typeof o, b: typeof o) => a.x * b.x + a.y * b.y + a.z * b.z;
      return [dot(o, right), dot(o, l.up), dot(o, l.forward)].map((n) => Math.round(n) + 0); // + 0: no -0
    };
    press("5");
    advance(0.05);
    expect(at()).toEqual([0, 0, 3]); // in front
    advance(3);
    expect(at()).toEqual([3, 0, 0]); // right, at ear height
    advance(3);
    expect(at()).toEqual([0, 0, -3]); // behind
    advance(3);
    expect(at()).toEqual([-3, 0, 0]); // left
    press("5");
    advance(3.05);
    expect(at()).toEqual([0, 3, 0]); // vertical: overhead
    advance(6);
    expect(at()).toEqual([0, -3, 0]); // below the floor (the eye is at 1.6 m)
    press("5");
    advance(0.1);
    expect(fake.voices.filter((v) => v.request.path === "audio/orbit-pulse-loop.wav").at(-1)!.playing).toBe(false);
  });

  it("the sounds the pass places by ear are broadband: a pure low tone can't be placed", () => {
    // Energy of the first difference over the signal's: about (2·sin(π·f/rate))², so 0.002 for a 330 Hz tone, far more
    // with content at 4-16 kHz (where the up/down and front/back cues are).
    const brightness = (name: string) => {
      const b = readFileSync(`${SAMPLE}/audio/${name}`);
      const n = (b.length - 44) >> 1;
      let e = 0, d = 0, last = 0;
      for (let i = 0; i < n; i++) {
        const v = b.readInt16LE(44 + 2 * i) / 32768;
        e += v * v;
        d += (v - last) ** 2;
        last = v;
      }
      return d / e;
    };
    for (const name of ["orbit-pulse-loop.wav", "radio-loop.wav", "noise-loop.wav"]) expect(brightness(name), name).toBeGreaterThan(0.05);
    expect(brightness("music-loop.wav")).toBeLessThan(0.01); // the old Radio clip, for scale
  });
});
