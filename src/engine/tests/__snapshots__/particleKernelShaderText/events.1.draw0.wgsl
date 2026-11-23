
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
varying vWorld : vec3<f32>;
varying vEye : vec3<f32>;
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
fn k_output() {
  
}

fn k_outputStage() {
  var life: f32 = a1.w;
  k_t = 1.0;
  if (life > 0.0) { k_t = min(1.0, a0.w / life); }
  k_speedMod = 1.0;
  k_oColor = a2;
  k_oSize = a3.x;
  k_oTile = a3.z;
  k_output();
}


fn k_orient(corner: vec3f, right0: vec3f, up0: vec3f, cam: vec3f, draw: vec4f) -> vec4f {
  var alive: f32 = 0.0;
  if (a1.w > 0.0 && a0.w < a1.w) { alive = 1.0; }
  var p: vec3f = a0.xyz;
  var v: vec3f = a1.xyz * k_speedMod;
  if (ku[13].z < 0.5) {
    p = k_xform(p);
    v = k_xformDir(v);
  }
  var size: f32 = max(0.0, k_oSize);
  var mode: f32 = draw.x;
  var co: f32 = cos(a3.y);
  var sn: f32 = sin(a3.y);
  var q: vec2f = vec2f(corner.x * co - corner.y * sn, corner.x * sn + corner.y * co);
  var right: vec3f = right0;
  var up: vec3f = up0;
  if (mode > 3.5) {
    // mesh: the model's vertex, scaled by size, turned about Y by rotation
    var m: vec3f = vec3f(corner.x * co + corner.z * sn, corner.y, -corner.x * sn + corner.z * co) * size;
    return vec4f(p + m, alive);
  }
  if (mode > 2.5) {
    // vertical: faces the camera, turning only about Y
    up = vec3f(0.0, 1.0, 0.0);
    var toCam: vec3f = cam - p;
    right = normalize(cross(toCam, up) + vec3f(0.000001, 0.0, 0.0)); // left-handed (ADR 0164): the camera's right
    return vec4f(p + (right * q.x + up * q.y) * size, alive);
  }
  if (mode > 1.5) {
    // horizontal: flat in XZ
    return vec4f(p + (vec3f(1.0, 0.0, 0.0) * q.x + vec3f(0.0, 0.0, 1.0) * q.y) * size, alive);
  }
  if (mode > 0.5) {
    // stretched along the velocity
    var speed: f32 = length(v);
    var len: f32 = size * draw.z + speed * draw.y;
    var axis: vec3f = up0;
    if (speed > 0.000001) { axis = v / speed; }
    var toCam: vec3f = normalize(cam - p);
    var side: vec3f = cross(toCam, axis); // left-handed order (ADR 0164)
    var sl: f32 = length(side);
    if (sl > 0.000001) { side = side / sl; } else { side = right0; }
    return vec4f(p + side * corner.y * size - axis * (corner.x + 0.5) * len, alive);
  }
  return vec4f(p + (right * q.x + up * q.y) * size, alive);
}
fn k_orientCentre() -> vec3f {
  var p: vec3f = a0.xyz;
  if (ku[13].z < 0.5) { p = k_xform(p); }
  return p;
}
fn k_tileUV(uv: vec2f, draw: vec4f, rows0: f32) -> vec4f {
  var cols: f32 = max(1.0, draw.w);
  var rows: f32 = max(1.0, rows0);
  var n: f32 = cols * rows;
  var whole: f32 = floor(k_oTile);
  var t0: f32 = whole - floor(whole / n) * n;
  var t1: f32 = (t0 + 1.0) - floor((t0 + 1.0) / n) * n;
  var a: vec2f = vec2f((t0 - floor(t0 / cols) * cols + uv.x) / cols, (floor(t0 / cols) + uv.y) / rows);
  var b: vec2f = vec2f((t1 - floor(t1 / cols) * cols + uv.x) / cols, (floor(t1 / cols) + uv.y) / rows);
  return vec4f(a, b);
}
fn k_tileBlend(draw: vec4f) -> f32 {
  return k_oTile - floor(k_oTile);
}

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
  vertexOutputs.vWorld = placed.xyz;
  vertexOutputs.vEye = uniforms.kcam;
  vertexOutputs.position = select(vec4f(0.0, 0.0, -2.0, 1.0), clip, placed.w > 0.5);
}

// ---- fragment ----

varying vUV : vec2<f32>;
varying vUV2 : vec2<f32>;
varying vBlend : f32;
varying vColor : vec4<f32>;
varying vDepth : f32;
varying vWorld : vec3<f32>;
varying vEye : vec3<f32>;
var ktex : texture_2d<f32>;
var ktexSampler : sampler;
uniform kdraw2 : vec4<f32>;


@fragment
fn main(input : FragmentInputs) -> FragmentOutputs {
  var t = textureSample(ktex, ktexSampler, fragmentInputs.vUV);
  let t2 = textureSample(ktex, ktexSampler, fragmentInputs.vUV2);
  if (uniforms.kdraw2.x > 0.5) { t = mix(t, t2, fragmentInputs.vBlend); }
  var col = t * fragmentInputs.vColor;
  
  
  if (uniforms.kdraw2.z > 0.5) { col = vec4f(col.rgb * col.a, col.a); }
  fragmentOutputs.color = col;
}
