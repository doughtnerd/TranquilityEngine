// Internal (ADR 0094): kernel programs as shaders. One source language, KSL, is turned into WGSL
// (WebGPU compute and draw) and GLSL ES 3.0 (the WebGL2 texture simulation and draw), so the
// built-in steps are written once. KSL is the common subset of both, with:
// - types KF, KV2, KV3, KV4, KU, KI (f32/float, vec2f/vec2, …, u32/uint, i32/int);
// - `VAR(T, name)` for a mutable local, `GLOBAL(T, name);` for a private global;
// - `FN(R, name, T a, T b) {` for a function (R may be `void`);
// - `KBITU(i)` to reinterpret an int as uint;
// - no ternaries, no multi-component swizzle writes, no implicit int/float conversions, and
//   parentheses around every mix of bitwise and arithmetic operators (WGSL requires them).
// It mirrors `kernelJs.ts` line for line; a browser test compares them (`tests/e2e/gpuParticles.spec.ts`).
import {
  ATTR,
  LOCAL_WIDTH,
  LUT_SAMPLES,
  U,
  widthOf,
  type KExpr,
  type KLocal,
  type KStmt,
  type KernelOutput,
  type KernelSystem,
} from "../../../scene/particleKernel";

export type ShaderDialect = "wgsl" | "glsl";

// --- KSL to WGSL / GLSL ---------------------------------------------------------------------------------

const TYPES: Record<ShaderDialect, Record<string, string>> = {
  wgsl: { KF: "f32", KV2: "vec2f", KV3: "vec3f", KV4: "vec4f", KU: "u32", KI: "i32", KB: "bool" },
  glsl: { KF: "float", KV2: "vec2", KV3: "vec3", KV4: "vec4", KU: "uint", KI: "int", KB: "bool" },
};

