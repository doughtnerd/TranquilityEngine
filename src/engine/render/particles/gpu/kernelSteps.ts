// Internal (ADR 0094, 0251): the kernel steps catalogue. Each built-in step (`KBuiltin`) is written here
// once per language, side by side: its KSL (`render/shaderSource`, compiled to WGSL and GLSL by
// `kernelShader.ts`) and its JavaScript (run by `kernelJs.ts`'s executor). `kernelSteps.test.ts` runs every
// step's KSL as JavaScript (the shader source module's third output) against its JavaScript on random
// particles, so the two can't drift. (The KSL's JavaScript output runs about 25× slower than the hand-written
// step, which is why the executor keeps its own.)
import { LUT_SAMPLES, U, type KLocal, type KStmt } from "../../../scene/particleKernel";
import { fl } from "../../shaderSource/shaderSource";
import { krand, noise3 } from "./kernelMath";

const DEG = Math.PI / 180;
const GRAVITY = 9.81;

/** What a step's JavaScript reads and writes: the particle being run and the system's buffers. */
export interface StepFrame {
  /** Particle state (16 floats a particle, `ATTR`'s layout). */
  s: Float32Array;
  /** Float offset of the particle (index × 16). */
  o: number;
  idx: number;
  /** Init: this particle's place in the frame's spawn (0, 1, …). */
  rel: number;
  /** Uniforms (vec4s; the header's slots are `U`'s). */
  u: Float32Array;
  lut: Float32Array;
  loc: Record<KLocal, Float64Array>;
  /** Update: the time step this particle advances (shorter when it dies this frame). */
  step: number;
  dies: boolean;
  /** Init from an event: the parent's world position and velocity. */
  parent: Float64Array | null;
  /** The system's capacity. */
  capacity: number;
}

export type BuiltinStmt = Extract<KStmt, { s: "builtin" }>;

/** One built-in step in both languages. */
export interface KernelStep {
  /** KSL functions the stage's call (`k_<name>(…)`) runs; they read the globals in `KERNEL_GLOBALS_KSL`. */
  readonly ksl: string;
  /** The same step in JavaScript, on the particle at `f.o`, with its arguments' values (`arg[i]`, scalars at `[0]`). */
  js(f: StepFrame, arg: readonly Float64Array[], st: BuiltinStmt): void;
}

/** Private globals every stage reads. */
export const KERNEL_GLOBALS_KSL = /* KSL */ `
GLOBAL(KV4, a0);
GLOBAL(KV4, a1);
GLOBAL(KV4, a2);
GLOBAL(KV4, a3);
GLOBAL(KF, k_idx);
GLOBAL(KF, k_rel);
GLOBAL(KF, k_sidx);
GLOBAL(KF, k_t);
GLOBAL(KF, k_step);
GLOBAL(KF, k_dies);
GLOBAL(KF, k_speedMod);
GLOBAL(KV3, k_spos);
GLOBAL(KV3, k_sdir);
GLOBAL(KF, k_hasParent);
GLOBAL(KV3, k_parentPos);
GLOBAL(KV3, k_parentVel);
GLOBAL(KV4, k_oColor);
GLOBAL(KF, k_oSize);
GLOBAL(KF, k_oTile);
`;

/** Helpers the steps and output stages call: look-up rows (needs `k_lutAt(row, i)`), and the node's matrices from the header. */
export const KERNEL_HELPERS_KSL = /* KSL */ `FN(KV4, k_lut, KI row, KF t) {
  VAR(KF, x) = clamp(t, 0.0, 1.0) * ${fl(LUT_SAMPLES - 1)};
  VAR(KF, f0) = floor(x);
  VAR(KI, i0) = KI(f0);
  VAR(KI, i1) = min(${LUT_SAMPLES - 1}, i0 + 1);
  return mix(k_lutAt(row, i0), k_lutAt(row, i1), x - f0);
}
FN(KV3, k_mat3, KI s, KV3 v) {
  return KV3(dot(ku[s].xyz, v), dot(ku[s + 1].xyz, v), dot(ku[s + 2].xyz, v));
}
FN(KV3, k_xform, KV3 p) {
  return ku[${U.matrix}].xyz * p.x + ku[${U.matrix + 1}].xyz * p.y + ku[${U.matrix + 2}].xyz * p.z + ku[${U.matrix + 3}].xyz;
}
FN(KV3, k_xformDir, KV3 v) {
  return ku[${U.matrix}].xyz * v.x + ku[${U.matrix + 1}].xyz * v.y + ku[${U.matrix + 2}].xyz * v.z;
}
FN(KV3, k_inverse, KV3 p) {
  return ku[${U.inverse}].xyz * p.x + ku[${U.inverse + 1}].xyz * p.y + ku[${U.inverse + 2}].xyz * p.z + ku[${U.inverse + 3}].xyz;
}
FN(KV3, k_inverseDir, KV3 v) {
  return ku[${U.inverse}].xyz * v.x + ku[${U.inverse + 1}].xyz * v.y + ku[${U.inverse + 2}].xyz * v.z;
}
`;

