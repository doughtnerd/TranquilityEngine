
@group(0) @binding(0) var<storage, read> ku: array<vec4f>;
@group(0) @binding(1) var<storage, read> ksrc: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> kdst: array<vec4f>;
@group(0) @binding(3) var<storage, read> kl: array<vec4f>;


@group(0) @binding(6) var<storage, read_write> kdead: array<i32>;
@group(0) @binding(7) var<storage, read_write> kcount: array<atomic<i32>>;
@group(0) @binding(8) var<storage, read_write> khist: array<vec4f>;
fn k_trailWrite(i: u32) { khist[(u32(ku[1].w) % 8u) * 32u + i] = vec4f(a0.xyz, a3.w); }
fn k_lutAt(row: i32, i: i32) -> vec4f { return kl[row * 128 + i]; }



var<private> a0: vec4f;
var<private> a1: vec4f;
var<private> a2: vec4f;
var<private> a3: vec4f;
var<private> k_idx: f32;
var<private> k_rel: f32;
var<private> k_sidx: f32;
var<private> k_t: f32;
var<private> k_step: f32;
var<private> k_dies: f32;
var<private> k_speedMod: f32;
var<private> k_spos: vec3f;
var<private> k_sdir: vec3f;
var<private> k_hasParent: f32;
var<private> k_parentPos: vec3f;
var<private> k_parentVel: vec3f;
var<private> k_oColor: vec4f;
var<private> k_oSize: f32;
var<private> k_oTile: f32;


