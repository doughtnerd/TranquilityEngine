#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec4 ku[24];
uniform int kw;
uniform sampler2D ks0;
uniform sampler2D ks1;
uniform sampler2D ks2;
uniform sampler2D ks3;
uniform sampler2D kl;

uniform sampler2D kdepth;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
vec4 k_lutAt(int row, int i) { return texelFetch(kl, ivec2(i, row), 0); }

float k_depthAt(int x, int y) { return texelFetch(kdepth, ivec2(x, y), 0).r; }

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


void k_age() {
  float life = a1.w;
  if (a0.w + k_step >= life) {
    k_step = max(0.0, life - a0.w);
    k_dies = 1.0;
  }
  a0.w = a0.w + k_step;
  k_t = min(1.0, a0.w / life);
}
void k_gravity(float strength) {
  float g = strength * 9.81 * k_step;
  if (ku[13].z > 0.5) {
    a1.y = a1.y - g;
  } else {
    vec3 down = -ku[7].xyz;
    float len = length(down);
    if (len > 0.0) { down = down / len; }
    a1.x = a1.x + down.x * g;
    a1.y = a1.y + down.y * g;
    a1.z = a1.z + down.z * g;
  }
}
void k_force(vec3 f) {
  a1.x = a1.x + f.x * k_step;
  a1.y = a1.y + f.y * k_step;
  a1.z = a1.z + f.z * k_step;
}
void k_gpoint(vec3 c, float strength) {
  vec3 d = c - a0.xyz;
  float len = length(d);
  if (len < 0.000001) { return; }
  float a = strength / max(len * len, 0.0625) * k_step;
  a1.x = a1.x + d.x / len * a;
  a1.y = a1.y + d.y / len * a;
  a1.z = a1.z + d.z / len * a;
}
float k_nz(float v) {
  if (v == 0.0) { return 1.0; }
  return v;
}
void k_turbulence(vec3 sc, float octaves, vec3 vel, vec3 ts) {
  int oct = int(clamp(floor(octaves + 0.5), 1.0, 4.0));
  float time = ku[0].x;
  float x = a0.x / k_nz(sc.x);
  float y = a0.y / k_nz(sc.y);
  float z = a0.z / k_nz(sc.z);
  float nx = 0.0;
  float ny = 0.0;
  float nz = 0.0;
  float lvl = 1.0;
  for (int i = 0; i < oct; i++) {
    nx = nx + k_noise3(x * lvl + time * ts.x * lvl, y * lvl, z * lvl) / lvl;
    ny = ny + k_noise3(x * lvl + 31.7, y * lvl + time * ts.y * lvl, z * lvl) / lvl;
    nz = nz + k_noise3(x * lvl, y * lvl + 17.3, z * lvl + time * ts.z * lvl) / lvl;
    lvl = lvl * 2.0;
  }
  a1.x = a1.x + nx * vel.x * k_step;
  a1.y = a1.y + ny * vel.y * k_step;
  a1.z = a1.z + nz * vel.z * k_step;
}
void k_limit(float limit, float dampen) {
  float speed = length(a1.xyz);
  if (speed <= limit || speed < 0.000000001) { return; }
  float k = 1.0 - pow(1.0 - clamp(dampen, 0.0, 1.0), k_step * 60.0);
  float m = 1.0 + k * (max(0.0, limit) / speed - 1.0);
  a1.x = a1.x * m;
  a1.y = a1.y * m;
  a1.z = a1.z * m;
}
void k_integrate() {
  float k = k_speedMod * k_step;
  a0.x = a0.x + a1.x * k;
  a0.y = a0.y + a1.y * k;
  a0.z = a0.z + a1.z * k;
}
void k_noise(float freq, float power, float pa, float ra, uint index) {
  float seed = a3.w;
  float now = a0.w * freq;
  float before = (a0.w - k_step) * freq;
  uint base = 3000u + index * 8u;
  if (pa > 0.0) {
    float o0 = k_rand(seed, base) * 100.0;
    float o1 = k_rand(seed, base + 1u) * 100.0;
    float o2 = k_rand(seed, base + 2u) * 100.0;
    a0.x = a0.x + (k_noise3(o0 + now, 0.5, 0.0) - k_noise3(o0 + before, 0.5, 0.0)) * power * pa;
    a0.y = a0.y + (k_noise3(o1 + now, 0.5, 0.0) - k_noise3(o1 + before, 0.5, 0.0)) * power * pa;
    a0.z = a0.z + (k_noise3(o2 + now, 0.5, 0.0) - k_noise3(o2 + before, 0.5, 0.0)) * power * pa;
  }
  if (ra > 0.0) {
    float o3 = k_rand(seed, base + 3u) * 100.0;
    a3.y = a3.y + (k_noise3(o3 + now, 0.5, 0.0) - k_noise3(o3 + before, 0.5, 0.0)) * 3.141592653589793 * power * ra;
  }
}
void k_orbit(float speed, vec3 axis0) {
  vec3 axis = axis0;
  vec3 c = vec3(0.0, 0.0, 0.0);
  if (ku[13].z > 0.5) {
    axis = k_xformDir(axis);
    c = ku[5].xyz;
  }
  float len = length(axis);
  if (len < 0.000000001) { return; }
  axis = axis / len;
  float angle = speed * 0.017453292519943295 * k_step;
  vec3 r = a0.xyz - c;
  float d = dot(r, axis);
  float co = cos(angle);
  float sn = sin(angle);
  vec3 p = c + r * co + cross(axis, r) * sn + axis * d * (1.0 - co);
  a0.x = p.x;
  a0.y = p.y;
  a0.z = p.z;
}
void k_plane(float h, float bounce, float kill) {
  if (a0.y >= h) { return; }
  if (kill > 0.5) {
    k_dies = 1.0;
    a0.w = a1.w;
    return;
  }
  a0.y = h;
  if (a1.y < 0.0) { a1.y = -a1.y * bounce; }
}
void k_spin(float speed) {
  a3.y = a3.y + speed * 0.017453292519943295 * k_step;
}
void k_place(vec3 offset, float speed) {
  vec3 n = k_spos + offset;
  float world = ku[13].z;
  if (world < 0.5 && k_hasParent < 0.5) {
    a0.x = n.x;
    a0.y = n.y;
    a0.z = n.z;
    a1.x = k_sdir.x * speed;
    a1.y = k_sdir.y * speed;
    a1.z = k_sdir.z * speed;
    return;
  }
  vec3 origin = ku[5].xyz;
  if (k_hasParent > 0.5) { origin = k_parentPos; }
  vec3 wp = k_xformDir(n) + origin;
  vec3 v = k_xformDir(k_sdir);
  float len = length(v);
  if (len > 0.000000001) { v = v * (speed / len); } else { v = vec3(0.0, 0.0, 0.0); }
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
float k_shapeU(int mode, float spread) {
  float r = k_rand(a3.w, 900u);
  if (mode == 0) { return r; }
  float cap = ku[1].z;
  float rel = k_rel;
  if (mode == 3) { return rel / max(1.0, ku[1].y); }
  float ordinal = ku[11].x + rel;
  float x = ordinal / max(1.0, cap);
  if (spread > 0.0) { x = ordinal * spread; }
  if (mode == 1) { return x - floor(x); }
  float m = x - 2.0 * floor(x / 2.0);
  if (m < 1.0) { return m; }
  return 2.0 - m;
}


void k_depthCollide(float bounce, float kill, float thickness) {
  if (ku[18].z < 0.5) { return; }
  vec3 p = a0.xyz;
  if (ku[13].z < 0.5) { p = k_xform(p); }
  vec4 clip = ku[14] * p.x + ku[15] * p.y + ku[16] * p.z + ku[17];
  if (clip.w <= 0.0) { return; }
  vec2 ndc = clip.xy / clip.w;
  if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0) { return; }
  float px = floor((ndc.x * 0.5 + 0.5) * ku[18].x);
  float py = floor((0.5 - ndc.y * 0.5) * ku[18].y);
  float scene = k_depthAt(int(min(px, ku[18].x - 1.0)), int(min(py, ku[18].y - 1.0)));
  // The depth texture holds camera-space z (Babylon's depth renderer with storeCameraSpaceZ); 0 is "nothing drawn".
  float viewDepth = abs(dot(ku[19].xyz, p) + ku[19].w);
  float sceneDepth = abs(scene);
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


void k_shape(float radius, float angle, float arc, float thickness, float width, float height, float donutRadius, float columns, float rows, float spread, int mode) {
  k_spos = vec3(0.0, 0.0, 0.0);
  k_sdir = vec3(0.0, 1.0, 0.0);
  float u = k_shapeU(mode, spread);
  float theta = u * arc * 0.017453292519943295;
  float th = clamp(thickness, 0.0, 1.0);
  float inner = 1.0 - th;
  
}

void k_init() {
  float k_init_0 = 1.0;
  a1.w = k_init_0;
  float k_init_1 = 0.1;
  a3.x = k_init_1;
  float k_init_2 = 0.0;
  a3.y = k_init_2;
  vec4 k_init_3 = vec4(1.0, 1.0, 1.0, 1.0);
  a2.x = k_init_3.x;
  a2.y = k_init_3.y;
  a2.z = k_init_3.z;
  a2.w = k_init_3.w;
  float k_init_4 = 0.0;
  a3.z = k_init_4;
  float k_init_5 = max(2.0, 0.001);
  float k_init_6 = k_init_5;
  a1.w = k_init_6;
  vec4 k_init_7 = ku[10];
  a2.x = a2.x * k_init_7.x;
  a2.y = a2.y * k_init_7.y;
  a2.z = a2.z * k_init_7.z;
  a2.w = a2.w * k_init_7.w;
  k_shape(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0);
  k_place(vec3(0.0, 0.0, 0.0), 1.0);
}

void k_update() {
  k_age();
  k_integrate();
  k_depthCollide(0.5, 0.0, 0.5);
}


void k_run(float spawnHere) {
  if (spawnHere > 0.5) {
    a0 = vec4(0.0, 0.0, 0.0, 0.0);
    a1 = vec4(0.0, 0.0, 0.0, 0.0);
    a2 = vec4(0.0, 0.0, 0.0, 0.0);
    a3 = vec4(0.0, 0.0, 0.0, k_seed(k_sidx, ku[1].w, ku[11].y));
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

float k_spawnRing() {
  float cap = ku[1].z;
  float rel = k_idx - ku[1].x;
  rel = rel - floor(rel / cap) * cap;
  k_rel = rel;
  if (ku[1].y > 0.0 && rel < ku[1].y) { return 1.0; }
  return 0.0;
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int i = c.y * kw + c.x;
  a0 = texelFetch(ks0, c, 0);
  a1 = texelFetch(ks1, c, 0);
  a2 = texelFetch(ks2, c, 0);
  a3 = texelFetch(ks3, c, 0);
  if (float(i) < ku[1].z) {
    k_idx = float(i);
    k_rel = k_idx;
    k_sidx = k_idx;
    k_hasParent = 0.0;
    k_run(k_spawnRing());
  }
  o0 = a0;
  o1 = a1;
  o2 = a2;
  o3 = a3;
}