/** The built-in steps but depth collision (GPU only, `DEPTH_STEP_KSL`). */
export const KERNEL_STEPS: Record<Exclude<BuiltinStmt["b"], "depth">, KernelStep> = {
  /** Age the particle; marks it dying when its life runs out this step. */
  age: {
    ksl: /* KSL */ `FN(void, k_age) {
  VAR(KF, life) = a1.w;
  if (a0.w + k_step >= life) {
    k_step = max(0.0, life - a0.w);
    k_dies = 1.0;
  }
  a0.w = a0.w + k_step;
  k_t = min(1.0, a0.w / life);
}
`,
    js(f, arg, st) {
      const s = f.s;
      const o = f.o;
      const life = s[o + 7];
      let step = f.step;
      if (s[o + 3] + step >= life) {
        step = Math.max(0, life - s[o + 3]);
        f.dies = true;
      }
      s[o + 3] += step;
      f.step = step;
      f.loc.t[0] = Math.min(1, s[o + 3] / life);
    },
  },
  /** Gravity: down in world space, or in the node's space for local systems. arg: strength. */
  gravity: {
    ksl: /* KSL */ `FN(void, k_gravity, KF strength) {
  VAR(KF, g) = strength * 9.81 * k_step;
  if (ku[${U.flags}].z > 0.5) {
    a1.y = a1.y - g;
  } else {
    VAR(KV3, down) = -ku[${U.inverse + 1}].xyz;
    VAR(KF, len) = length(down);
    if (len > 0.0) { down = down / len; }
    a1.x = a1.x + down.x * g;
    a1.y = a1.y + down.y * g;
    a1.z = a1.z + down.z * g;
  }
}
`,
    js(f, arg, st) {
      const g = arg[0][0] * GRAVITY * f.step;
      if (g === 0) return;
      const s = f.s;
      const o = f.o;
      if (f.u[U.flags * 4 + 2] === 1) s[o + 5] -= g;
      else {
        // Down in the node's space: the inverse matrix's rotation of (0, -1, 0), normalised.
        const iv = U.inverse * 4;
        let x = -f.u[iv + 4];
        let y = -f.u[iv + 5];
        let z = -f.u[iv + 6];
        const len = Math.hypot(x, y, z) || 1;
        x /= len;
        y /= len;
        z /= len;
        s[o + 4] += x * g;
        s[o + 5] += y * g;
        s[o + 6] += z * g;
      }
    },
  },
  /** A force over life. arg: force (vec3). */
  force: {
    ksl: /* KSL */ `FN(void, k_force, KV3 f) {
  a1.x = a1.x + f.x * k_step;
  a1.y = a1.y + f.y * k_step;
  a1.z = a1.z + f.z * k_step;
}
`,
    js(f, arg, st) {
      const v = arg[0];
      for (let i = 0; i < 3; i++) f.s[f.o + 4 + i] += v[i] * f.step;
    },
  },
  /** Point gravity. args: centre (vec3), strength. */
  gpoint: {
    ksl: /* KSL */ `FN(void, k_gpoint, KV3 c, KF strength) {
  VAR(KV3, d) = c - a0.xyz;
  VAR(KF, len) = length(d);
  if (len < 0.000001) { return; }
  VAR(KF, a) = strength / max(len * len, 0.0625) * k_step;
  a1.x = a1.x + d.x / len * a;
  a1.y = a1.y + d.y / len * a;
  a1.z = a1.z + d.z / len * a;
}
`,
    js(f, arg, st) {
      const c = arg[0];
      const strength = arg[1][0];
      const s = f.s;
      const o = f.o;
      const dx = c[0] - s[o];
      const dy = c[1] - s[o + 1];
      const dz = c[2] - s[o + 2];
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) return;
      const a = (strength / Math.max(len * len, 0.0625)) * f.step;
      s[o + 4] += (dx / len) * a;
      s[o + 5] += (dy / len) * a;
      s[o + 6] += (dz / len) * a;
    },
  },
  /** Turbulence: noise velocity over position and time. args: scale (vec3), octaves, velocity (vec3), time scale (vec3). */
  turbulence: {
    ksl: /* KSL */ `FN(KF, k_nz, KF v) {
  if (v == 0.0) { return 1.0; }
  return v;
}
FN(void, k_turbulence, KV3 sc, KF octaves, KV3 vel, KV3 ts) {
  VAR(KI, oct) = KI(clamp(floor(octaves + 0.5), 1.0, 4.0));
  VAR(KF, time) = ku[${U.time}].x;
  VAR(KF, x) = a0.x / k_nz(sc.x);
  VAR(KF, y) = a0.y / k_nz(sc.y);
  VAR(KF, z) = a0.z / k_nz(sc.z);
  VAR(KF, nx) = 0.0;
  VAR(KF, ny) = 0.0;
  VAR(KF, nz) = 0.0;
  VAR(KF, lvl) = 1.0;
  for (VAR(KI, i) = 0; i < oct; i++) {
    nx = nx + k_noise3(x * lvl + time * ts.x * lvl, y * lvl, z * lvl) / lvl;
    ny = ny + k_noise3(x * lvl + 31.7, y * lvl + time * ts.y * lvl, z * lvl) / lvl;
    nz = nz + k_noise3(x * lvl, y * lvl + 17.3, z * lvl + time * ts.z * lvl) / lvl;
    lvl = lvl * 2.0;
  }
  a1.x = a1.x + nx * vel.x * k_step;
  a1.y = a1.y + ny * vel.y * k_step;
  a1.z = a1.z + nz * vel.z * k_step;
}
`,
    js(f, arg, st) {
      const sc = arg[0];
      const oct = Math.max(1, Math.min(4, Math.round(arg[1][0])));
      const vel = arg[2];
      const ts = arg[3];
      const s = f.s;
      const o = f.o;
      const time = f.u[U.time * 4];
      const x = s[o] / (sc[0] || 1);
      const y = s[o + 1] / (sc[1] || 1);
      const z = s[o + 2] / (sc[2] || 1);
      let nx = 0;
      let ny = 0;
      let nz = 0;
      let lvl = 1;
      for (let i = 0; i < oct; i++) {
        nx += noise3(x * lvl + time * ts[0] * lvl, y * lvl, z * lvl) / lvl;
        ny += noise3(x * lvl + 31.7, y * lvl + time * ts[1] * lvl, z * lvl) / lvl;
        nz += noise3(x * lvl, y * lvl + 17.3, z * lvl + time * ts[2] * lvl) / lvl;
        lvl *= 2;
      }
      s[o + 4] += nx * vel[0] * f.step;
      s[o + 5] += ny * vel[1] * f.step;
      s[o + 6] += nz * vel[2] * f.step;
    },
  },
  /** Limit speed with dampening. args: limit, dampen. */
  limit: {
    ksl: /* KSL */ `FN(void, k_limit, KF limit, KF dampen) {
  VAR(KF, speed) = length(a1.xyz);
  if (speed <= limit || speed < 0.000000001) { return; }
  VAR(KF, k) = 1.0 - pow(1.0 - clamp(dampen, 0.0, 1.0), k_step * 60.0);
  VAR(KF, m) = 1.0 + k * (max(0.0, limit) / speed - 1.0);
  a1.x = a1.x * m;
  a1.y = a1.y * m;
  a1.z = a1.z * m;
}
`,
    js(f, arg, st) {
      const limit = arg[0][0];
      const dampen = arg[1][0];
      const s = f.s;
      const o = f.o;
      const speed = Math.hypot(s[o + 4], s[o + 5], s[o + 6]);
      if (speed <= limit || speed < 1e-9) return;
      const k = 1 - Math.pow(1 - Math.min(1, Math.max(0, dampen)), f.step * 60);
      const m = 1 + k * (Math.max(0, limit) / speed - 1);
      s[o + 4] *= m;
      s[o + 5] *= m;
      s[o + 6] *= m;
    },
  },
  /** Position += velocity × speedMod × step. */
  integrate: {
    ksl: /* KSL */ `FN(void, k_integrate) {
  VAR(KF, k) = k_speedMod * k_step;
  a0.x = a0.x + a1.x * k;
  a0.y = a0.y + a1.y * k;
  a0.z = a0.z + a1.z * k;
}
`,
    js(f, arg, st) {
      const k = f.loc.speedMod[0] * f.step;
      const s = f.s;
      const o = f.o;
      s[o] += s[o + 4] * k;
      s[o + 1] += s[o + 5] * k;
      s[o + 2] += s[o + 6] * k;
    },
  },
  /** Noise on position and rotation (the difference of two samples, so it wanders without drifting). args: frequency, power, position amount, rotation amount; `st.index` tells noise blocks apart. */
  noise: {
    ksl: /* KSL */ `FN(void, k_noise, KF freq, KF power, KF pa, KF ra, KU index) {
  VAR(KF, seed) = a3.w;
  VAR(KF, now) = a0.w * freq;
  VAR(KF, before) = (a0.w - k_step) * freq;
  VAR(KU, base) = 3000u + index * 8u;
  if (pa > 0.0) {
    VAR(KF, o0) = k_rand(seed, base) * 100.0;
    VAR(KF, o1) = k_rand(seed, base + 1u) * 100.0;
    VAR(KF, o2) = k_rand(seed, base + 2u) * 100.0;
    a0.x = a0.x + (k_noise3(o0 + now, 0.5, 0.0) - k_noise3(o0 + before, 0.5, 0.0)) * power * pa;
    a0.y = a0.y + (k_noise3(o1 + now, 0.5, 0.0) - k_noise3(o1 + before, 0.5, 0.0)) * power * pa;
    a0.z = a0.z + (k_noise3(o2 + now, 0.5, 0.0) - k_noise3(o2 + before, 0.5, 0.0)) * power * pa;
  }
  if (ra > 0.0) {
    VAR(KF, o3) = k_rand(seed, base + 3u) * 100.0;
    a3.y = a3.y + (k_noise3(o3 + now, 0.5, 0.0) - k_noise3(o3 + before, 0.5, 0.0)) * 3.141592653589793 * power * ra;
  }
}
`,
    js(f, arg, st) {
      const index = st.index ?? 0;
      const freq = arg[0][0];
      const power = arg[1][0];
      const pa = arg[2][0];
      const ra = arg[3][0];
      const s = f.s;
      const o = f.o;
      const seed = s[o + 15];
      const now = s[o + 3] * freq;
      const before = (s[o + 3] - f.step) * freq;
      const off = (i: number) => krand(seed, 3000 + index * 8 + i) * 100;
      if (pa > 0) for (let i = 0; i < 3; i++) s[o + i] += (noise3(off(i) + now, 0.5, 0) - noise3(off(i) + before, 0.5, 0)) * power * pa;
      if (ra > 0) s[o + 13] += (noise3(off(3) + now, 0.5, 0) - noise3(off(3) + before, 0.5, 0)) * Math.PI * power * ra;
    },
  },
  /** Orbit around the node's axis. args: speed (°/s), axis (vec3). */
  orbit: {
    ksl: /* KSL */ `FN(void, k_orbit, KF speed, KV3 axis0) {
  VAR(KV3, axis) = axis0;
  VAR(KV3, c) = KV3(0.0, 0.0, 0.0);
  if (ku[${U.flags}].z > 0.5) {
    axis = k_xformDir(axis);
    c = ku[${U.matrix + 3}].xyz;
  }
  VAR(KF, len) = length(axis);
  if (len < 0.000000001) { return; }
  axis = axis / len;
  VAR(KF, angle) = speed * 0.017453292519943295 * k_step;
  VAR(KV3, r) = a0.xyz - c;
  VAR(KF, d) = dot(r, axis);
  VAR(KF, co) = cos(angle);
  VAR(KF, sn) = sin(angle);
  VAR(KV3, p) = c + r * co + cross(axis, r) * sn + axis * d * (1.0 - co);
  a0.x = p.x;
  a0.y = p.y;
  a0.z = p.z;
}
`,
    js(f, arg, st) {
      let [ax, ay, az] = arg[1];
      let cx = 0;
      let cy = 0;
      let cz = 0;
      const m = U.matrix * 4;
      if (f.u[U.flags * 4 + 2] === 1) {
        const rx = f.u[m] * ax + f.u[m + 4] * ay + f.u[m + 8] * az;
        const ry = f.u[m + 1] * ax + f.u[m + 5] * ay + f.u[m + 9] * az;
        const rz = f.u[m + 2] * ax + f.u[m + 6] * ay + f.u[m + 10] * az;
        ax = rx;
        ay = ry;
        az = rz;
        cx = f.u[m + 12];
        cy = f.u[m + 13];
        cz = f.u[m + 14];
      }
      const len = Math.hypot(ax, ay, az);
      if (len < 1e-9) return;
      ax /= len;
      ay /= len;
      az /= len;
      const angle = arg[0][0] * DEG * f.step;
      const s = f.s;
      const o = f.o;
      const rx = s[o] - cx;
      const ry = s[o + 1] - cy;
      const rz = s[o + 2] - cz;
      const dot = rx * ax + ry * ay + rz * az;
      const c = Math.cos(angle);
      const sn = Math.sin(angle);
      s[o] = cx + rx * c + (ay * rz - az * ry) * sn + ax * dot * (1 - c);
      s[o + 1] = cy + ry * c + (az * rx - ax * rz) * sn + ay * dot * (1 - c);
      s[o + 2] = cz + rz * c + (ax * ry - ay * rx) * sn + az * dot * (1 - c);
    },
  },
  /** Collide with a horizontal plane. args: height, bounce, kill (0/1). */
  plane: {
    ksl: /* KSL */ `FN(void, k_plane, KF h, KF bounce, KF kill) {
  if (a0.y >= h) { return; }
  if (kill > 0.5) {
    k_dies = 1.0;
    a0.w = a1.w;
    return;
  }
  a0.y = h;
  if (a1.y < 0.0) { a1.y = -a1.y * bounce; }
}
`,
    js(f, arg, st) {
      const h = arg[0][0];
      const s = f.s;
      const o = f.o;
      if (s[o + 1] >= h) return;
      if (arg[2][0] > 0.5) {
        f.dies = true;
        s[o + 3] = s[o + 7];
        return;
      }
      s[o + 1] = h;
      if (s[o + 5] < 0) s[o + 5] = -s[o + 5] * arg[1][0];
    },
  },
  /** Rotation over life. arg: speed (°/s). */
  spin: {
    ksl: /* KSL */ `FN(void, k_spin, KF speed) {
  a3.y = a3.y + speed * 0.017453292519943295 * k_step;
}
`,
    js(f, arg, st) {
      f.s[f.o + 13] += arg[0][0] * DEG * f.step;
    },
  },
  /** Init: position and velocity from the shape sample, the node (or the parent particle) and the space. args: offset (vec3), speed. */
  place: {
    ksl: /* KSL */ `FN(void, k_place, KV3 offset, KF speed) {
  VAR(KV3, n) = k_spos + offset;
  VAR(KF, world) = ku[${U.flags}].z;
  if (world < 0.5 && k_hasParent < 0.5) {
    a0.x = n.x;
    a0.y = n.y;
    a0.z = n.z;
    a1.x = k_sdir.x * speed;
    a1.y = k_sdir.y * speed;
    a1.z = k_sdir.z * speed;
    return;
  }
  VAR(KV3, origin) = ku[${U.matrix + 3}].xyz;
  if (k_hasParent > 0.5) { origin = k_parentPos; }
  VAR(KV3, wp) = k_xformDir(n) + origin;
  VAR(KV3, v) = k_xformDir(k_sdir);
  VAR(KF, len) = length(v);
  if (len > 0.000000001) { v = v * (speed / len); } else { v = KV3(0.0, 0.0, 0.0); }
  if (k_hasParent > 0.5 && ku[${U.event}].w > 0.5) { v = v + k_parentVel; }
  if (world < 0.5) {
    wp = k_inverse(wp);
    v = k_inverseDir(v);
  }
  a0.x = wp.x;
  a0.y = wp.y;
  a0.z = wp.z;
  a1.x = v.x;
  a1.y = v.y;
  a1.z = v.z;
}
`,
    js(f, arg, st) {
      const u = f.u;
      const offset = arg[0];
      const speed = arg[1][0];
      const s = f.s;
      const o = f.o;
      const p = f.loc.spos;
      const d = f.loc.sdir;
      const nx = p[0] + offset[0];
      const ny = p[1] + offset[1];
      const nz = p[2] + offset[2];
      const world = u[U.flags * 4 + 2] === 1;
      if (!world && !f.parent) {
        s[o] = nx;
        s[o + 1] = ny;
        s[o + 2] = nz;
        s[o + 4] = d[0] * speed;
        s[o + 5] = d[1] * speed;
        s[o + 6] = d[2] * speed;
        return;
      }
      const m = U.matrix * 4;
      const ox = f.parent ? f.parent[0] : u[m + 12];
      const oy = f.parent ? f.parent[1] : u[m + 13];
      const oz = f.parent ? f.parent[2] : u[m + 14];
      const wx = u[m] * nx + u[m + 4] * ny + u[m + 8] * nz + ox;
      const wy = u[m + 1] * nx + u[m + 5] * ny + u[m + 9] * nz + oy;
      const wz = u[m + 2] * nx + u[m + 6] * ny + u[m + 10] * nz + oz;
      let vx = u[m] * d[0] + u[m + 4] * d[1] + u[m + 8] * d[2];
      let vy = u[m + 1] * d[0] + u[m + 5] * d[1] + u[m + 9] * d[2];
      let vz = u[m + 2] * d[0] + u[m + 6] * d[1] + u[m + 10] * d[2];
      const len = Math.hypot(vx, vy, vz);
      const k = len > 1e-9 ? speed / len : 0;
      vx *= k;
      vy *= k;
      vz *= k;
      if (f.parent && u[U.event * 4 + 3] === 1) {
        vx += f.parent[3];
        vy += f.parent[4];
        vz += f.parent[5];
      }
      if (world) {
        s[o] = wx;
        s[o + 1] = wy;
        s[o + 2] = wz;
        s[o + 4] = vx;
        s[o + 5] = vy;
        s[o + 6] = vz;
        return;
      }
      const iv = U.inverse * 4;
      s[o] = u[iv] * wx + u[iv + 4] * wy + u[iv + 8] * wz + u[iv + 12];
      s[o + 1] = u[iv + 1] * wx + u[iv + 5] * wy + u[iv + 9] * wz + u[iv + 13];
      s[o + 2] = u[iv + 2] * wx + u[iv + 6] * wy + u[iv + 10] * wz + u[iv + 14];
      s[o + 4] = u[iv] * vx + u[iv + 4] * vy + u[iv + 8] * vz;
      s[o + 5] = u[iv + 1] * vx + u[iv + 5] * vy + u[iv + 9] * vz;
      s[o + 6] = u[iv + 2] * vx + u[iv + 6] * vy + u[iv + 10] * vz;
    },
  },
  /** Init: sample the spawn shape into `spos`/`sdir` (`st.shape`: type and mode; `st.rotation`: the rotation's uniform slot). args: radius, angle, arc, thickness, width, height, donutRadius, columns, rows, spread. Its KSL is `k_shapeU` here and the type's `k_shape` from `shapeKsl`. */
  shape: {
    ksl: /* KSL */ `FN(KF, k_shapeU, KI mode, KF spread) {
  VAR(KF, r) = k_rand(a3.w, 900u);
  if (mode == 0) { return r; }
  VAR(KF, cap) = ku[${U.spawn}].z;
  VAR(KF, rel) = k_rel;
  if (mode == 3) { return rel / max(1.0, ku[${U.spawn}].y); }
  VAR(KF, ordinal) = ku[${U.misc}].x + rel;
  VAR(KF, x) = ordinal / max(1.0, cap);
  if (spread > 0.0) { x = ordinal * spread; }
  if (mode == 1) { return x - floor(x); }
  VAR(KF, m) = x - 2.0 * floor(x / 2.0);
  if (m < 1.0) { return m; }
  return 2.0 - m;
}
`,
    js(f, arg, st) {
      const type = st.shape?.type ?? "point";
      const mode = st.shape?.mode ?? "random";
      const [radius, angle, arc, thickness, width, height, donutRadius, columns, rows, spread] = arg.map((x) => x[0]);
      const seed = f.s[f.o + 15];
      const r = (k: number) => krand(seed, 900 + k);
      const p = f.loc.spos;
      const d = f.loc.sdir;
      p.fill(0);
      d[0] = 0;
      d[1] = 1;
      d[2] = 0;
      // u along the arc: random, or by spawn order for loop/ping-pong/burst.
      let uu = r(0);
      if (mode !== "random") {
        const cap = f.capacity;
        const ordinal = f.u[U.misc * 4] + f.rel;
        const n = Math.max(1, f.u[U.spawn * 4 + 1]);
        if (mode === "burst") uu = f.rel / n;
        else {
          const x = spread > 0 ? ordinal * spread : ordinal / Math.max(1, cap);
          uu = mode === "loop" ? x - Math.floor(x) : ((m) => (m < 1 ? m : 2 - m))(x - 2 * Math.floor(x / 2));
        }
      }
      const theta = uu * arc * DEG;
      const th = Math.min(1, Math.max(0, thickness));
      const inner = 1 - th;
      switch (type) {
        case "sphere":
        case "hemisphere": {
          const cosP = type === "sphere" ? 2 * r(1) - 1 : r(1);
          const sinP = Math.sqrt(Math.max(0, 1 - cosP * cosP));
          const dx = sinP * Math.cos(theta);
          const dz = sinP * Math.sin(theta);
          const rr = radius * Math.cbrt(inner * inner * inner + r(2) * (1 - inner * inner * inner));
          p[0] = dx * rr;
          p[1] = cosP * rr;
          p[2] = dz * rr;
          d[0] = dx;
          d[1] = cosP;
          d[2] = dz;
          break;
        }
        case "cone": {
          const rr = Math.sqrt(inner * inner + r(1) * (1 - inner * inner));
          p[0] = Math.cos(theta) * radius * rr;
          p[2] = Math.sin(theta) * radius * rr;
          const ang = angle * DEG * (radius > 0 ? rr : Math.sqrt(r(2)));
          d[0] = Math.sin(ang) * Math.cos(theta);
          d[1] = Math.cos(ang);
          d[2] = Math.sin(ang) * Math.sin(theta);
          break;
        }
        case "circle": {
          const rr = Math.sqrt(inner * inner + r(1) * (1 - inner * inner));
          p[0] = Math.cos(theta) * radius * rr;
          p[2] = Math.sin(theta) * radius * rr;
          if (rr > 0 && radius > 0) {
            d[0] = Math.cos(theta);
            d[1] = 0;
            d[2] = Math.sin(theta);
          }
          break;
        }
        case "donut": {
          const cx = Math.cos(theta);
          const cz = Math.sin(theta);
          const psi = r(1) * Math.PI * 2;
          const tr = donutRadius * Math.sqrt(inner * inner + r(2) * (1 - inner * inner));
          const ox = tr * Math.cos(psi) * cx;
          const oy = tr * Math.sin(psi);
          const oz = tr * Math.cos(psi) * cz;
          p[0] = cx * radius + ox;
          p[1] = oy;
          p[2] = cz * radius + oz;
          const len = Math.hypot(ox, oy, oz);
          if (len > 1e-9) {
            d[0] = ox / len;
            d[1] = oy / len;
            d[2] = oz / len;
          } else {
            d[0] = cx;
            d[1] = 0;
            d[2] = cz;
          }
          break;
        }
        case "rectangle": {
          let x = uu - 0.5;
          let z = r(1) - 0.5;
          if (th < 1) {
            const ix = 0.5 * inner;
            if (Math.abs(x) < ix && Math.abs(z) < ix) {
              if (0.5 - Math.abs(x) < 0.5 - Math.abs(z)) x = Math.sign(x || 1) * 0.5;
              else z = Math.sign(z || 1) * 0.5;
            }
          }
          p[0] = x * width;
          p[2] = z * height;
          break;
        }
        case "grid": {
          const cols = Math.max(1, Math.round(columns));
          const rws = Math.max(1, Math.round(rows));
          const i = mode === "random" ? Math.floor(r(1) * cols * rws) : Math.min(cols * rws - 1, Math.floor(uu * cols * rws));
          p[0] = (((i % cols) + 0.5) / cols - 0.5) * width;
          p[2] = ((Math.floor(i / cols) + 0.5) / rws - 0.5) * height;
          break;
        }
        default:
      }
      if (st.rotation !== undefined) {
        const b = st.rotation * 4;
        const R = f.u;
        const rot = (v: Float64Array) => {
          const x = v[0];
          const y = v[1];
          const z = v[2];
          v[0] = R[b] * x + R[b + 1] * y + R[b + 2] * z;
          v[1] = R[b + 4] * x + R[b + 5] * y + R[b + 6] * z;
          v[2] = R[b + 8] * x + R[b + 9] * y + R[b + 10] * z;
        };
        rot(p);
        rot(d);
      }
    },
  },
};