fn k_pcg(v: u32) -> u32 {
  var state: u32 = (v * 747796405u) + 2891336453u;
  var word: u32 = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn k_rand(seed: f32, salt: u32) -> f32 {
  return f32(k_pcg(u32(floor(seed * 16777216.0)) ^ k_pcg(salt)) >> 8u) / 16777216.0;
}
fn k_seed(index: f32, frame: f32, sys: f32) -> f32 {
  return f32(k_pcg(u32(index) ^ k_pcg(u32(frame) ^ k_pcg(u32(sys)))) >> 8u) / 16777216.0;
}
fn k_hashInt(x0: u32) -> u32 {
  var x: u32 = x0;
  x = (x ^ (x >> 16u)) * 0x85ebca6bu;
  x = (x ^ (x >> 13u)) * 0xc2b2ae35u;
  return x ^ (x >> 16u);
}
fn k_lattice(x: i32, y: i32, z: i32) -> f32 {
  return f32(k_hashInt((bitcast<u32>(x) * 73856093u) ^ (bitcast<u32>(y) * 19349663u) ^ (bitcast<u32>(z) * 83492791u))) / 4294967296.0 * 2.0 - 1.0;
}
fn k_fade(t: f32) -> f32 {
  return t * t * (3.0 - 2.0 * t);
}
fn k_noise3(x: f32, y: f32, z: f32) -> f32 {
  var fx0: f32 = floor(x);
  var fy0: f32 = floor(y);
  var fz0: f32 = floor(z);
  var ix: i32 = i32(fx0);
  var iy: i32 = i32(fy0);
  var iz: i32 = i32(fz0);
  var fx: f32 = k_fade(x - fx0);
  var fy: f32 = k_fade(y - fy0);
  var fz: f32 = k_fade(z - fz0);
  var a: f32 = mix(mix(k_lattice(ix, iy, iz), k_lattice(ix + 1, iy, iz), fx), mix(k_lattice(ix, iy + 1, iz), k_lattice(ix + 1, iy + 1, iz), fx), fy);
  var b: f32 = mix(mix(k_lattice(ix, iy, iz + 1), k_lattice(ix + 1, iy, iz + 1), fx), mix(k_lattice(ix, iy + 1, iz + 1), k_lattice(ix + 1, iy + 1, iz + 1), fx), fy);
  return mix(a, b, fz);
}
fn k_hash1(n: i32, seed: i32) -> f32 {
  var x: u32 = (bitcast<u32>(n) * 374761393u) + (bitcast<u32>(seed) * 668265263u);
  x = (x ^ (x >> 13u)) * 1274126177u;
  x = x ^ (x >> 16u);
  return f32(x) / 4294967295.0 * 2.0 - 1.0;
}
fn k_vnoise(x: f32, seed: i32) -> f32 {
  var fi: f32 = floor(x);
  var i: i32 = i32(fi);
  var f: f32 = x - fi;
  var u: f32 = f * f * (3.0 - 2.0 * f);
  var a: f32 = k_hash1(i, seed);
  return a + (k_hash1(i + 1, seed) - a) * u;
}
fn k_hsv(h: f32, s: f32, v: f32, a: f32) -> vec4f {
  var hh: f32 = (h - floor(h)) * 6.0;
  var fi: f32 = floor(hh);
  var f: f32 = hh - fi;
  var p: f32 = v * (1.0 - s);
  var q: f32 = v * (1.0 - s * f);
  var t: f32 = v * (1.0 - s * (1.0 - f));
  var i: i32 = i32(fi) % 6;
  if (i == 0) { return vec4f(v, t, p, a); }
  if (i == 1) { return vec4f(q, v, p, a); }
  if (i == 2) { return vec4f(p, v, t, a); }
  if (i == 3) { return vec4f(p, q, v, a); }
  if (i == 4) { return vec4f(t, p, v, a); }
  return vec4f(v, p, q, a);
}
fn k_lin(c: f32) -> f32 {
  return mix(pow((max(c, 0.0) + 0.055) / 1.055, 2.4), c / 12.92, step(c, 0.04045));
}
fn k_toLinear(c: vec4f) -> vec4f {
  return vec4f(k_lin(c.x), k_lin(c.y), k_lin(c.z), c.w);
}
fn k_lut(row: i32, t: f32) -> vec4f {
  var x: f32 = clamp(t, 0.0, 1.0) * 127.0;
  var f0: f32 = floor(x);
  var i0: i32 = i32(f0);
  var i1: i32 = min(127, i0 + 1);
  return mix(k_lutAt(row, i0), k_lutAt(row, i1), x - f0);
}
fn k_mat3(s: i32, v: vec3f) -> vec3f {
  return vec3f(dot(ku[s].xyz, v), dot(ku[s + 1].xyz, v), dot(ku[s + 2].xyz, v));
}
fn k_xform(p: vec3f) -> vec3f {
  return ku[2].xyz * p.x + ku[3].xyz * p.y + ku[4].xyz * p.z + ku[5].xyz;
}
fn k_xformDir(v: vec3f) -> vec3f {
  return ku[2].xyz * v.x + ku[3].xyz * v.y + ku[4].xyz * v.z;
}
fn k_inverse(p: vec3f) -> vec3f {
  return ku[6].xyz * p.x + ku[7].xyz * p.y + ku[8].xyz * p.z + ku[9].xyz;
}
fn k_inverseDir(v: vec3f) -> vec3f {
  return ku[6].xyz * v.x + ku[7].xyz * v.y + ku[8].xyz * v.z;
}
fn k_div1(a: f32, b: f32) -> f32 {
  return select(a / b, 0.0, b == 0.0);
}
fn k_div2(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(k_div1(a.x, b.x), k_div1(a.y, b.y));
}
fn k_div3(a: vec3f, b: vec3f) -> vec3f {
  return vec3f(k_div1(a.x, b.x), k_div1(a.y, b.y), k_div1(a.z, b.z));
}
fn k_div4(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(k_div1(a.x, b.x), k_div1(a.y, b.y), k_div1(a.z, b.z), k_div1(a.w, b.w));
}
fn k_remap1(x: f32, a: f32, b: f32, c: f32, d: f32) -> f32 {
  if (b == a) { return c; }
  return c + (x - a) / (b - a) * (d - c);
}
fn k_remap2(x: vec2f, a: vec2f, b: vec2f, c: vec2f, d: vec2f) -> vec2f {
  return vec2f(k_remap1(x.x, a.x, b.x, c.x, d.x), k_remap1(x.y, a.y, b.y, c.y, d.y));
}
fn k_remap3(x: vec3f, a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f {
  return vec3f(k_remap1(x.x, a.x, b.x, c.x, d.x), k_remap1(x.y, a.y, b.y, c.y, d.y), k_remap1(x.z, a.z, b.z, c.z, d.z));
}
fn k_remap4(x: vec4f, a: vec4f, b: vec4f, c: vec4f, d: vec4f) -> vec4f {
  return vec4f(k_remap1(x.x, a.x, b.x, c.x, d.x), k_remap1(x.y, a.y, b.y, c.y, d.y), k_remap1(x.z, a.z, b.z, c.z, d.z), k_remap1(x.w, a.w, b.w, c.w, d.w));
}
fn k_smooth1(e0: f32, e1: f32, x: f32) -> f32 {
  if (e0 == e1) { return step(e0, x); }
  var t: f32 = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
fn k_smooth2(e0: vec2f, e1: vec2f, x: vec2f) -> vec2f {
  return vec2f(k_smooth1(e0.x, e1.x, x.x), k_smooth1(e0.y, e1.y, x.y));
}
fn k_smooth3(e0: vec3f, e1: vec3f, x: vec3f) -> vec3f {
  return vec3f(k_smooth1(e0.x, e1.x, x.x), k_smooth1(e0.y, e1.y, x.y), k_smooth1(e0.z, e1.z, x.z));
}
fn k_smooth4(e0: vec4f, e1: vec4f, x: vec4f) -> vec4f {
  return vec4f(k_smooth1(e0.x, e1.x, x.x), k_smooth1(e0.y, e1.y, x.y), k_smooth1(e0.z, e1.z, x.z), k_smooth1(e0.w, e1.w, x.w));
}


fn k_age() {
  var life: f32 = a1.w;
  if (a0.w + k_step >= life) {
    k_step = max(0.0, life - a0.w);
    k_dies = 1.0;
  }
  a0.w = a0.w + k_step;
  k_t = min(1.0, a0.w / life);
}
fn k_gravity(strength: f32) {
  var g: f32 = strength * 9.81 * k_step;
  if (ku[13].z > 0.5) {
    a1.y = a1.y - g;
  } else {
    var down: vec3f = -ku[7].xyz;
    var len: f32 = length(down);
    if (len > 0.0) { down = down / len; }
    a1.x = a1.x + down.x * g;
    a1.y = a1.y + down.y * g;
    a1.z = a1.z + down.z * g;
  }
}
fn k_force(f: vec3f) {
  a1.x = a1.x + f.x * k_step;
  a1.y = a1.y + f.y * k_step;
  a1.z = a1.z + f.z * k_step;
}
fn k_gpoint(c: vec3f, strength: f32) {
  var d: vec3f = c - a0.xyz;
  var len: f32 = length(d);
  if (len < 0.000001) { return; }
  var a: f32 = strength / max(len * len, 0.0625) * k_step;
  a1.x = a1.x + d.x / len * a;
  a1.y = a1.y + d.y / len * a;
  a1.z = a1.z + d.z / len * a;
}
fn k_nz(v: f32) -> f32 {
  if (v == 0.0) { return 1.0; }
  return v;
}
fn k_turbulence(sc: vec3f, octaves: f32, vel: vec3f, ts: vec3f) {
  var oct: i32 = i32(clamp(floor(octaves + 0.5), 1.0, 4.0));
  var time: f32 = ku[0].x;
  var x: f32 = a0.x / k_nz(sc.x);
  var y: f32 = a0.y / k_nz(sc.y);
  var z: f32 = a0.z / k_nz(sc.z);
  var nx: f32 = 0.0;
  var ny: f32 = 0.0;
  var nz: f32 = 0.0;
  var lvl: f32 = 1.0;
  for (var i: i32 = 0; i < oct; i++) {
    nx = nx + k_noise3(x * lvl + time * ts.x * lvl, y * lvl, z * lvl) / lvl;
    ny = ny + k_noise3(x * lvl + 31.7, y * lvl + time * ts.y * lvl, z * lvl) / lvl;
    nz = nz + k_noise3(x * lvl, y * lvl + 17.3, z * lvl + time * ts.z * lvl) / lvl;
    lvl = lvl * 2.0;
  }
  a1.x = a1.x + nx * vel.x * k_step;
  a1.y = a1.y + ny * vel.y * k_step;
  a1.z = a1.z + nz * vel.z * k_step;
}
fn k_limit(limit: f32, dampen: f32) {
  var speed: f32 = length(a1.xyz);
  if (speed <= limit || speed < 0.000000001) { return; }
  var k: f32 = 1.0 - pow(1.0 - clamp(dampen, 0.0, 1.0), k_step * 60.0);
  var m: f32 = 1.0 + k * (max(0.0, limit) / speed - 1.0);
  a1.x = a1.x * m;
  a1.y = a1.y * m;
  a1.z = a1.z * m;
}
fn k_integrate() {
  var k: f32 = k_speedMod * k_step;
  a0.x = a0.x + a1.x * k;
  a0.y = a0.y + a1.y * k;
  a0.z = a0.z + a1.z * k;
}
fn k_noise(freq: f32, power: f32, pa: f32, ra: f32, index: u32) {
  var seed: f32 = a3.w;
  var now: f32 = a0.w * freq;
  var before: f32 = (a0.w - k_step) * freq;
  var base: u32 = 3000u + index * 8u;
  if (pa > 0.0) {
    var o0: f32 = k_rand(seed, base) * 100.0;
    var o1: f32 = k_rand(seed, base + 1u) * 100.0;
    var o2: f32 = k_rand(seed, base + 2u) * 100.0;
    a0.x = a0.x + (k_noise3(o0 + now, 0.5, 0.0) - k_noise3(o0 + before, 0.5, 0.0)) * power * pa;
    a0.y = a0.y + (k_noise3(o1 + now, 0.5, 0.0) - k_noise3(o1 + before, 0.5, 0.0)) * power * pa;
    a0.z = a0.z + (k_noise3(o2 + now, 0.5, 0.0) - k_noise3(o2 + before, 0.5, 0.0)) * power * pa;
  }
  if (ra > 0.0) {
    var o3: f32 = k_rand(seed, base + 3u) * 100.0;
    a3.y = a3.y + (k_noise3(o3 + now, 0.5, 0.0) - k_noise3(o3 + before, 0.5, 0.0)) * 3.141592653589793 * power * ra;
  }
}
fn k_orbit(speed: f32, axis0: vec3f) {
  var axis: vec3f = axis0;
  var c: vec3f = vec3f(0.0, 0.0, 0.0);
  if (ku[13].z > 0.5) {
    axis = k_xformDir(axis);
    c = ku[5].xyz;
  }
  var len: f32 = length(axis);
  if (len < 0.000000001) { return; }
  axis = axis / len;
  var angle: f32 = speed * 0.017453292519943295 * k_step;
  var r: vec3f = a0.xyz - c;
  var d: f32 = dot(r, axis);
  var co: f32 = cos(angle);
  var sn: f32 = sin(angle);
  var p: vec3f = c + r * co + cross(axis, r) * sn + axis * d * (1.0 - co);
  a0.x = p.x;
  a0.y = p.y;
  a0.z = p.z;
}
fn k_plane(h: f32, bounce: f32, kill: f32) {
  if (a0.y >= h) { return; }
  if (kill > 0.5) {
    k_dies = 1.0;
    a0.w = a1.w;
    return;
  }
  a0.y = h;
  if (a1.y < 0.0) { a1.y = -a1.y * bounce; }
}
fn k_spin(speed: f32) {
  a3.y = a3.y + speed * 0.017453292519943295 * k_step;
}
fn k_place(offset: vec3f, speed: f32) {
  var n: vec3f = k_spos + offset;
  var world: f32 = ku[13].z;
  if (world < 0.5 && k_hasParent < 0.5) {
    a0.x = n.x;
    a0.y = n.y;
    a0.z = n.z;
    a1.x = k_sdir.x * speed;
    a1.y = k_sdir.y * speed;
    a1.z = k_sdir.z * speed;
    return;
  }
  var origin: vec3f = ku[5].xyz;
  if (k_hasParent > 0.5) { origin = k_parentPos; }
  var wp: vec3f = k_xformDir(n) + origin;
  var v: vec3f = k_xformDir(k_sdir);
  var len: f32 = length(v);
  if (len > 0.000000001) { v = v * (speed / len); } else { v = vec3f(0.0, 0.0, 0.0); }
  if (k_hasParent > 0.5 && ku[12].w > 0.5) { v = v + k_parentVel; }
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
fn k_shapeU(mode: i32, spread: f32) -> f32 {
  var r: f32 = k_rand(a3.w, 900u);
  if (mode == 0) { return r; }
  var cap: f32 = ku[1].z;
  var rel: f32 = k_rel;
  if (mode == 3) { return rel / max(1.0, ku[1].y); }
  var ordinal: f32 = ku[11].x + rel;
  var x: f32 = ordinal / max(1.0, cap);
  if (spread > 0.0) { x = ordinal * spread; }
  if (mode == 1) { return x - floor(x); }
  var m: f32 = x - 2.0 * floor(x / 2.0);
  if (m < 1.0) { return m; }
  return 2.0 - m;
}



fn k_shape(radius: f32, angle: f32, arc: f32, thickness: f32, width: f32, height: f32, donutRadius: f32, columns: f32, rows: f32, spread: f32, mode: i32) {
  k_spos = vec3f(0.0, 0.0, 0.0);
  k_sdir = vec3f(0.0, 1.0, 0.0);
  var u: f32 = k_shapeU(mode, spread);
  var theta: f32 = u * arc * 0.017453292519943295;
  var th: f32 = clamp(thickness, 0.0, 1.0);
  var inner: f32 = 1.0 - th;
  
}

fn k_init() {
  var k_init_0: f32 = 1.0;
  a1.w = k_init_0;
  var k_init_1: f32 = 0.1;
  a3.x = k_init_1;
  var k_init_2: f32 = 0.0;
  a3.y = k_init_2;
  var k_init_3: vec4f = vec4f(1.0, 1.0, 1.0, 1.0);
  a2.x = k_init_3.x;
  a2.y = k_init_3.y;
  a2.z = k_init_3.z;
  a2.w = k_init_3.w;
  var k_init_4: f32 = 0.0;
  a3.z = k_init_4;
  var k_init_5: f32 = max(2.0, 0.001);
  var k_init_6: f32 = k_init_5;
  a1.w = k_init_6;
  var k_init_7: vec4f = ku[10];
  a2.x = a2.x * k_init_7.x;
  a2.y = a2.y * k_init_7.y;
  a2.z = a2.z * k_init_7.z;
  a2.w = a2.w * k_init_7.w;
  k_shape(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0);
  k_place(vec3f(0.0, 0.0, 0.0), 1.0);
}

fn k_update() {
  k_age();
  k_integrate();
}


fn k_run(spawnHere: f32) {
  if (spawnHere > 0.5) {
    a0 = vec4f(0.0, 0.0, 0.0, 0.0);
    a1 = vec4f(0.0, 0.0, 0.0, 0.0);
    a2 = vec4f(0.0, 0.0, 0.0, 0.0);
    a3 = vec4f(0.0, 0.0, 0.0, k_seed(k_sidx, ku[1].w, ku[11].y));
    k_t = 0.0;
    k_init();
    return;
  }
  if (a1.w < 0.0) {
    a1.w = 0.0;
    return;
  }
  if (a1.w == 0.0 || ku[0].y <= 0.0) { return; }
  k_step = ku[0].y;
  k_dies = 0.0;
  k_speedMod = 1.0;
  k_update();
  if (k_dies > 0.5) { a1.w = -a1.w; }
}

fn k_spawnRing() -> f32 {
  var cap: f32 = ku[1].z;
  var rel: f32 = k_idx - ku[1].x;
  rel = rel - floor(rel / cap) * cap;
  k_rel = rel;
  if (ku[1].y > 0.0 && rel < ku[1].y) { return 1.0; }
  return 0.0;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) groups: vec3u) {
  let i = gid.x + gid.y * groups.x * 64u;
  if (f32(i) >= ku[1].z) { return; }
  let b = i * 4u;
  a0 = ksrc[b];
  a1 = ksrc[b + 1u];
  a2 = ksrc[b + 2u];
  a3 = ksrc[b + 3u];
  k_idx = f32(i);
  k_rel = k_idx;
  k_sidx = k_idx;
  k_hasParent = 0.0;
  let dying = a1.w < 0.0;
  k_run(0.0);
  if (dying) {
    let at = atomicAdd(&kcount[0], 1);
    kdead[at] = i32(i);
  }
  if (a1.w > 0.0) { atomicAdd(&kcount[1], 1); }
  kdst[b] = a0;
  kdst[b + 1u] = a1;
  kdst[b + 2u] = a2;
  kdst[b + 3u] = a3;
  k_trailWrite(i);
}

@compute @workgroup_size(64)
fn spawn(@builtin(global_invocation_id) gid: vec3u) {
  let t = gid.x;
  if (f32(t) >= ku[1].y) { return; }
  let old = atomicSub(&kcount[0], 1);
  if (old <= 0) {
    atomicAdd(&kcount[0], 1);
    return;
  }
  let i = u32(kdead[old - 1]);
  let b = i * 4u;
  k_idx = f32(i);
  k_rel = f32(t);
  k_sidx = f32(t);
  k_hasParent = 0.0;
  k_run(1.0);
  if (a1.w <= 0.0) {
    // Born without a lifetime: marked finished, so the next update pass frees the slot (no push here,
    // where other invocations are popping).
    a1.w = -1e-20;
  } else {
    atomicAdd(&kcount[1], 1);
  }
  kdst[b] = a0;
  kdst[b + 1u] = a1;
  kdst[b + 2u] = a2;
  kdst[b + 3u] = a3;
  k_trailWrite(i);
}