/** Split a parameter list at top-level commas. */
function splitParams(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Translate KSL source to `dialect`. */
export function ksl(src: string, dialect: ShaderDialect): string {
  let s = src;
  s = s.replace(/FN\(([^,]+),\s*(\w+)((?:,[^)]*)?)\)\s*\{/g, (_m, ret: string, name: string, rest: string) => {
    const params = splitParams(rest.replace(/^,/, "")).map((p) => p.split(/\s+/));
    if (dialect === "glsl") return `${ret.trim()} ${name}(${params.map(([t, n]) => `${t} ${n}`).join(", ")}) {`;
    const r = ret.trim() === "void" ? "" : ` -> ${ret.trim()}`;
    return `fn ${name}(${params.map(([t, n]) => `${n}: ${t}`).join(", ")})${r} {`;
  });
  s = s.replace(/VAR\((\w+),\s*(\w+)\)/g, (_m, t: string, n: string) => (dialect === "glsl" ? `${t} ${n}` : `var ${n}: ${t}`));
  s = s.replace(/GLOBAL\((\w+),\s*(\w+)\)/g, (_m, t: string, n: string) => (dialect === "glsl" ? `${t} ${n}` : `var<private> ${n}: ${t}`));
  s = s.replace(/KBITU\(/g, dialect === "glsl" ? "uint(" : "bitcast<u32>(");
  const types = TYPES[dialect];
  s = s.replace(/\b(KF|KV2|KV3|KV4|KU|KI|KB)\b/g, (t) => types[t]);
  return s;
}

/** A float literal both languages accept. */
export function fl(n: number): string {
  if (!Number.isFinite(n)) n = n > 0 ? 3.4e38 : n < 0 ? -3.4e38 : 0;
  const s = String(n);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

// --- shared prelude (hashes, noise, colour, the built-in steps) ------------------------------------------

/** KSL helpers every kernel shader includes. Needs `k_lutAt(row, i)` and the globals from `globals()`. */
const PRELUDE = /* KSL */ `
FN(KU, k_pcg, KU v) {
  VAR(KU, state) = (v * 747796405u) + 2891336453u;
  VAR(KU, word) = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
FN(KF, k_rand, KF seed, KU salt) {
  return KF(k_pcg(KU(floor(seed * 16777216.0)) ^ k_pcg(salt)) >> 8u) / 16777216.0;
}
FN(KF, k_seed, KF index, KF frame, KF sys) {
  return KF(k_pcg(KU(index) ^ k_pcg(KU(frame) ^ k_pcg(KU(sys)))) >> 8u) / 16777216.0;
}
FN(KU, k_hashInt, KU x0) {
  VAR(KU, x) = x0;
  x = (x ^ (x >> 16u)) * 0x85ebca6bu;
  x = (x ^ (x >> 13u)) * 0xc2b2ae35u;
  return x ^ (x >> 16u);
}
FN(KF, k_lattice, KI x, KI y, KI z) {
  return KF(k_hashInt((KBITU(x) * 73856093u) ^ (KBITU(y) * 19349663u) ^ (KBITU(z) * 83492791u))) / 4294967296.0 * 2.0 - 1.0;
}
FN(KF, k_fade, KF t) {
  return t * t * (3.0 - 2.0 * t);
}
FN(KF, k_noise3, KF x, KF y, KF z) {
  VAR(KF, fx0) = floor(x);
  VAR(KF, fy0) = floor(y);
  VAR(KF, fz0) = floor(z);
  VAR(KI, ix) = KI(fx0);
  VAR(KI, iy) = KI(fy0);
  VAR(KI, iz) = KI(fz0);
  VAR(KF, fx) = k_fade(x - fx0);
  VAR(KF, fy) = k_fade(y - fy0);
  VAR(KF, fz) = k_fade(z - fz0);
  VAR(KF, a) = mix(mix(k_lattice(ix, iy, iz), k_lattice(ix + 1, iy, iz), fx), mix(k_lattice(ix, iy + 1, iz), k_lattice(ix + 1, iy + 1, iz), fx), fy);
  VAR(KF, b) = mix(mix(k_lattice(ix, iy, iz + 1), k_lattice(ix + 1, iy, iz + 1), fx), mix(k_lattice(ix, iy + 1, iz + 1), k_lattice(ix + 1, iy + 1, iz + 1), fx), fy);
  return mix(a, b, fz);
}
FN(KF, k_hash1, KI n, KI seed) {
  VAR(KU, x) = (KBITU(n) * 374761393u) + (KBITU(seed) * 668265263u);
  x = (x ^ (x >> 13u)) * 1274126177u;
  x = x ^ (x >> 16u);
  return KF(x) / 4294967295.0 * 2.0 - 1.0;
}
FN(KF, k_vnoise, KF x, KI seed) {
  VAR(KF, fi) = floor(x);
  VAR(KI, i) = KI(fi);
  VAR(KF, f) = x - fi;
  VAR(KF, u) = f * f * (3.0 - 2.0 * f);
  VAR(KF, a) = k_hash1(i, seed);
  return a + (k_hash1(i + 1, seed) - a) * u;
}
FN(KV4, k_hsv, KF h, KF s, KF v, KF a) {
  VAR(KF, hh) = (h - floor(h)) * 6.0;
  VAR(KF, fi) = floor(hh);
  VAR(KF, f) = hh - fi;
  VAR(KF, p) = v * (1.0 - s);
  VAR(KF, q) = v * (1.0 - s * f);
  VAR(KF, t) = v * (1.0 - s * (1.0 - f));
  VAR(KI, i) = KI(fi) % 6;
  if (i == 0) { return KV4(v, t, p, a); }
  if (i == 1) { return KV4(q, v, p, a); }
  if (i == 2) { return KV4(p, v, t, a); }
  if (i == 3) { return KV4(p, q, v, a); }
  if (i == 4) { return KV4(t, p, v, a); }
  return KV4(v, p, q, a);
}
FN(KF, k_lin, KF c) {
  return mix(pow((max(c, 0.0) + 0.055) / 1.055, 2.4), c / 12.92, step(c, 0.04045));
}
FN(KV4, k_toLinear, KV4 c) {
  return KV4(k_lin(c.x), k_lin(c.y), k_lin(c.z), c.w);
}
FN(KV4, k_lut, KI row, KF t) {
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

/** Private globals every stage reads. */
const GLOBALS = /* KSL */ `
GLOBAL(KV4, a0);
GLOBAL(KV4, a1);
GLOBAL(KV4, a2);
GLOBAL(KV4, a3);
GLOBAL(KF, k_idx);
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

/** The update stage's built-in steps (as `kernelJs.ts`). */
const STEPS = /* KSL */ `
FN(void, k_age) {
  VAR(KF, life) = a1.w;
  if (a0.w + k_step >= life) {
    k_step = max(0.0, life - a0.w);
    k_dies = 1.0;
  }
  a0.w = a0.w + k_step;
  k_t = min(1.0, a0.w / life);
}
FN(void, k_gravity, KF strength) {
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
FN(void, k_force, KV3 f) {
  a1.x = a1.x + f.x * k_step;
  a1.y = a1.y + f.y * k_step;
  a1.z = a1.z + f.z * k_step;
}
FN(void, k_gpoint, KV3 c, KF strength) {
  VAR(KV3, d) = c - a0.xyz;
  VAR(KF, len) = length(d);
  if (len < 0.000001) { return; }
  VAR(KF, a) = strength / max(len * len, 0.0625) * k_step;
  a1.x = a1.x + d.x / len * a;
  a1.y = a1.y + d.y / len * a;
  a1.z = a1.z + d.z / len * a;
}
FN(KF, k_nz, KF v) {
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
FN(void, k_limit, KF limit, KF dampen) {
  VAR(KF, speed) = length(a1.xyz);
  if (speed <= limit || speed < 0.000000001) { return; }
  VAR(KF, k) = 1.0 - pow(1.0 - clamp(dampen, 0.0, 1.0), k_step * 60.0);
  VAR(KF, m) = 1.0 + k * (max(0.0, limit) / speed - 1.0);
  a1.x = a1.x * m;
  a1.y = a1.y * m;
  a1.z = a1.z * m;
}
FN(void, k_integrate) {
  VAR(KF, k) = k_speedMod * k_step;
  a0.x = a0.x + a1.x * k;
  a0.y = a0.y + a1.y * k;
  a0.z = a0.z + a1.z * k;
}
FN(void, k_noise, KF freq, KF power, KF pa, KF ra, KU index) {
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
FN(void, k_orbit, KF speed, KV3 axis0) {
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
FN(void, k_plane, KF h, KF bounce, KF kill) {
  if (a0.y >= h) { return; }
  if (kill > 0.5) {
    k_dies = 1.0;
    a0.w = a1.w;
    return;
  }
  a0.y = h;
  if (a1.y < 0.0) { a1.y = -a1.y * bounce; }
}
FN(void, k_spin, KF speed) {
  a3.y = a3.y + speed * 0.017453292519943295 * k_step;
}
FN(void, k_place, KV3 offset, KF speed) {
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
FN(KF, k_shapeU, KI mode, KF spread) {
  VAR(KF, r) = k_rand(a3.w, 900u);
  if (mode == 0) { return r; }
  VAR(KF, cap) = ku[${U.spawn}].z;
  VAR(KF, rel) = k_idx - ku[${U.spawn}].x;
  rel = rel - floor(rel / cap) * cap;
  if (mode == 3) { return rel / max(1.0, ku[${U.spawn}].y); }
  VAR(KF, ordinal) = ku[${U.misc}].x + rel;
  VAR(KF, x) = ordinal / max(1.0, cap);
  if (spread > 0.0) { x = ordinal * spread; }
  if (mode == 1) { return x - floor(x); }
  VAR(KF, m) = x - 2.0 * floor(x / 2.0);
  if (m < 1.0) { return m; }
  return 2.0 - m;
}
`;

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

const MODES: Record<string, number> = { random: 0, loop: 1, pingpong: 2, burst: 3 };

function shapeFunction(type: string): string {
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

// --- expressions and statements -------------------------------------------------------------------------

const COMP = "xyzw";
const VEC = ["", "KF", "KV2", "KV3", "KV4"];
const LOCAL_NAME: Record<KLocal, string> = {
  t: "k_t",
  index: "k_idx",
  speed: "",
  spos: "k_spos",
  sdir: "k_sdir",
  speedMod: "k_speedMod",
  oColor: "k_oColor",
  oSize: "k_oSize",
  oTile: "k_oTile",
};

/** Emits KSL for a stage: expressions bound to temporaries, in order. */
class Emitter {
  readonly lines: string[] = [];
  private n = 0;
  constructor(
    private readonly prefix: string,
    private readonly dialect: ShaderDialect,
  ) {}

  private tmp(w: number, value: string): string {
    const name = `${this.prefix}${this.n++}`;
    this.lines.push(`VAR(${VEC[w]}, ${name}) = ${value};`);
    return name;
  }

  /** `s` (width `from`) as width `to`: a splat or a prefix swizzle. */
  private fit(s: string, from: number, to: number): string {
    if (from === to) return s;
    if (from === 1) return `${VEC[to]}(${s})`;
    return `${s}.${COMP.slice(0, to)}`;
  }

  /** Select between a and b (width w) by a boolean of width w. */
  private sel(cond: string, a: string, b: string, w: number): string {
    if (this.dialect === "wgsl") return `select(${b}, ${a}, ${cond})`;
    return w === 1 ? `((${cond}) ? (${a}) : (${b}))` : `mix(${b}, ${a}, ${cond})`;
  }

  private eq(a: string, b: string, w: number): string {
    if (this.dialect === "wgsl" || w === 1) return `(${a} == ${b})`;
    return `equal(${a}, ${b})`;
  }

  private safeDiv(a: string, b: string, w: number): string {
    const zero = w === 1 ? "0.0" : `${VEC[w]}(0.0)`;
    return this.sel(this.eq(b, zero, w), zero, `(${a} / ${b})`, w);
  }

  expr(e: KExpr): string {
    const w = widthOf(e);
    switch (e.k) {
      case "const":
        return w === 1 ? fl(e.v[0]) : `${VEC[w]}(${e.v.map(fl).join(", ")})`;
      case "uniform":
        return w === 4 ? `ku[${e.slot}]` : `ku[${e.slot}].${COMP.slice(0, w)}`;
      case "attr": {
        const [slot, comp, aw] = ATTR[e.name];
        return `a${slot}.${COMP.slice(comp, comp + aw)}`;
      }
      case "local":
        return e.name === "speed" ? "(length(a1.xyz) * k_speedMod)" : LOCAL_NAME[e.name];
      case "rand":
        return `k_rand(a3.w, ${e.salt >>> 0}u)`;
      case "lut": {
        const t = this.fit(this.expr(e.t), widthOf(e.t), 1);
        const v = this.tmp(4, `k_lut(${e.row}, ${t})`);
        return w === 1 ? `${v}.x` : v;
      }
      case "swz": {
        const iw = widthOf(e.e);
        const inner = this.expr(e.e);
        if (iw === 1) return inner;
        return `${this.tmp(iw, inner)}.${COMP[Math.min(e.i, iw - 1)]}`;
      }
      case "op":
        return this.tmp(w, this.op(e, w));
    }
  }

  private op(e: Extract<KExpr, { k: "op" }>, w: number): string {
    const raw = e.args.map((a) => [this.expr(a), widthOf(a)] as const);
    const a = raw.map(([s, aw]) => this.fit(s, aw, w));
    switch (e.op) {
      case "add":
        return `(${a[0]} + ${a[1]})`;
      case "sub":
        return `(${a[0]} - ${a[1]})`;
      case "mul":
        return `(${a[0]} * ${a[1]})`;
      case "div":
        return this.safeDiv(a[0], a[1], w);
      case "neg":
        return `(-${a[0]})`;
      case "abs":
        return `abs(${a[0]})`;
      case "min":
        return `min(${a[0]}, ${a[1]})`;
      case "max":
        return `max(${a[0]}, ${a[1]})`;
      case "clamp":
        return `min(max(${a[0]}, ${a[1]}), ${a[2]})`;
      case "lerp":
        return `mix(${a[0]}, ${a[1]}, ${a[2]})`;
      case "remap": {
        const [x, i0, i1, o0, o1] = a;
        const f = this.tmp(w, this.safeDiv(`(${x} - ${i0})`, `(${i1} - ${i0})`, w));
        return `(${o0} + ${f} * (${o1} - ${o0}))`;
      }
      case "step":
        return `step(${a[0]}, ${a[1]})`;
      case "smoothstep": {
        const [e0, e1, x] = a;
        const t = this.tmp(w, `clamp(${this.safeDiv(`(${x} - ${e0})`, `(${e1} - ${e0})`, w)}, ${this.fit("0.0", 1, w)}, ${this.fit("1.0", 1, w)})`);
        return this.sel(this.eq(e0, e1, w), `step(${e0}, ${x})`, `(${t} * ${t} * (${this.fit("3.0", 1, w)} - ${this.fit("2.0", 1, w)} * ${t}))`, w);
      }
      case "sin":
        return `sin(${a[0]})`;
      case "cos":
        return `cos(${a[0]})`;
      case "noise1":
        return `k_vnoise(${a[0]}, ${Math.round(e.seed ?? 0)})`;
      case "vec":
        return `${VEC[w]}(${raw.map(([s]) => s).join(", ")})`;
      case "length":
        return `length(${raw[0][0]})`;
      case "normalize": {
        const v = this.tmp(raw[0][1], raw[0][0]);
        const len = this.tmp(1, `length(${v})`);
        return this.sel(`(${len} == 0.0)`, `${VEC[w]}(0.0)`, `(${v} / ${len})`, 1);
      }
      case "hsv":
        return `k_hsv(${raw.map(([s, aw]) => this.fit(s, aw, 1)).join(", ")})`;
      case "toLinear":
        return `k_toLinear(${this.fit(raw[0][0], raw[0][1], 4)})`;
    }
  }

  stmt(st: KStmt): void {
    if (st.s === "set") {
      const ew = widthOf(st.e);
      if ("attr" in st.target) {
        const [slot, comp, w] = ATTR[st.target.attr];
        const v = this.tmp(w, this.fit(this.expr(st.e), ew, w));
        for (let i = 0; i < w; i++) {
          const dst = `a${slot}.${COMP[comp + i]}`;
          const src = w === 1 ? v : `${v}.${COMP[i]}`;
          this.lines.push(`${dst} = ${st.mode === "set" ? src : `${dst} ${st.mode === "add" ? "+" : "*"} ${src}`};`);
        }
        return;
      }
      const name = LOCAL_NAME[st.target.local];
      const w = LOCAL_WIDTH[st.target.local];
      const v = this.fit(this.expr(st.e), ew, w);
      this.lines.push(`${name} = ${st.mode === "set" ? v : `${name} ${st.mode === "add" ? "+" : "*"} ${v}`};`);
      return;
    }
    const arg = (i: number, w: number) => this.fit(this.expr(st.args[i]), widthOf(st.args[i]), w);
    switch (st.b) {
      case "shape": {
        const args = st.args.map((_, i) => arg(i, 1));
        this.lines.push(`k_shape(${args.join(", ")}, ${MODES[st.shape?.mode ?? "random"] ?? 0});`);
        if (st.rotation !== undefined) {
          this.lines.push(`k_spos = k_mat3(${st.rotation}, k_spos);`, `k_sdir = k_mat3(${st.rotation}, k_sdir);`);
        }
        return;
      }
      case "place":
        this.lines.push(`k_place(${arg(0, 3)}, ${arg(1, 1)});`);
        return;
      case "age":
        this.lines.push("k_age();");
        return;
      case "gravity":
        this.lines.push(`k_gravity(${arg(0, 1)});`);
        return;
      case "force":
        this.lines.push(`k_force(${arg(0, 3)});`);
        return;
      case "gpoint":
        this.lines.push(`k_gpoint(${arg(0, 3)}, ${arg(1, 1)});`);
        return;
      case "turbulence":
        this.lines.push(`k_turbulence(${arg(0, 3)}, ${arg(1, 1)}, ${arg(2, 3)}, ${arg(3, 3)});`);
        return;
      case "limit":
        this.lines.push(`k_limit(${arg(0, 1)}, ${arg(1, 1)});`);
        return;
      case "integrate":
        this.lines.push("k_integrate();");
        return;
      case "noise":
        this.lines.push(`k_noise(${arg(0, 1)}, ${arg(1, 1)}, ${arg(2, 1)}, ${arg(3, 1)}, ${st.index ?? 0}u);`);
        return;
      case "orbit":
        this.lines.push(`k_orbit(${arg(0, 1)}, ${arg(1, 3)});`);
        return;
      case "plane":
        this.lines.push(`k_plane(${arg(0, 1)}, ${arg(1, 1)}, ${arg(2, 1)});`);
        return;
      case "depth":
        this.lines.push(`k_depthCollide(${arg(0, 1)}, ${arg(1, 1)}, ${arg(2, 1)});`);
        return;
      case "spin":
        this.lines.push(`k_spin(${arg(0, 1)});`);
        return;
    }
  }
}

/** A stage's statements as a KSL function `name`. */
function stageFunction(name: string, stmts: readonly KStmt[], dialect: ShaderDialect): string {
  const em = new Emitter(`${name}_`, dialect);
  for (const s of stmts) em.stmt(s);
  return `FN(void, ${name}) {\n  ${em.lines.join("\n  ")}\n}\n`;
}

/** Depth collision (GPU only): needs `k_depthAt(x, y)`. Reflects particles that went behind the scene's depth. */
const DEPTH_STEP = /* KSL */ `
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
  VAR(KF, near) = ku[${U.depth}].w;
  VAR(KF, far) = ku[${U.depth2}].x;
  VAR(KF, viewDepth) = abs(dot(ku[${U.viewZ}].xyz, p) + ku[${U.viewZ}].w);
  VAR(KF, sceneDepth) = near + scene * (far - near);
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

/** The body every simulation shader runs for slot `k_idx`, after loading a0..a3 (and `k_spawnHere`). */
function simulationBody(kernel: KernelSystem): string {
  return /* KSL */ `
FN(void, k_run, KF spawnHere) {
  if (spawnHere > 0.5) {
    a0 = KV4(0.0, 0.0, 0.0, 0.0);
    a1 = KV4(0.0, 0.0, 0.0, 0.0);
    a2 = KV4(0.0, 0.0, 0.0, 0.0);
    a3 = KV4(0.0, 0.0, 0.0, k_seed(k_idx, ku[${U.spawn}].w, ku[${U.misc}].y));
    k_t = 0.0;
    k_init();
    return;
  }
  if (a1.w < 0.0) {
    a1.w = 0.0;
    return;
  }
  if (a1.w == 0.0 || ku[${U.time}].y <= 0.0) { return; }
  k_step = ku[${U.time}].y;
  k_dies = 0.0;
  k_speedMod = 1.0;
  k_update();
  if (k_dies > 0.5) { a1.w = -a1.w; }
}
${kernel.event ? EVENT_MASK : ""}
FN(KF, k_spawnRing) {
  VAR(KF, cap) = ku[${U.spawn}].z;
  VAR(KF, rel) = k_idx - ku[${U.spawn}].x;
  rel = rel - floor(rel / cap) * cap;
  if (ku[${U.spawn}].y > 0.0 && rel < ku[${U.spawn}].y) { return 1.0; }
  return 0.0;
}
`;
}

/** Event spawning (needs `k_par(i, slot)` and `k_srcLife(j)`), as `JsKernel.eventMask`. Sets the parent globals. */
const EVENT_MASK = /* KSL */ `
FN(KF, k_spawnEvent) {
  VAR(KF, k) = max(1.0, ku[${U.misc}].z);
  VAR(KF, p) = floor(k_idx / k);
  if (p >= ku[${U.misc}].w) { return 0.0; }
  if (k_srcLife(KI(k_idx)) > 0.0) { return 0.0; }
  VAR(KV4, pa0) = k_par(KI(p), 0);
  VAR(KV4, pa1) = k_par(KI(p), 1);
  VAR(KV4, pa3) = k_par(KI(p), 3);
  VAR(KF, trigger) = ku[${U.flags}].x;
  VAR(KF, frame) = ku[${U.spawn}].w;
  VAR(KF, fired) = 0.0;
  if (trigger < 0.5) { if (pa1.w > 0.0 && pa0.w == 0.0) { fired = 1.0; } }
  else if (trigger < 1.5) { if (pa1.w < 0.0) { fired = 1.0; } }
  else { if (pa1.w > 0.0) { fired = 1.0; } }
  if (fired < 0.5) { return 0.0; }
  VAR(KU, salt) = 7001u;
  if (trigger > 1.5) { salt = 7001u + KU(frame); }
  if (k_rand(pa3.w, salt) >= ku[${U.event}].y) { return 0.0; }
  VAR(KF, n) = ku[${U.event}].x;
  if (trigger > 1.5) {
    VAR(KF, rate) = ku[${U.event}].z;
    n = floor(rate);
    if (k_rand(pa3.w, 9001u + KU(frame)) < rate - floor(rate)) { n = n + 1.0; }
  }
  VAR(KF, dead) = 0.0;
  for (VAR(KI, j) = KI(p * k); j < KI(k_idx); j++) {
    if (k_srcLife(j) <= 0.0) { dead = dead + 1.0; }
  }
  if (dead >= n) { return 0.0; }
  // The parent's world position and velocity (from the parent's space).
  k_hasParent = 1.0;
  k_parentPos = pa0.xyz;
  k_parentVel = pa1.xyz;
  if (ku[${U.flags}].w < 0.5) {
    k_parentPos = k_xform(pa0.xyz);
    k_parentVel = k_xformDir(pa1.xyz);
  }
  return 1.0;
}
`;

/** Shared KSL for a kernel's simulation: prelude, steps, the shape, init and update. */
function simulationKsl(kernel: KernelSystem, dialect: ShaderDialect): string {
  const shapeStmt = kernel.init.find((s) => s.s === "builtin" && s.b === "shape") as Extract<KStmt, { s: "builtin" }> | undefined;
  return [
    GLOBALS,
    PRELUDE,
    STEPS,
    kernel.depth ? DEPTH_STEP : "",
    shapeFunction(shapeStmt?.shape?.type ?? "point"),
    stageFunction("k_init", kernel.init, dialect),
    stageFunction("k_update", kernel.update, dialect),
    simulationBody(kernel),
  ].join("\n");
}

// --- WGSL compute ---------------------------------------------------------------------------------------

export const WORKGROUP = 64;

/**
 * The WGSL compute shader for `kernel`. Bindings (group 0): ku (uniforms), ksrc (state read), kdst
 * (state write), kl (look-up table); kp (the event parent's state) when it has one; kdepth when it
 * collides with the depth buffer. The parent's space flag rides in `ku[flags].w`.
 */
export function wgslSimulation(kernel: KernelSystem): string {
  const head = `
@group(0) @binding(0) var<storage, read> ku: array<vec4f>;
@group(0) @binding(1) var<storage, read> ksrc: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> kdst: array<vec4f>;
@group(0) @binding(3) var<storage, read> kl: array<vec4f>;
${kernel.event ? "@group(0) @binding(4) var<storage, read> kp: array<vec4f>;" : ""}
${kernel.depth ? "@group(0) @binding(5) var kdepth: texture_2d<f32>;" : ""}
fn k_lutAt(row: i32, i: i32) -> vec4f { return kl[row * ${LUT_SAMPLES} + i]; }
${kernel.event ? "fn k_par(i: i32, slot: i32) -> vec4f { return kp[i * 4 + slot]; }\nfn k_srcLife(j: i32) -> f32 { return ksrc[j * 4 + 1].w; }" : ""}
${kernel.depth ? "fn k_depthAt(x: i32, y: i32) -> f32 { return textureLoad(kdepth, vec2i(x, y), 0).r; }" : ""}
`;
  const main = `
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
  let i = gid.x + gid.y * groups.x * ${WORKGROUP}u;
  if (f32(i) >= ku[${U.spawn}].z) { return; }
  let b = i * 4u;
  a0 = ksrc[b];
  a1 = ksrc[b + 1u];
  a2 = ksrc[b + 2u];
  a3 = ksrc[b + 3u];
  k_idx = f32(i);
  k_hasParent = 0.0;
  ${kernel.event ? "k_run(k_spawnEvent());" : "k_run(k_spawnRing());"}
  kdst[b] = a0;
  kdst[b + 1u] = a1;
  kdst[b + 2u] = a2;
  kdst[b + 3u] = a3;
}
`;
  return head + ksl(simulationKsl(kernel, "wgsl"), "wgsl") + main;
}

// --- GLSL ES 3.0 texture simulation ---------------------------------------------------------------------

/** Full-screen triangle for the simulation pass. */
export const GLSL_SIM_VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * The GLSL ES 3.0 fragment shader for the texture simulation: one fragment per particle slot
 * (`slot = y × width + x`), four render targets (the four state vec4s).
 * Uniforms: ku[N], kw (texture width), ks0..ks3 (state read), kl (look-up table); kp0..kp3 and kpw
 * (the parent's state) with an event; kdepth with depth collision.
 */
export function glslSimulation(kernel: KernelSystem): string {
  const head = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec4 ku[${kernel.uniformVec4}];
uniform int kw;
uniform sampler2D ks0;
uniform sampler2D ks1;
uniform sampler2D ks2;
uniform sampler2D ks3;
uniform sampler2D kl;
${kernel.event ? "uniform sampler2D kp0;\nuniform sampler2D kp1;\nuniform sampler2D kp2;\nuniform sampler2D kp3;\nuniform int kpw;" : ""}
${kernel.depth ? "uniform sampler2D kdepth;" : ""}
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
vec4 k_lutAt(int row, int i) { return texelFetch(kl, ivec2(i, row), 0); }
${
  kernel.event
    ? `vec4 k_par(int i, int slot) {
  ivec2 c = ivec2(i % kpw, i / kpw);
  if (slot == 0) { return texelFetch(kp0, c, 0); }
  if (slot == 1) { return texelFetch(kp1, c, 0); }
  if (slot == 2) { return texelFetch(kp2, c, 0); }
  return texelFetch(kp3, c, 0);
}
float k_srcLife(int j) { return texelFetch(ks1, ivec2(j % kw, j / kw), 0).w; }`
    : ""
}
${kernel.depth ? "float k_depthAt(int x, int y) { return texelFetch(kdepth, ivec2(x, y), 0).r; }" : ""}
`;
  const main = `
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int i = c.y * kw + c.x;
  a0 = texelFetch(ks0, c, 0);
  a1 = texelFetch(ks1, c, 0);
  a2 = texelFetch(ks2, c, 0);
  a3 = texelFetch(ks3, c, 0);
  if (float(i) < ku[${U.spawn}].z) {
    k_idx = float(i);
    k_hasParent = 0.0;
    ${kernel.event ? "k_run(k_spawnEvent());" : "k_run(k_spawnRing());"}
  }
  o0 = a0;
  o1 = a1;
  o2 = a2;
  o3 = a3;
}
`;
  return head + ksl(simulationKsl(kernel, "glsl"), "glsl") + main;
}

// --- drawing --------------------------------------------------------------------------------------------

/** The output stage as KSL `k_output()`: k_oColor/k_oSize/k_oTile from the particle (a0..a3 loaded). */
function outputKsl(out: KernelOutput, dialect: ShaderDialect): string {
  return `${stageFunction("k_output", out.stmts, dialect)}
FN(void, k_outputStage) {
  VAR(KF, life) = a1.w;
  k_t = 1.0;
  if (life > 0.0) { k_t = min(1.0, a0.w / life); }
  k_speedMod = 1.0;
  k_oColor = a2;
  k_oSize = a3.x;
  k_oTile = a3.z;
  k_output();
}
`;
}

/** What a draw needs to know about its output (the Babylon side passes it). */
export interface DrawShaderOptions {
  /** Read the depth texture in the fragment shader to fade particles near surfaces. */
  soft: boolean;
}

/**
 * The output's vertex and fragment shaders for a Babylon `ShaderMaterial` (GLSL, in Babylon's
 * GLSL dialect: attributes and varyings, converted to ES 3.0 on WebGL2). The state comes from four
 * float textures (ks0..ks3, width kw), uniforms from `ku`, the look-up table from `kl`.
 */
export function glslDraw(kernel: KernelSystem, k: number, opts: DrawShaderOptions = { soft: false }): { vertex: string; fragment: string } {
  const out = kernel.outputs[k];
  const vertex = `precision highp float;
precision highp int;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 viewProjection;
uniform mat4 view;
uniform vec3 kcam;
uniform vec4 ku[${kernel.uniformVec4}];
uniform float kw;
uniform vec4 kdraw;
uniform vec4 kdraw3;
uniform highp sampler2D ks0;
uniform highp sampler2D ks1;
uniform highp sampler2D ks2;
uniform highp sampler2D ks3;
uniform highp sampler2D kl;
varying vec2 vUV;
varying vec2 vUV2;
varying float vBlend;
varying vec4 vColor;
varying float vDepth;
vec4 k_lutAt(int row, int i) { return texelFetch(kl, ivec2(i, row), 0); }
${ksl(GLOBALS + PRELUDE + outputKsl(out, "glsl"), "glsl")}
${ksl(ORIENT, "glsl")}
void main() {
  int i = gl_InstanceID;
  int w = int(kw);
  ivec2 c = ivec2(i % w, i / w);
  a0 = texelFetch(ks0, c, 0);
  a1 = texelFetch(ks1, c, 0);
  a2 = texelFetch(ks2, c, 0);
  a3 = texelFetch(ks3, c, 0);
  k_idx = float(i);
  k_outputStage();
  vec3 right = vec3(view[0][0], view[1][0], view[2][0]);
  vec3 up = vec3(view[0][1], view[1][1], view[2][1]);
  vec4 placed = k_orient(position, right, up, kcam, kdraw);
  vColor = k_oColor;
  vec4 uvs = k_tileUV(uv, kdraw, kdraw3.x);
  vUV = uvs.xy;
  vUV2 = uvs.zw;
  vBlend = k_tileBlend(kdraw);
  vec4 clip = viewProjection * vec4(placed.xyz, 1.0);
  vDepth = clip.w;
  gl_Position = placed.w > 0.5 ? clip : vec4(0.0, 0.0, -2.0, 1.0);
}
`;
  const fragment = `precision highp float;
varying vec2 vUV;
varying vec2 vUV2;
varying float vBlend;
varying vec4 vColor;
varying float vDepth;
uniform sampler2D ktex;
uniform vec4 kdraw2;
${opts.soft ? "uniform sampler2D kdepthTex;\nuniform vec4 ksoft;" : ""}
void main() {
  vec4 t = texture2D(ktex, vUV);
  if (kdraw2.x > 0.5) { t = mix(t, texture2D(ktex, vUV2), vBlend); }
  vec4 col = t * vColor;
  ${
    opts.soft
      ? `vec2 suv = gl_FragCoord.xy / ksoft.xy;
  float scene = ksoft.z + texture2D(kdepthTex, suv).r * (ksoft.w - ksoft.z);
  col.a *= clamp((scene - vDepth) / max(kdraw2.y, 0.0001), 0.0, 1.0);`
      : ""
  }
  if (kdraw2.z > 0.5) { col.rgb *= col.a; }
  gl_FragColor = col;
}
`;
  return { vertex, fragment };
}

/** Orientation and flipbook helpers for the draws (KSL; globals loaded). `kdraw`: mode, speed scale, length scale, tile columns; `kdraw3.x`: tile rows. */
const ORIENT = /* KSL */ `
FN(KV4, k_orient, KV3 corner, KV3 right0, KV3 up0, KV3 cam, KV4 draw) {
  VAR(KF, alive) = 0.0;
  if (a1.w > 0.0 && a0.w < a1.w) { alive = 1.0; }
  VAR(KV3, p) = a0.xyz;
  VAR(KV3, v) = a1.xyz * k_speedMod;
  if (ku[${U.flags}].z < 0.5) {
    p = k_xform(p);
    v = k_xformDir(v);
  }
  VAR(KF, size) = max(0.0, k_oSize);
  VAR(KF, mode) = draw.x;
  VAR(KF, co) = cos(a3.y);
  VAR(KF, sn) = sin(a3.y);
  VAR(KV2, q) = KV2(corner.x * co - corner.y * sn, corner.x * sn + corner.y * co);
  VAR(KV3, right) = right0;
  VAR(KV3, up) = up0;
  if (mode > 3.5) {
    // mesh: the model's vertex, scaled by size, turned about Y by rotation
    VAR(KV3, m) = KV3(corner.x * co + corner.z * sn, corner.y, -corner.x * sn + corner.z * co) * size;
    return KV4(p + m, alive);
  }
  if (mode > 2.5) {
    // vertical: faces the camera, turning only about Y
    up = KV3(0.0, 1.0, 0.0);
    VAR(KV3, toCam) = cam - p;
    right = normalize(cross(up, toCam) + KV3(0.000001, 0.0, 0.0));
    return KV4(p + (right * q.x + up * q.y) * size, alive);
  }
  if (mode > 1.5) {
    // horizontal: flat in XZ
    return KV4(p + (KV3(1.0, 0.0, 0.0) * q.x + KV3(0.0, 0.0, 1.0) * q.y) * size, alive);
  }
  if (mode > 0.5) {
    // stretched along the velocity
    VAR(KF, speed) = length(v);
    VAR(KF, len) = size * draw.z + speed * draw.y;
    VAR(KV3, axis) = up0;
    if (speed > 0.000001) { axis = v / speed; }
    VAR(KV3, toCam) = normalize(cam - p);
    VAR(KV3, side) = cross(axis, toCam);
    VAR(KF, sl) = length(side);
    if (sl > 0.000001) { side = side / sl; } else { side = right0; }
    return KV4(p + side * corner.y * size - axis * (corner.x + 0.5) * len, alive);
  }
  return KV4(p + (right * q.x + up * q.y) * size, alive);
}
FN(KV4, k_tileUV, KV2 uv, KV4 draw, KF rows0) {
  VAR(KF, cols) = max(1.0, draw.w);
  VAR(KF, rows) = max(1.0, rows0);
  VAR(KF, n) = cols * rows;
  VAR(KF, whole) = floor(k_oTile);
  VAR(KF, t0) = whole - floor(whole / n) * n;
  VAR(KF, t1) = (t0 + 1.0) - floor((t0 + 1.0) / n) * n;
  VAR(KV2, a) = KV2((t0 - floor(t0 / cols) * cols + uv.x) / cols, (floor(t0 / cols) + uv.y) / rows);
  VAR(KV2, b) = KV2((t1 - floor(t1 / cols) * cols + uv.x) / cols, (floor(t1 / cols) + uv.y) / rows);
  return KV4(a, b);
}
FN(KF, k_tileBlend, KV4 draw) {
  return k_oTile - floor(k_oTile);
}
`;

/**
 * The output's shaders for a Babylon WGSL `ShaderMaterial` on WebGPU: the state from a storage
 * buffer (`ks`, interleaved vec4s), uniforms (`ku`) and the look-up table (`kl`) likewise.
 */
export function wgslDraw(kernel: KernelSystem, k: number, opts: DrawShaderOptions = { soft: false }): { vertex: string; fragment: string } {
  const out = kernel.outputs[k];
  const vertex = `
attribute position : vec3<f32>;
attribute uv : vec2<f32>;
uniform viewProjection : mat4x4<f32>;
uniform view : mat4x4<f32>;
uniform kcam : vec3<f32>;
uniform kdraw : vec4<f32>;
uniform kdraw3 : vec4<f32>;
var<storage, read> ku : array<vec4<f32>>;
var<storage, read> ks : array<vec4<f32>>;
var<storage, read> kl : array<vec4<f32>>;
varying vUV : vec2<f32>;
varying vUV2 : vec2<f32>;
varying vBlend : f32;
varying vColor : vec4<f32>;
varying vDepth : f32;
fn k_lutAt(row: i32, i: i32) -> vec4f { return kl[row * ${LUT_SAMPLES} + i]; }
${ksl(GLOBALS + PRELUDE + outputKsl(out, "wgsl"), "wgsl")}
${ksl(ORIENT, "wgsl")}
@vertex
fn main(input : VertexInputs) -> FragmentInputs {
  let i = vertexInputs.instanceIndex;
  let b = i * 4u;
  a0 = ks[b];
  a1 = ks[b + 1u];
  a2 = ks[b + 2u];
  a3 = ks[b + 3u];
  k_idx = f32(i);
  k_outputStage();
  let vw = uniforms.view;
  let right = vec3f(vw[0][0], vw[1][0], vw[2][0]);
  let up = vec3f(vw[0][1], vw[1][1], vw[2][1]);
  let placed = k_orient(vertexInputs.position, right, up, uniforms.kcam, uniforms.kdraw);
  vertexOutputs.vColor = k_oColor;
  let uvs = k_tileUV(vertexInputs.uv, uniforms.kdraw, uniforms.kdraw3.x);
  vertexOutputs.vUV = uvs.xy;
  vertexOutputs.vUV2 = uvs.zw;
  vertexOutputs.vBlend = k_tileBlend(uniforms.kdraw);
  let clip = uniforms.viewProjection * vec4f(placed.xyz, 1.0);
  vertexOutputs.vDepth = clip.w;
  vertexOutputs.position = select(vec4f(0.0, 0.0, -2.0, 1.0), clip, placed.w > 0.5);
}
`;
  const fragment = `
varying vUV : vec2<f32>;
varying vUV2 : vec2<f32>;
varying vBlend : f32;
varying vColor : vec4<f32>;
varying vDepth : f32;
var ktex : texture_2d<f32>;
var ktexSampler : sampler;
uniform kdraw2 : vec4<f32>;
${opts.soft ? "var kdepthTex : texture_2d<f32>;\nuniform ksoft : vec4<f32>;" : ""}
@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  var t = textureSample(ktex, ktexSampler, fragmentInputs.vUV);
  let t2 = textureSample(ktex, ktexSampler, fragmentInputs.vUV2);
  if (uniforms.kdraw2.x > 0.5) { t = mix(t, t2, fragmentInputs.vBlend); }
  var col = t * fragmentInputs.vColor;
  ${
    opts.soft
      ? `let dims = vec2f(textureDimensions(kdepthTex));
  let pc = vec2i(clamp(fragmentInputs.position.xy, vec2f(0.0), dims - 1.0));
  let scene = uniforms.ksoft.z + textureLoad(kdepthTex, pc, 0).r * (uniforms.ksoft.w - uniforms.ksoft.z);
  col.a = col.a * clamp((scene - fragmentInputs.vDepth) / max(uniforms.kdraw2.y, 0.0001), 0.0, 1.0);`
      : ""
  }
  if (uniforms.kdraw2.z > 0.5) { col = vec4f(col.rgb * col.a, col.a); }
  fragmentOutputs.color = col;
}
`;
  return { vertex, fragment };
}

/** Draw mode numbers (`kdraw.x`). */
export const DRAW_MODE: Record<string, number> = { quad: 0, stretched: 1, horizontal: 2, vertical: 3, mesh: 4 };