/** Every step's KSL, in one text, as the shaders include it. */
export const KERNEL_STEPS_KSL = `\n${Object.values(KERNEL_STEPS).map((s) => s.ksl).join("")}`;

/** Shape samplers, one per type (as `kernelJs.ts`'s `shape`). Each sets k_spos/k_sdir. */
const SHAPES: Record<string, string> = {
  point: "",
  sphere: /* KSL */ `
  VAR(KF, cosP) = 2.0 * k_rand(a3.w, 901u) - 1.0;
  SPHERE_BODY`,
  hemisphere: /* KSL */ `
  VAR(KF, cosP) = k_rand(a3.w, 901u);
  SPHERE_BODY`,
  cone: /* KSL */ `
  VAR(KF, rr) = sqrt(inner * inner + k_rand(a3.w, 901u) * (1.0 - inner * inner));
  k_spos = KV3(cos(theta) * radius * rr, 0.0, sin(theta) * radius * rr);
  VAR(KF, f) = sqrt(k_rand(a3.w, 902u));
  if (radius > 0.0) { f = rr; }
  VAR(KF, ang) = angle * 0.017453292519943295 * f;
  k_sdir = KV3(sin(ang) * cos(theta), cos(ang), sin(ang) * sin(theta));`,
  circle: /* KSL */ `
  VAR(KF, rr) = sqrt(inner * inner + k_rand(a3.w, 901u) * (1.0 - inner * inner));
  k_spos = KV3(cos(theta) * radius * rr, 0.0, sin(theta) * radius * rr);
  if (rr > 0.0 && radius > 0.0) { k_sdir = KV3(cos(theta), 0.0, sin(theta)); }`,
  donut: /* KSL */ `
  VAR(KF, cx) = cos(theta);
  VAR(KF, cz) = sin(theta);
  VAR(KF, psi) = k_rand(a3.w, 901u) * 6.283185307179586;
  VAR(KF, tr) = donutRadius * sqrt(inner * inner + k_rand(a3.w, 902u) * (1.0 - inner * inner));
  VAR(KV3, o) = KV3(tr * cos(psi) * cx, tr * sin(psi), tr * cos(psi) * cz);
  k_spos = KV3(cx * radius, 0.0, cz * radius) + o;
  VAR(KF, len) = length(o);
  if (len > 0.000000001) { k_sdir = o / len; } else { k_sdir = KV3(cx, 0.0, cz); }`,
  rectangle: /* KSL */ `
  VAR(KF, x) = u - 0.5;
  VAR(KF, z) = k_rand(a3.w, 901u) - 0.5;
  if (th < 1.0) {
    VAR(KF, ix) = 0.5 * inner;
    if (abs(x) < ix && abs(z) < ix) {
      VAR(KF, sx) = 1.0;
      if (x < 0.0) { sx = -1.0; }
      VAR(KF, sz) = 1.0;
      if (z < 0.0) { sz = -1.0; }
      if (0.5 - abs(x) < 0.5 - abs(z)) { x = sx * 0.5; } else { z = sz * 0.5; }
    }
  }
  k_spos = KV3(x * width, 0.0, z * height);`,
  grid: /* KSL */ `
  VAR(KF, cols) = max(1.0, floor(columns + 0.5));
  VAR(KF, rws) = max(1.0, floor(rows + 0.5));
  VAR(KF, i) = min(cols * rws - 1.0, floor(u * cols * rws));
  if (mode == 0) { i = floor(k_rand(a3.w, 901u) * cols * rws); }
  k_spos = KV3(((i - floor(i / cols) * cols + 0.5) / cols - 0.5) * width, 0.0, ((floor(i / cols) + 0.5) / rws - 0.5) * height);`,
};

