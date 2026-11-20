// ADR 0096, 0251: Collide with colliders on the JavaScript kernel executor (the one executor that ray
// casts, which a system with the block runs on), driven by a fake world raycast (a floor at y = 0).
import { describe, expect, it, vi } from "vitest";
import { JsKernel } from "../render/particles/gpu/kernelJs";
import type { ParticleRaycast } from "../render/particles/gpu/kernelSteps";
import { chooseBackend, compileParticleKernels, KERNEL_FLOATS, U } from "../scene/particleKernel";
import { defaultBlock } from "../scene/particleBlocks";
import type { GraphInputValue, ParticleGraph } from "../scene/particleGraph";
import { newGraphId, systemTemplate } from "../scene/particleGraphFormat";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (x: number, y = 0, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** A floor at world y = 0 facing up. */
const floor: ParticleRaycast = (ox, oy, oz, dx, dy, dz, max) => {
  if (oy < 0 || dy >= 0) return null;
  const t = oy / -dy;
  if (t > max) return null;
  return { point: [ox + dx * t, 0, oz + dz * t], normal: [0, 1, 0], distance: t };
};

describe("kernel particles: collider collision on the JavaScript executor (ADR 0251)", () => {
  function kernelSetup(over: Record<string, GraphInputValue>, pos: number[], vel: number[], raycast: ParticleRaycast | undefined, local = false, matrix = IDENTITY) {
    const g: ParticleGraph = { properties: [], systems: [], nodes: [], edges: [], events: [], notes: [], groups: [] };
    const sys = systemTemplate(g, "empty", [0, 0]);
    g.systems.push(sys);
    sys.settings.capacity = 4;
    sys.settings.space = local ? "local" : "world";
    const add = (c: "spawn" | "initialize" | "update", type: string, inputs: Record<string, GraphInputValue> = {}) => {
      const b = defaultBlock(type, newGraphId(g, "b"));
      Object.assign(b.inputs, inputs);
      sys[c].blocks.push(b);
    };
    add("initialize", "init.lifetime", { lifetime: 100 });
    add("update", "update.collisionColliders", { bounce: 0.5, friction: 0, kill: false, radius: 0, ...over });
    const kp = compileParticleKernels(g);
    const k = kp.systems[0];
    expect(k.jsOnly).toEqual(["Collide with colliders"]);
    expect(chooseBackend("gpu", k, ["webgpu", "js"])).toBe("webgpu"); // asked for: the GPU skips it (and says so)
    expect(chooseBackend("auto", { ...k, needs: ["several outputs"] }, ["webgpu", "js"])).toBe("js"); // colliders keep it on JavaScript
    const js = new JsKernel(k, { raycast });
    const u = js.uniforms;
    u.set(matrix, U.matrix * 4);
    u.set(invert(matrix), U.inverse * 4);
    u[U.flags * 4 + 2] = local ? 0 : 1;
    u[U.spawn * 4 + 1] = 1; // spawn one
    js.step();
    u[U.spawn * 4 + 1] = 0;
    const slot = [...Array(4).keys()].find((i) => js.alive(i))!;
    const o = slot * KERNEL_FLOATS;
    js.state.set(pos, o);
    js.state.set(vel, o + 4);
    return {
      js,
      p: () => ({ y: js.state[o + 1], vx: js.state[o + 4], vy: js.state[o + 5], vz: js.state[o + 6] }),
      step: (dt = 0.1) => {
        u[U.time * 4 + 1] = dt;
        js.step();
      },
    };
  }

  it("bounces off the floor, with friction on the tangential velocity", () => {
    const a = kernelSetup({ bounce: 0.5 }, [0, 0.1, 0], [1, -4, 0], floor);
    a.step();
    expect(a.p().vy).toBeCloseTo(2, 5);
    expect(a.p().vx).toBeCloseTo(1, 5);
    expect(a.p().y).toBeCloseTo(0.001, 5);
    const b = kernelSetup({ bounce: 1, friction: 0.25 }, [0, 0.1, 0], [2, -4, 1], floor);
    b.step();
    expect([b.p().vx, b.p().vy, b.p().vz].map((x) => +x.toFixed(4))).toEqual([1.5, 4, 0.75]);
  });

  it("kills on a hit in kill mode, leaves misses alone, and does nothing without a raycast", () => {
    const killed = kernelSetup({ kill: true }, [0, 0.1, 0], [0, -4, 0], floor);
    expect(killed.js.aliveCount).toBe(1);
    killed.step();
    expect(killed.js.aliveCount).toBe(0);
    const miss = kernelSetup({}, [0, 5, 0], [1, -1, 0], floor);
    miss.step();
    expect(miss.p().y).toBeCloseTo(4.9, 5);
    const none = kernelSetup({ kill: true }, [0, 0.1, 0], [0, -4, 0], undefined);
    none.step();
    expect(none.js.aliveCount).toBe(1);
    expect(none.p().y).toBeCloseTo(-0.3, 5);
  });

  it("casts from the previous to the new world position, in a local-space system under a moved node", () => {
    const ray = vi.fn(floor);
    const a = kernelSetup({}, [0, 1, 0], [0, -1, 0], ray);
    a.step(0.1);
    expect(ray).toHaveBeenCalledTimes(1);
    const [ox, oy, oz, dx, dy, dz, max] = ray.mock.calls[0];
    expect([ox, oy, oz, dx, dy, dz].map((x) => +x.toFixed(6))).toEqual([0, 1, 0, 0, -1, 0]);
    expect(max).toBeCloseTo(0.1, 5);
    const local = kernelSetup({ bounce: 0.5 }, [0, -9.9, 0], [0, -4, 0], floor, true, at(3, 10, 0));
    local.step();
    expect(local.p().vy).toBeCloseTo(2, 5);
    expect(local.p().y).toBeCloseTo(-10 + 0.001, 4);
  });

  it("holds the particle off the surface by its radius, catching near misses", () => {
    const a = kernelSetup({ radius: 0.2 }, [0, 0.45, 0], [0, -4, 0], floor);
    a.step(0.1); // the ray is 0.4 + 0.2 long and reaches the floor
    expect(a.p().y).toBeCloseTo(0.2, 5);
    expect(a.p().vy).toBeGreaterThan(0);
  });

  it("reflects in world space under a turned local-space node", () => {
    // Rotated half a turn about X (local +Y is world -Y), node at the origin: local y = -0.1 is world y = 0.1.
    const flipped = [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
    const a = kernelSetup({ bounce: 1 }, [0, -0.1, 0], [0, 4, 0], floor, true, flipped);
    a.step();
    expect(a.p().vy).toBeCloseTo(-4, 5); // world up is local down
  });
});

/** The inverse of a rigid transform (rotation and translation), column-major. */
function invert(m: number[]): number[] {
  const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0];
  const t = [m[12], m[13], m[14]];
  return [...r, -(r[0] * t[0] + r[4] * t[1] + r[8] * t[2]), -(r[1] * t[0] + r[5] * t[1] + r[9] * t[2]), -(r[2] * t[0] + r[6] * t[1] + r[10] * t[2]), 1];
}
