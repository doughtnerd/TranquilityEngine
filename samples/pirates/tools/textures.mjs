// Procedural PNG textures for King of Pirates. Each returns a Buffer.
import { Canvas, fbm, mix, rng, tileNoise } from "./lib.mjs";

const S = 128;
const shade = (c, k) => c.map((v) => v * k);

/** Horizontal wood planks along u, tileable. */
function wood() {
  const cv = new Canvas(S);
  const grain = fbm(11, 4, 3);
  const r = rng(12);
  const planks = 8;
  const tint = Array.from({ length: planks }, () => 0.85 + r() * 0.3);
  const base = [150, 100, 58];
  cv.fill((x, y) => {
    const p = Math.floor((y / S) * planks);
    const edge = (y % (S / planks)) < 1.5;
    const g = grain((x / S + p * 0.17) % 1, ((y * 0.15) / S + p * 0.31) % 1);
    const k = tint[p] * (0.75 + g * 0.5);
    return edge ? shade(base, 0.45) : shade(base, k);
  });
  // nail dots at plank ends
  for (let p = 0; p < planks; p++) for (const x of [6, S - 7]) cv.disc(x, (p + 0.5) * (S / planks), 1.4, [60, 40, 25]);
  return cv.png();
}

/** White-ish cloth that tints well; `team` is an optional RGB for coloured variants (a stripe plus a faint cloth tone). */
function sail(team) {
  const cv = new Canvas(S);
  const weave = fbm(21, 8, 2);
  const base = team ? mix([245, 242, 232], team, 0.78) : [250, 247, 240];
  cv.fill((x, y) => {
    const t = 0.9 + weave(x / S, y / S) * 0.1;
    const seam = x % 32 < 1 ? 0.88 : 1;
    const thread = (x + y) % 3 === 0 ? 0.98 : 1;
    return shade(base, t * seam * thread);
  });
  return cv.png();
}

function rock() {
  const cv = new Canvas(S);
  const n = fbm(31, 4, 4);
  const crack = tileNoise(32, 9);
  cv.fill((x, y) => {
    const v = n(x / S, y / S);
    const c = Math.abs(crack(x / S, y / S) - 0.5) < 0.025 ? 0.55 : 1;
    return shade(mix([88, 90, 96], [140, 136, 128], v), c * (0.8 + v * 0.35));
  });
  return cv.png();
}

function sand() {
  const cv = new Canvas(S);
  const n = fbm(41, 6, 3);
  const r = rng(42);
  cv.fill((x, y) => shade(mix([214, 190, 128], [238, 218, 160], n(x / S, y / S)), 0.95 + ((x * 7 + y * 13) % 5) * 0.015));
  for (let i = 0; i < 90; i++) cv.set(Math.floor(r() * S), Math.floor(r() * S), 170, 150, 100);
  return cv.png();
}

/** Palm leaves: a green gradient with veins, along v. */
function palm() {
  const cv = new Canvas(S);
  const n = fbm(51, 6, 2);
  cv.fill((x, y) => {
    const d = Math.abs(x - S / 2) / (S / 2); // 0 at the midrib
    const vein = Math.abs(((y + d * 24) % 14) - 7) < 0.8 ? 0.82 : 1;
    const rib = d < 0.035 ? [150, 170, 70] : mix([34, 120, 44], [96, 168, 56], (1 - d) * 0.7 + n(x / S, y / S) * 0.3);
    return shade(rib, vein);
  });
  return cv.png();
}

/** Black pirate flag with a white skull and crossed bones, 2:1-ish within a square. */
function flag() {
  const cv = new Canvas(S);
  cv.fill((x, y) => [26, 24, 30]);
  const w = [240, 238, 226];
  cv.line(30, 34, 98, 94, 8, w);
  cv.line(98, 34, 30, 94, 8, w);
  for (const [x, y] of [[28, 32], [32, 36], [100, 32], [96, 36], [28, 96], [32, 92], [100, 96], [96, 92]]) cv.disc(x, y, 5, w);
  cv.disc(64, 54, 22, w);
  cv.rect(52, 62, 76, 82, w);
  cv.disc(55, 55, 6.5, [26, 24, 30]);
  cv.disc(73, 55, 6.5, [26, 24, 30]);
  cv.poly([[64, 60], [60, 69], [68, 69]], [26, 24, 30]);
  for (const x of [57, 61, 67, 71]) cv.rect(x - 0.5, 74, x + 0.5, 82, [26, 24, 30]);
  cv.rect(0, 0, S, 4, [190, 40, 40]);
  cv.rect(0, S - 4, S, S, [190, 40, 40]);
  return cv.png();
}

/** Tileable foam: bright blobs over transparent blue, for scrolling over water. */
function foam() {
  const cv = new Canvas(S);
  const a = fbm(61, 5, 4);
  const b = tileNoise(62, 12);
  cv.fill((x, y) => {
    const v = a(x / S, y / S) * 0.75 + b(x / S, y / S) * 0.25;
    const f = Math.max(0, Math.min(1, (v - 0.52) * 7));
    return [235, 245, 250, f * 230];
  });
  return cv.png();
}

