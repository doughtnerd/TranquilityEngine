precision highp float;
precision highp int;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 viewProjection;
uniform mat4 view;
uniform vec3 kcam;
uniform vec4 ku[24];
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
varying vec3 vWorld;
varying vec3 vEye;
vec4 k_lutAt(int row, int i) { return texelFetch(kl, ivec2(i, row), 0); }

vec4 a0;
vec4 a1;
vec4 a2;
vec4 a3;
float k_idx;
float k_rel;
float k_sidx;
float k_t;
float k_step;
float k_dies;
float k_speedMod;
vec3 k_spos;
vec3 k_sdir;
float k_hasParent;
vec3 k_parentPos;
vec3 k_parentVel;
vec4 k_oColor;
float k_oSize;
float k_oTile;

uint k_pcg(uint v) {
  uint state = (v * 747796405u) + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float k_rand(float seed, uint salt) {
  return float(k_pcg(uint(floor(seed * 16777216.0)) ^ k_pcg(salt)) >> 8u) / 16777216.0;
}
float k_seed(float index, float frame, float sys) {
  return float(k_pcg(uint(index) ^ k_pcg(uint(frame) ^ k_pcg(uint(sys)))) >> 8u) / 16777216.0;
}
uint k_hashInt(uint x0) {
  uint x = x0;
  x = (x ^ (x >> 16u)) * 0x85ebca6bu;
  x = (x ^ (x >> 13u)) * 0xc2b2ae35u;
  return x ^ (x >> 16u);
}
float k_lattice(int x, int y, int z) {
  return float(k_hashInt((uint(x) * 73856093u) ^ (uint(y) * 19349663u) ^ (uint(z) * 83492791u))) / 4294967296.0 * 2.0 - 1.0;
}
float k_fade(float t) {
  return t * t * (3.0 - 2.0 * t);
}
float k_noise3(float x, float y, float z) {
  float fx0 = floor(x);
  float fy0 = floor(y);
  float fz0 = floor(z);
  int ix = int(fx0);
  int iy = int(fy0);
  int iz = int(fz0);
  float fx = k_fade(x - fx0);
  float fy = k_fade(y - fy0);
  float fz = k_fade(z - fz0);
  float a = mix(mix(k_lattice(ix, iy, iz), k_lattice(ix + 1, iy, iz), fx), mix(k_lattice(ix, iy + 1, iz), k_lattice(ix + 1, iy + 1, iz), fx), fy);
  float b = mix(mix(k_lattice(ix, iy, iz + 1), k_lattice(ix + 1, iy, iz + 1), fx), mix(k_lattice(ix, iy + 1, iz + 1), k_lattice(ix + 1, iy + 1, iz + 1), fx), fy);
  return mix(a, b, fz);
}
float k_hash1(int n, int seed) {
  uint x = (uint(n) * 374761393u) + (uint(seed) * 668265263u);
  x = (x ^ (x >> 13u)) * 1274126177u;
  x = x ^ (x >> 16u);
  return float(x) / 4294967295.0 * 2.0 - 1.0;
}
float k_vnoise(float x, int seed) {
  float fi = floor(x);
  int i = int(fi);
  float f = x - fi;
  float u = f * f * (3.0 - 2.0 * f);
  float a = k_hash1(i, seed);
  return a + (k_hash1(i + 1, seed) - a) * u;
}
vec4 k_hsv(float h, float s, float v, float a) {
  float hh = (h - floor(h)) * 6.0;
  float fi = floor(hh);
  float f = hh - fi;
  float p = v * (1.0 - s);
  float q = v * (1.0 - s * f);
  float t = v * (1.0 - s * (1.0 - f));
  int i = int(fi) % 6;
  if (i == 0) { return vec4(v, t, p, a); }
  if (i == 1) { return vec4(q, v, p, a); }
  if (i == 2) { return vec4(p, v, t, a); }
  if (i == 3) { return vec4(p, q, v, a); }
  if (i == 4) { return vec4(t, p, v, a); }
  return vec4(v, p, q, a);
}
float k_lin(float c) {
  return mix(pow((max(c, 0.0) + 0.055) / 1.055, 2.4), c / 12.92, step(c, 0.04045));
}
vec4 k_toLinear(vec4 c) {
  return vec4(k_lin(c.x), k_lin(c.y), k_lin(c.z), c.w);
}
vec4 k_lut(int row, float t) {
  float x = clamp(t, 0.0, 1.0) * 127.0;
  float f0 = floor(x);
  int i0 = int(f0);
  int i1 = min(127, i0 + 1);
  return mix(k_lutAt(row, i0), k_lutAt(row, i1), x - f0);
}
vec3 k_mat3(int s, vec3 v) {
  return vec3(dot(ku[s].xyz, v), dot(ku[s + 1].xyz, v), dot(ku[s + 2].xyz, v));
}
vec3 k_xform(vec3 p) {
  return ku[2].xyz * p.x + ku[3].xyz * p.y + ku[4].xyz * p.z + ku[5].xyz;
}
vec3 k_xformDir(vec3 v) {
  return ku[2].xyz * v.x + ku[3].xyz * v.y + ku[4].xyz * v.z;
}
vec3 k_inverse(vec3 p) {
  return ku[6].xyz * p.x + ku[7].xyz * p.y + ku[8].xyz * p.z + ku[9].xyz;
}
vec3 k_inverseDir(vec3 v) {
  return ku[6].xyz * v.x + ku[7].xyz * v.y + ku[8].xyz * v.z;
}
float k_div1(float a, float b) {
  return ((b == 0.0) ? (0.0) : (a / b));
}
vec2 k_div2(vec2 a, vec2 b) {
  return vec2(k_div1(a.x, b.x), k_div1(a.y, b.y));
}
vec3 k_div3(vec3 a, vec3 b) {
  return vec3(k_div1(a.x, b.x), k_div1(a.y, b.y), k_div1(a.z, b.z));
}
vec4 k_div4(vec4 a, vec4 b) {
  return vec4(k_div1(a.x, b.x), k_div1(a.y, b.y), k_div1(a.z, b.z), k_div1(a.w, b.w));
}
float k_remap1(float x, float a, float b, float c, float d) {
  if (b == a) { return c; }
  return c + (x - a) / (b - a) * (d - c);
}
vec2 k_remap2(vec2 x, vec2 a, vec2 b, vec2 c, vec2 d) {
  return vec2(k_remap1(x.x, a.x, b.x, c.x, d.x), k_remap1(x.y, a.y, b.y, c.y, d.y));
}
vec3 k_remap3(vec3 x, vec3 a, vec3 b, vec3 c, vec3 d) {
  return vec3(k_remap1(x.x, a.x, b.x, c.x, d.x), k_remap1(x.y, a.y, b.y, c.y, d.y), k_remap1(x.z, a.z, b.z, c.z, d.z));
}
vec4 k_remap4(vec4 x, vec4 a, vec4 b, vec4 c, vec4 d) {
  return vec4(k_remap1(x.x, a.x, b.x, c.x, d.x), k_remap1(x.y, a.y, b.y, c.y, d.y), k_remap1(x.z, a.z, b.z, c.z, d.z), k_remap1(x.w, a.w, b.w, c.w, d.w));
}
float k_smooth1(float e0, float e1, float x) {
  if (e0 == e1) { return step(e0, x); }
  float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
vec2 k_smooth2(vec2 e0, vec2 e1, vec2 x) {
  return vec2(k_smooth1(e0.x, e1.x, x.x), k_smooth1(e0.y, e1.y, x.y));
}
vec3 k_smooth3(vec3 e0, vec3 e1, vec3 x) {
  return vec3(k_smooth1(e0.x, e1.x, x.x), k_smooth1(e0.y, e1.y, x.y), k_smooth1(e0.z, e1.z, x.z));
}
vec4 k_smooth4(vec4 e0, vec4 e1, vec4 x) {
  return vec4(k_smooth1(e0.x, e1.x, x.x), k_smooth1(e0.y, e1.y, x.y), k_smooth1(e0.z, e1.z, x.z), k_smooth1(e0.w, e1.w, x.w));
}
void k_output() {
  
}

void k_outputStage() {
  float life = a1.w;
  k_t = 1.0;
  if (life > 0.0) { k_t = min(1.0, a0.w / life); }
  k_speedMod = 1.0;
  k_oColor = a2;
  k_oSize = a3.x;
  k_oTile = a3.z;
  k_output();
}


vec4 k_orient(vec3 corner, vec3 right0, vec3 up0, vec3 cam, vec4 draw) {
  float alive = 0.0;
  if (a1.w > 0.0 && a0.w < a1.w) { alive = 1.0; }
  vec3 p = a0.xyz;
  vec3 v = a1.xyz * k_speedMod;
  if (ku[13].z < 0.5) {
    p = k_xform(p);
    v = k_xformDir(v);
  }
  float size = max(0.0, k_oSize);
  float mode = draw.x;
  float co = cos(a3.y);
  float sn = sin(a3.y);
  vec2 q = vec2(corner.x * co - corner.y * sn, corner.x * sn + corner.y * co);
  vec3 right = right0;
  vec3 up = up0;
  if (mode > 3.5) {
    // mesh: the model's vertex, scaled by size, turned about Y by rotation
    vec3 m = vec3(corner.x * co + corner.z * sn, corner.y, -corner.x * sn + corner.z * co) * size;
    return vec4(p + m, alive);
  }
  if (mode > 2.5) {
    // vertical: faces the camera, turning only about Y
    up = vec3(0.0, 1.0, 0.0);
    vec3 toCam = cam - p;
    right = normalize(cross(toCam, up) + vec3(0.000001, 0.0, 0.0)); // left-handed (ADR 0164): the camera's right
    return vec4(p + (right * q.x + up * q.y) * size, alive);
  }
  if (mode > 1.5) {
    // horizontal: flat in XZ
    return vec4(p + (vec3(1.0, 0.0, 0.0) * q.x + vec3(0.0, 0.0, 1.0) * q.y) * size, alive);
  }
  if (mode > 0.5) {
    // stretched along the velocity
    float speed = length(v);
    float len = size * draw.z + speed * draw.y;
    vec3 axis = up0;
    if (speed > 0.000001) { axis = v / speed; }
    vec3 toCam = normalize(cam - p);
    vec3 side = cross(toCam, axis); // left-handed order (ADR 0164)
    float sl = length(side);
    if (sl > 0.000001) { side = side / sl; } else { side = right0; }
    return vec4(p + side * corner.y * size - axis * (corner.x + 0.5) * len, alive);
  }
  return vec4(p + (right * q.x + up * q.y) * size, alive);
}
vec3 k_orientCentre() {
  vec3 p = a0.xyz;
  if (ku[13].z < 0.5) { p = k_xform(p); }
  return p;
}
vec4 k_tileUV(vec2 uv, vec4 draw, float rows0) {
  float cols = max(1.0, draw.w);
  float rows = max(1.0, rows0);
  float n = cols * rows;
  float whole = floor(k_oTile);
  float t0 = whole - floor(whole / n) * n;
  float t1 = (t0 + 1.0) - floor((t0 + 1.0) / n) * n;
  vec2 a = vec2((t0 - floor(t0 / cols) * cols + uv.x) / cols, (floor(t0 / cols) + uv.y) / rows);
  vec2 b = vec2((t1 - floor(t1 / cols) * cols + uv.x) / cols, (floor(t1 / cols) + uv.y) / rows);
  return vec4(a, b);
}
float k_tileBlend(vec4 draw) {
  return k_oTile - floor(k_oTile);
}

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
  vWorld = placed.xyz;
  vEye = kcam;
  gl_Position = placed.w > 0.5 ? clip : vec4(0.0, 0.0, -2.0, 1.0);
}

// ---- fragment ----
precision highp float;
varying vec2 vUV;
varying vec2 vUV2;
varying float vBlend;
varying vec4 vColor;
varying float vDepth;
varying vec3 vWorld;
varying vec3 vEye;
uniform sampler2D ktex;
uniform vec4 kdraw2;


void main() {
  vec4 t = texture2D(ktex, vUV);
  if (kdraw2.x > 0.5) { t = mix(t, texture2D(ktex, vUV2), vBlend); }
  vec4 col = t * vColor;
  
  
  if (kdraw2.z > 0.5) { col.rgb *= col.a; }
  gl_FragColor = col;
}