const SPHERE_BODY = /* KSL */ `
  VAR(KF, sinP) = sqrt(max(0.0, 1.0 - cosP * cosP));
  VAR(KF, dx) = sinP * cos(theta);
  VAR(KF, dz) = sinP * sin(theta);
  VAR(KF, in3) = inner * inner * inner;
  VAR(KF, rr) = radius * pow(in3 + k_rand(a3.w, 902u) * (1.0 - in3), 1.0 / 3.0);
  k_spos = KV3(dx * rr, cosP * rr, dz * rr);
  k_sdir = KV3(dx, cosP, dz);`;

/** Shape modes as `k_shape`'s last argument. */
export const SHAPE_MODES: Record<string, number> = { random: 0, loop: 1, pingpong: 2, burst: 3 };

/** The KSL `k_shape` sampler for a shape type (each sets `k_spos`/`k_sdir`). */
export function shapeKsl(type: string): string {
  const body = (SHAPES[type] ?? "").replace("SPHERE_BODY", SPHERE_BODY);
  return /* KSL */ `
FN(void, k_shape, KF radius, KF angle, KF arc, KF thickness, KF width, KF height, KF donutRadius, KF columns, KF rows, KF spread, KI mode) {
  k_spos = KV3(0.0, 0.0, 0.0);
  k_sdir = KV3(0.0, 1.0, 0.0);
  VAR(KF, u) = k_shapeU(mode, spread);
  VAR(KF, theta) = u * arc * 0.017453292519943295;
  VAR(KF, th) = clamp(thickness, 0.0, 1.0);
  VAR(KF, inner) = 1.0 - th;
  ${body}
}
`;
}


