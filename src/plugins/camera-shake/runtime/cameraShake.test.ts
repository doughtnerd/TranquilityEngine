// ADR 0435: camera shake is game-visible state (`CameraShake.offsetPosition` / `offsetRotation`, the camera's
// `CameraViewOffset`), computed by the plugin's systems in every World, so it's read here in a headless World through
// the components' and the buffer's own interfaces.
import { afterEach, describe, expect, it } from "vitest";
import { Assets, BoxCollider, Camera, CameraShake, CameraViewOffset, Engine, GameObject, RigidBody, SceneManager, ShakeImpulseSource, ShakeImpulses, Time, Vector2 } from "../../../myco";

const engines: Engine[] = [];
afterEach(() => {
  if (engines.length) Time.timeScale = 1;
  for (const e of engines.splice(0)) e.dispose();
  Assets.clearSources();
});

async function headless(settings?: Record<string, unknown>): Promise<Engine> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", ...(settings ? { settings } : {}), nodes: [] } }));
  const engine = await Engine.create({ headless: true });
  engines.push(engine);
  await SceneManager.load("s.json");
  return engine;
}

function camera(projection: "perspective" | "orthographic" = "perspective", shake: Partial<Pick<CameraShake, "noise" | "channels" | "impulseGain" | "timeMode" | "seed">> = {}): { node: GameObject; shake: CameraShake } {
  const node = GameObject.create("cam");
  node.addBehavior(Camera, { projection });
  return { node, shake: node.addBehavior(CameraShake, shake) };
}

const size = (s: CameraShake): number => s.offsetPosition.length + s.offsetRotation.length;