/**
 * A soft, billowing puff for fog and smoke particles: a few overlapping soft lobes, broken up by
 * noise, white with the alpha falling to nothing well inside the edge (so no square shows).
 */
function smoke() {
  const cv = new Canvas(S);
  const n = fbm(71, 4, 4);
  const r = rng(72);
  const lobes = [[0, 0, 0.62]];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + r() * 0.6;
    const d = 0.22 + r() * 0.12;
    lobes.push([Math.cos(a) * d, Math.sin(a) * d, 0.34 + r() * 0.12]);
  }
  cv.fill((x, y) => {
    const u = (x + 0.5) / S - 0.5, v = (y + 0.5) / S - 0.5;
    let k = 0;
    for (const [lx, ly, lr] of lobes) {
      const d = Math.hypot(u * 2 - lx, v * 2 - ly) / lr;
      k = Math.max(k, Math.max(0, 1 - d * d));
    }
    const edge = Math.max(0, 1 - Math.hypot(u, v) * 2); // 0 at the inscribed circle
    const a = k * Math.min(1, edge * 3) * (0.55 + n(x / S, y / S) * 0.7);
    const shadeK = 0.86 + n((x + 40) / S, (y + 17) / S) * 0.14;
    return [255 * shadeK, 255 * shadeK, 255 * Math.min(1, shadeK + 0.03), Math.min(1, a) * 255];
  });
  return cv.png();
}

// ---------- icons (transparent background, 128 px) ----------
const circleBg = (cv, col) => {
  cv.disc(64, 64, 60, shade(col, 0.55));
  cv.disc(64, 64, 55, col);
};
const white = [250, 250, 245];

function iconWind() {
  const cv = new Canvas(S);
  circleBg(cv, [60, 150, 220]);
  for (const [y, len, off] of [[48, 56, 0], [64, 70, 8], [80, 50, 14]]) {
    cv.line(32 + off, y, 32 + off + len, y, 7, white);
    cv.disc(32 + off + len + 8, y - 8, 12, [0, 0, 0, 0]);
  }
  // curls at line ends
  for (const [x, y] of [[96, 48], [108, 64], [92, 80]]) {
    for (let a = 0; a < 5; a += 0.15) cv.disc(x + Math.cos(a - 1.6) * (2 + a * 2.2), y - 6 + Math.sin(a - 1.6) * (2 + a * 2.2), 3, white);
  }
  return cv.png();
}

function iconGhost() {
  const cv = new Canvas(S);
  circleBg(cv, [130, 90, 200]);
  const g = [245, 245, 255];
  cv.disc(64, 56, 28, g);
  cv.rect(36, 56, 92, 94, g);
  for (let i = 0; i < 4; i++) cv.disc(44 + i * 13.3, 94, 6.7, g);
  cv.disc(53, 54, 6, [60, 30, 100]);
  cv.disc(75, 54, 6, [60, 30, 100]);
  cv.disc(64, 70, 5, [60, 30, 100]);
  return cv.png();
}

function iconStorm() {
  const cv = new Canvas(S);
  circleBg(cv, [70, 76, 110]);
  const c = [215, 220, 235];
  cv.disc(46, 54, 17, c);
  cv.disc(66, 44, 22, c);
  cv.disc(88, 56, 16, c);
  cv.rect(46, 54, 88, 72, c);
  cv.poly([[68, 62], [52, 90], [64, 90], [56, 114], [82, 80], [70, 80], [78, 62]], [255, 224, 60]);
  return cv.png();
}

function iconCannon() {
  const cv = new Canvas(S);
  circleBg(cv, [200, 120, 50]);
  const dark = [40, 40, 46];
  cv.poly([[26, 76], [26, 52], [82, 40], [96, 46], [96, 70], [82, 78]], dark);
  cv.disc(30, 64, 14, dark);
  cv.disc(52, 90, 15, [110, 70, 40]);
  cv.disc(52, 90, 5, [60, 40, 25]);
  cv.disc(106, 58, 8, white);
  return cv.png();
}

function iconFlag() {
  const cv = new Canvas(S);
  circleBg(cv, [210, 60, 60]);
  cv.rect(38, 24, 46, 104, [235, 225, 205]);
  cv.poly([[46, 26], [100, 42], [46, 64]], white);
  cv.disc(42, 106, 9, [235, 225, 205]);
  return cv.png();
}

export function makeTextures(teamColors) {
  const out = {
    "wood.png": wood(),
    "sail.png": sail(),
    "rock.png": rock(),
    "sand.png": sand(),
    "palm.png": palm(),
    "flag.png": flag(),
    "foam.png": foam(),
    "smoke.png": smoke(),
    "icon_wind.png": iconWind(),
    "icon_ghost.png": iconGhost(),
    "icon_storm.png": iconStorm(),
    "icon_cannon.png": iconCannon(),
    "icon_flag.png": iconFlag(),
  };
  teamColors.forEach((c, i) => (out[`sail_team${i}.png`] = sail(c)));
  return out;
}