/** Depth collision (GPU only): needs `k_depthAt(x, y)`. Reflects particles that went behind the scene's depth. */
export const DEPTH_STEP_KSL = /* KSL */ `
FN(void, k_depthCollide, KF bounce, KF kill, KF thickness) {
  if (ku[${U.depth}].z < 0.5) { return; }
  VAR(KV3, p) = a0.xyz;
  if (ku[${U.flags}].z < 0.5) { p = k_xform(p); }
  VAR(KV4, clip) = ku[${U.viewProj}] * p.x + ku[${U.viewProj + 1}] * p.y + ku[${U.viewProj + 2}] * p.z + ku[${U.viewProj + 3}];
  if (clip.w <= 0.0) { return; }
  VAR(KV2, ndc) = clip.xy / clip.w;
  if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) { return; }
  VAR(KF, px) = floor((ndc.x * 0.5 + 0.5) * ku[${U.depth}].x);
  VAR(KF, py) = floor((0.5 - ndc.y * 0.5) * ku[${U.depth}].y);
  VAR(KF, scene) = k_depthAt(KI(min(px, ku[${U.depth}].x - 1.0)), KI(min(py, ku[${U.depth}].y - 1.0)));
  // The depth texture holds camera-space z (Babylon's depth renderer with storeCameraSpaceZ); 0 is "nothing drawn".
  VAR(KF, viewDepth) = abs(dot(ku[${U.viewZ}].xyz, p) + ku[${U.viewZ}].w);
  VAR(KF, sceneDepth) = abs(scene);
  if (sceneDepth == 0.0) { return; }
  if (viewDepth < sceneDepth || viewDepth > sceneDepth + thickness) { return; }
  if (kill > 0.5) {
    k_dies = 1.0;
    a0.w = a1.w;
    return;
  }
  a0.x = a0.x - a1.x * k_step * k_speedMod;
  a0.y = a0.y - a1.y * k_step * k_speedMod;
  a0.z = a0.z - a1.z * k_step * k_speedMod;
  a1.x = -a1.x * bounce;
  a1.y = -a1.y * bounce;
  a1.z = -a1.z * bounce;
}
`;