describe("camera shake (ADR 0435)", () => {
  it("shake() moves only the drawn view, for the preset's duration, then stops", async () => {
    const engine = await headless();
    const { node, shake } = camera();
    engine.step(0.016);
    expect(size(shake)).toBe(0);
    shake.shake("bump", 2);
    engine.step(0.1);
    expect(size(shake)).toBeGreaterThan(0);
    const off = node.getData(CameraViewOffset)!;
    expect(off.py).toBeCloseTo(shake.offsetPosition.y, 6);
    expect(off.rx).toBeCloseTo(shake.offsetRotation.x, 6);
    // The Transform keeps its pose: follow scripts, rays and the audio listener see the steady camera.
    expect(node.transform!.position.toArray()).toEqual([0, 0, 0]);
    for (let i = 0; i < 4; i++) engine.step(0.1); // past the bump's 0.3 s
    expect(size(shake)).toBe(0);
    expect(off.py).toBe(0);
  });

  it("keeps camera rays on the steady pose while the view shakes", async () => {
    const engine = await headless();
    const { node, shake } = camera();
    const steady = node.getBehavior(Camera)!.screenPointToRay(new Vector2(100, 100));
    shake.shake("explosion", 5);
    engine.step(0.05);
    expect(size(shake)).toBeGreaterThan(0);
    const during = node.getBehavior(Camera)!.screenPointToRay(new Vector2(100, 100));
    expect(during.origin.toArray()).toEqual(steady.origin.toArray());
    expect(during.direction.toArray()).toEqual(steady.direction.toArray());
  });

  it("hears source impulses within reach, falling off beyond the radius, and nothing past it", async () => {
    const engine = await headless();
    const near = camera().shake;
    const farCam = camera();
    farCam.node.transform!.position.set(500, 0, 0);
    const mid = camera();
    mid.node.transform!.position.set(15, 0, 0);
    const src = GameObject.create("bomb").addBehavior(ShakeImpulseSource, { preset: "recoil", radius: 10, dissipationDistance: 20 });
    engine.step(0.016);
    src.generateImpulse();
    engine.step(0.016);
    expect(size(near)).toBeGreaterThan(0);
    expect(size(mid.shake)).toBeGreaterThan(0);
    expect(size(mid.shake)).toBeLessThan(size(near));
    expect(size(farCam.shake)).toBe(0);
  });

  it("filters by channel, and impulseGain 0 mutes impulses", async () => {
    const engine = await headless();
    const ui = camera("perspective", { channels: ["ui"] }).shake;
    const all = camera().shake;
    const muted = camera("perspective", { impulseGain: 0 }).shake;
    const src = GameObject.create("s").addBehavior(ShakeImpulseSource, { channel: "world" });
    engine.step(0.016);
    src.generateImpulse();
    engine.step(0.05);
    expect(size(all)).toBeGreaterThan(0);
    expect(size(ui)).toBe(0);
    expect(size(muted)).toBe(0);
  });

  it("sends one impulse per false → true change of fire (keyed in a clip or timeline)", async () => {
    const engine = await headless();
    const cam = camera().shake;
    const src = GameObject.create("s").addBehavior(ShakeImpulseSource, { preset: "recoil", duration: 0.1 });
    engine.step(0.016);
    src.fire = true;
    engine.step(0.02);
    expect(size(cam)).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) engine.step(0.02); // still true: no new impulse, the first has ended
    expect(size(cam)).toBe(0);
    src.fire = false;
    engine.step(0.02);
    src.fire = true;
    engine.step(0.02);
    expect(size(cam)).toBeGreaterThan(0);
  });

  it("sends on start once, and on an interval", async () => {
    const engine = await headless();
    const cam = camera().shake;
    GameObject.create("s").addBehavior(ShakeImpulseSource, { trigger: "onStart", preset: "recoil", duration: 0.05 });
    engine.step(0.02);
    expect(size(cam)).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) engine.step(0.02);
    expect(size(cam)).toBe(0);

    GameObject.create("t").addBehavior(ShakeImpulseSource, { trigger: "interval", interval: 0.5, preset: "recoil", duration: 0.05 });
    let shaking = 0;
    for (let i = 0; i < 100; i++) {
      engine.step(0.02);
      if (size(cam) > 0) shaking++;
    }
    // Two seconds: three or four impulses (the last lands on the edge), each felt for about two 20 ms frames.
    expect(shaking).toBeGreaterThanOrEqual(6);
    expect(shaking).toBeLessThanOrEqual(10);
  });

  it("takes impulses pushed straight into ShakeImpulses, and reaches far listeners later with a propagation speed", async () => {
    const engine = await headless();
    const near = camera().shake;
    const far = camera();
    far.node.transform!.position.set(10, 0, 0);
    engine.step(0.016);
    ShakeImpulses.push({ position: [0, 0, 0], velocity: [0, -1, 0], preset: "recoil", duration: 0.1, propagationSpeed: 50 });
    engine.step(0.05);
    expect(size(near)).toBeGreaterThan(0);
    expect(size(far.shake)).toBe(0); // 10 units at 50/s: it arrives after 0.2 s
    for (let i = 0; i < 4; i++) engine.step(0.05);
    expect(size(far.shake)).toBeGreaterThan(0);
  });

  it("stops with paused time in scaled mode and keeps going in unscaled mode", async () => {
    const engine = await headless();
    const scaled = camera("perspective", { noise: "shake6D" }).shake;
    const unscaled = camera("perspective", { noise: "shake6D", timeMode: "unscaled" }).shake;
    engine.step(0.05);
    Time.timeScale = 0;
    engine.step(0.05);
    const s0 = scaled.offsetPosition.x, u0 = unscaled.offsetPosition.x;
    engine.step(0.05);
    expect(scaled.offsetPosition.x).toBe(s0);
    expect(unscaled.offsetPosition.x).not.toBe(u0);
  });

  it("gives orthographic cameras only movement across the screen and roll", async () => {
    const engine = await headless();
    const shake = camera("orthographic", { noise: "shake6D" }).shake;
    engine.step(0.05);
    expect(shake.offsetPosition.z).toBe(0);
    expect(shake.offsetRotation.x).toBe(0);
    expect(shake.offsetRotation.y).toBe(0);
    expect(Math.abs(shake.offsetPosition.x) + Math.abs(shake.offsetRotation.z)).toBeGreaterThan(0);
  });

  it("replays the same shake with the same seed", async () => {
    const run = async (): Promise<number[]> => {
      const engine = await headless();
      const shake = camera("perspective", { noise: "handheld", seed: 42 }).shake;
      const out: number[] = [];
      for (let i = 0; i < 5; i++) {
        engine.step(0.1);
        out.push(shake.offsetRotation.x, shake.offsetPosition.y);
      }
      return out;
    };
    expect(await run()).toEqual(await run());
  });

  it("clears a camera's view offset the frame after nothing writes it", async () => {
    const engine = await headless();
    const { node, shake } = camera("perspective", { noise: "shake6D" });
    engine.step(0.05);
    expect(node.getData(CameraViewOffset)!.px).not.toBe(0);
    shake.enabled = false;
    engine.step(0.05);
    const off = node.getData(CameraViewOffset)!;
    expect([off.px, off.py, off.pz, off.rx, off.ry, off.rz]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("sends on a collision faster than minImpactSpeed, scaled by the impact speed", async () => {
    const engine = await headless({ physics: "3d" });
    const cam = camera().shake;
    const floor = GameObject.create("floor");
    floor.transform!.position.y = -1;
    floor.addBehavior(BoxCollider).size.set(20, 1, 20);
    const crate = GameObject.create("crate");
    crate.transform!.position.y = 3;
    crate.addBehavior(RigidBody);
    crate.addBehavior(BoxCollider);
    crate.addBehavior(ShakeImpulseSource, { trigger: "collision", minImpactSpeed: 2, preset: "recoil" });
    let felt = false;
    for (let i = 0; i < 120 && !felt; i++) {
      engine.step(1 / 60);
      felt = size(cam) > 0;
    }
    expect(felt).toBe(true);
  });
});
