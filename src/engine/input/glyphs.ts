/**
 * The default glyph set (ADR 0337): an image for every icon key a prompt gives (`xbox/buttonSouth`,
 * `playstation/leftTrigger`, `keyboard/space`, `pointer/button0`), drawn here as small SVGs from
 * plain shapes, letters and symbols (no vendor artwork or logos). Keyboard keys are keycaps with
 * the key's label, so every key has one; gamepad controls follow each family's style (PlayStation's
 * shapes, Xbox's coloured letters, Switch's letter layout, positions for generic pads); the pointer
 * is a mouse with the button lit.
 *
 * Nothing is shipped as files: each glyph is built on first use (a few hundred bytes of markup) and
 * served three ways: its markup, a URL (for DOM images), and an asset path under `@myco/glyphs/`
 * that `UIImage.image`, sprites and materials take like any texture asset.
 */
import { Assets } from "../scene/Assets";
import { control, type DeviceFamily } from "./controls";
import { controlLabel, type InputPrompt } from "./prompts";

/** One glyph: its SVG markup and size, a URL for it, and its asset path. */
export interface InputGlyph {
  /** The icon key (`xbox/buttonSouth`). */
  readonly key: string;
  /** The SVG markup. */
  readonly svg: string;
  /** Its size in pixels (64 high; keycaps with long labels are wider). */
  readonly width: number;
  readonly height: number;
  /** A URL showing it (a blob URL, or a data URL where there are no blob URLs), for `<img>` or CSS. */
  readonly url: string;
  /** Its asset path (`asset:@myco/glyphs/xbox/buttonSouth.svg`), for `UIImage.image` and anything else that takes a texture asset. */
  readonly asset: string;
}

const ASSET_PREFIX = "@myco/glyphs/";

// Colours: pads are dark with light ink, keys and the mouse light with dark ink; what's pressed is amber.
const INK = "#f2f3f5";
const BODY = "#2a2e35";
const SUNK = "#3d434d";
const KEY = "#eef0f3";
const KEY_EDGE = "#a9b0bb";
const KEY_INK = "#1f2329";
const LIT = "#ffc23d";
const FONT = `font-family="Inter, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif" font-weight="700"`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const doc = (w: number, h: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
/** Text centred on (x, y), shrunk to fit `room` pixels across. */
function text(x: number, y: number, s: string, size: number, fill: string, room = Infinity): string {
  const fit = Math.min(size, room / (Math.max(1, [...s].length) * 0.62));
  return `<text x="${x}" y="${y}" ${FONT} font-size="${+fit.toFixed(1)}" fill="${fill}" text-anchor="middle" dominant-baseline="central">${esc(s)}</text>`;
}
const disc = (r = 27, fill = BODY) => `<circle cx="32" cy="32" r="${r}" fill="${fill}" stroke="${INK}" stroke-width="3"/>`;
/** A small filled triangle pointing `dir` with its tip at (x, y). */
function arrow(x: number, y: number, dir: "up" | "down" | "left" | "right", fill = INK, s = 5): string {
  const p = dir === "up" ? [x, y, x - s, y + s, x + s, y + s] : dir === "down" ? [x, y, x - s, y - s, x + s, y - s] : dir === "left" ? [x, y, x + s, y - s, x + s, y + s] : [x, y, x - s, y - s, x - s, y + s];
  return `<polygon points="${p.join(" ")}" fill="${fill}"/>`;
}

// --- Keyboard ---------------------------------------------------------------------------------

function keycap(label: string): { svg: string; width: number } {
  const chars = [...label].length;
  const size = chars === 1 ? 28 : 18;
  const width = Math.max(64, Math.ceil(chars * size * 0.64 + 26));
  const body =
    `<rect x="3" y="4" width="${width - 6}" height="56" rx="10" fill="${KEY_EDGE}" stroke="${KEY_INK}" stroke-width="2"/>` +
    `<rect x="7" y="7" width="${width - 14}" height="43" rx="7" fill="${KEY}"/>` +
    text(width / 2, 29, label, size, KEY_INK, width - 20);
  return { svg: doc(width, 64, body), width };
}

// --- Pointer ----------------------------------------------------------------------------------

const MOUSE = "M18 24 Q18 6 32 6 Q46 6 46 24 V42 Q46 58 32 58 Q18 58 18 42 Z";

function mouse(lit: "button0" | "button1" | "button2" | "button3" | "button4" | "scroll" | null, extra = ""): string {
  const part = (d: string, on: boolean) => `<path d="${d}" fill="${on ? LIT : KEY}"/>`;
  return (
    `<path d="${MOUSE}" fill="${KEY}"/>` +
    part("M18 27 V24 Q18 6 32 6 V27 Z", lit === "button0") +
    part("M46 27 V24 Q46 6 32 6 V27 Z", lit === "button2") +
    `<path d="M32 6 V27 M18 27 H46" stroke="${KEY_INK}" stroke-width="2"/>` +
    `<rect x="28.5" y="11" width="7" height="12" rx="3.5" fill="${lit === "button1" || lit === "scroll" ? LIT : KEY_INK}" stroke="${KEY_INK}" stroke-width="1.5"/>` +
    `<rect x="13" y="31" width="6" height="7" rx="2" fill="${lit === "button4" ? LIT : KEY_EDGE}" stroke="${KEY_INK}" stroke-width="1.5"/>` +
    `<rect x="13" y="40" width="6" height="7" rx="2" fill="${lit === "button3" ? LIT : KEY_EDGE}" stroke="${KEY_INK}" stroke-width="1.5"/>` +
    `<path d="${MOUSE}" fill="none" stroke="${KEY_INK}" stroke-width="2.5"/>` +
    extra
  );
}

function pointerGlyph(name: string): string | null {
  switch (name) {
    case "button0":
    case "button1":
    case "button2":
    case "button3":
    case "button4":
      return doc(64, 64, mouse(name));
    case "scroll":
      return doc(64, 64, mouse("scroll", arrow(55, 12, "up", LIT, 5) + arrow(55, 52, "down", LIT, 5) + `<path d="M55 17 V47" stroke="${LIT}" stroke-width="3"/>`));
    case "delta":
      return doc(64, 64, `<g transform="translate(12.8 12.8) scale(0.6)">${mouse(null)}</g>` + arrow(32, 2, "up", LIT, 6) + arrow(32, 62, "down", LIT, 6) + arrow(2, 32, "left", LIT, 6) + arrow(62, 32, "right", LIT, 6));
    case "position":
      return doc(64, 64, `<path d="M20 8 V50 L30 41 L37 56 L44 53 L37 38 H51 Z" fill="${KEY}" stroke="${KEY_INK}" stroke-width="3" stroke-linejoin="round"/>`);
    default:
      return null;
  }
}

// --- Gamepads ---------------------------------------------------------------------------------

type PadStyle = "xbox" | "playstation" | "switch" | "generic";
type Face = "buttonSouth" | "buttonEast" | "buttonWest" | "buttonNorth";

const XBOX_COLOURS: Record<Face, string> = { buttonSouth: "#5fbf4a", buttonEast: "#ec4b40", buttonWest: "#4a90ec", buttonNorth: "#f3c537" };

function face(style: PadStyle, name: Face, label: string): string {
  if (style === "xbox") return disc() + text(32, 33, label, 30, XBOX_COLOURS[name]);
  if (style === "switch") return disc() + text(32, 33, label, 30, INK);
  if (style === "playstation") {
    const stroke = (colour: string) => `fill="none" stroke="${colour}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"`;
    const shape =
      name === "buttonSouth" ? `<path d="M22 22 L42 42 M42 22 L22 42" ${stroke("#86aef0")}/>`
      : name === "buttonEast" ? `<circle cx="32" cy="32" r="11" ${stroke("#ef6f78")}/>`
      : name === "buttonWest" ? `<rect x="22" y="22" width="20" height="20" ${stroke("#ea93cf")}/>`
      : `<path d="M32 19 L44 40 H20 Z" ${stroke("#52c9a9")}/>`;
    return disc() + shape;
  }
  // Generic: the four buttons as a diamond, the one meant lit.
  const at: Record<Face, [number, number]> = { buttonNorth: [32, 17], buttonEast: [47, 32], buttonSouth: [32, 47], buttonWest: [17, 32] };
  return disc() + (Object.keys(at) as Face[]).map((k) => `<circle cx="${at[k][0]}" cy="${at[k][1]}" r="6.5" fill="${k === name ? LIT : "none"}" stroke="${INK}" stroke-width="2.5"/>`).join("");
}

const shoulder = (label: string) => `<path d="M6 46 V30 Q6 16 22 16 H42 Q58 16 58 30 V46 Z" fill="${BODY}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` + text(32, 32, label, 20, INK, 44);
const trigger = (label: string) => `<path d="M14 56 V26 Q14 8 32 8 Q50 8 50 26 V56 Z" fill="${BODY}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>` + text(32, 34, label, 20, INK, 32);
const paddle = (label: string) => `<rect x="17" y="6" width="30" height="52" rx="13" fill="${BODY}" stroke="${INK}" stroke-width="3"/>` + text(32, 32, label, 16, INK, 24);

function stick(side: "L" | "R", axes: "both" | "x" | "y" | "press"): string {
  const press = axes === "press";
  let out = disc() + `<circle cx="32" cy="32" r="14" fill="${press ? LIT : SUNK}" stroke="${INK}" stroke-width="2"/>` + text(32, 33, side, 16, press ? KEY_INK : INK);
  if (axes === "both" || axes === "y") out += arrow(32, 8, "up") + arrow(32, 56, "down");
  if (axes === "both" || axes === "x") out += arrow(8, 32, "left") + arrow(56, 32, "right");
  if (press) out += `<circle cx="32" cy="32" r="21" fill="none" stroke="${LIT}" stroke-width="2" stroke-dasharray="4 3"/>`;
  return out;
}

function dpad(lit: "up" | "down" | "left" | "right" | "all"): string {
  const arms: Record<string, string> = { up: `<rect x="23" y="7" width="18" height="17" fill="${LIT}"/>`, down: `<rect x="23" y="40" width="18" height="17" fill="${LIT}"/>`, left: `<rect x="7" y="23" width="17" height="18" fill="${LIT}"/>`, right: `<rect x="40" y="23" width="17" height="18" fill="${LIT}"/>` };
  const cross = "M23 7 H41 V23 H57 V41 H41 V57 H23 V41 H7 V23 H23 Z";
  return (
    `<path d="${cross}" fill="${BODY}"/>` +
    (lit === "all" ? arrow(32, 11, "up") + arrow(32, 53, "down") + arrow(11, 32, "left") + arrow(53, 32, "right") : arms[lit]) +
    `<path d="${cross}" fill="none" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`
  );
}

/** A small round button with a symbol, or a capsule with a word. */
const symbolButton = (symbol: string) => disc(22) + symbol;
const capsule = (word: string) => `<rect x="3" y="18" width="58" height="28" rx="14" fill="${BODY}" stroke="${INK}" stroke-width="3"/>` + text(32, 32.5, word.toUpperCase(), 12, INK, 48);
const SYMBOLS = {
  view: `<rect x="21" y="21" width="14" height="12" rx="2" fill="none" stroke="${INK}" stroke-width="2.5"/><rect x="29" y="29" width="14" height="12" rx="2" fill="${BODY}" stroke="${INK}" stroke-width="2.5"/>`,
  menu: `<path d="M22 24 H42 M22 32 H42 M22 40 H42" stroke="${INK}" stroke-width="3" stroke-linecap="round"/>`,
  minus: `<path d="M21 32 H43" stroke="${INK}" stroke-width="4.5" stroke-linecap="round"/>`,
  plus: `<path d="M21 32 H43 M32 21 V43" stroke="${INK}" stroke-width="4.5" stroke-linecap="round"/>`,
  home: `<path d="M21 31 L32 21 L43 31 M25 28 V42 H39 V28" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`,
  share: `<rect x="22" y="27" width="20" height="15" rx="2" fill="none" stroke="${INK}" stroke-width="2.5"/><path d="M32 35 V19 M27 24 L32 19 L37 24" fill="none" stroke="${INK}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  capture: `<rect x="21" y="21" width="22" height="22" rx="4" fill="none" stroke="${INK}" stroke-width="2.5"/><circle cx="32" cy="32" r="5" fill="${INK}"/>`,
  mute: `<rect x="28" y="19" width="8" height="15" rx="4" fill="none" stroke="${INK}" stroke-width="2.5"/><path d="M23 30 Q23 40 32 40 Q41 40 41 30 M32 40 V45" fill="none" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/><path d="M22 44 L42 20" stroke="${LIT}" stroke-width="3" stroke-linecap="round"/>`,
};

const touchpad = () => `<rect x="4" y="14" width="56" height="36" rx="9" fill="${BODY}" stroke="${INK}" stroke-width="3"/><circle cx="32" cy="32" r="6" fill="${LIT}"/><circle cx="32" cy="32" r="11" fill="none" stroke="${LIT}" stroke-width="2"/>`;
const gyro = () =>
  `<circle cx="32" cy="32" r="11" fill="${BODY}" stroke="${INK}" stroke-width="3"/>` +
  `<path d="M12 38 A22 9 0 1 1 48 41" fill="none" stroke="${LIT}" stroke-width="3" stroke-linecap="round" transform="rotate(-15 32 32)"/>` +
  `<polygon points="52,34 51,46 42,40" fill="${LIT}" transform="rotate(-15 32 32)"/>`;
const accel = () =>
  `<rect x="24" y="16" width="30" height="32" rx="6" fill="${BODY}" stroke="${INK}" stroke-width="3"/>` +
  `<path d="M6 24 H17 M3 32 H17 M6 40 H17" stroke="${LIT}" stroke-width="3" stroke-linecap="round"/>`;

/** A rounded badge with a label, for controls without a drawing of their own. */
function badge(label: string): { svg: string; width: number } {
  const chars = [...label].length;
  const width = Math.max(64, Math.ceil(chars * 18 * 0.64 + 26));
  return { svg: doc(width, 64, `<rect x="3" y="12" width="${width - 6}" height="40" rx="12" fill="${BODY}" stroke="${INK}" stroke-width="3"/>` + text(width / 2, 32.5, label, 18, INK, width - 16)), width };
}

function padGlyph(style: PadStyle, name: string): string | null {
  const c = control(`<Gamepad>/${name}`);
  const label = c ? controlLabel(c, style as DeviceFamily) : name;
  const sym: Record<PadStyle, { select: string; start: string; misc1: string }> = {
    xbox: { select: symbolButton(SYMBOLS.view), start: symbolButton(SYMBOLS.menu), misc1: symbolButton(SYMBOLS.share) },
    playstation: { select: capsule(label), start: capsule(label), misc1: symbolButton(SYMBOLS.mute) },
    switch: { select: symbolButton(SYMBOLS.minus), start: symbolButton(SYMBOLS.plus), misc1: symbolButton(SYMBOLS.capture) },
    generic: { select: capsule(label), start: capsule(label), misc1: capsule(label) },
  };
  let body: string;
  switch (name) {
    case "buttonSouth":
    case "buttonEast":
    case "buttonWest":
    case "buttonNorth":
      body = face(style, name, label);
      break;
    case "leftShoulder":
    case "rightShoulder":
      body = shoulder(label);
      break;
    case "leftTrigger":
    case "rightTrigger":
      body = trigger(label);
      break;
    case "leftStick":
    case "rightStick":
      body = stick(name[0] === "l" ? "L" : "R", "both");
      break;
    case "leftStickX":
    case "rightStickX":
      body = stick(name[0] === "l" ? "L" : "R", "x");
      break;
    case "leftStickY":
    case "rightStickY":
      body = stick(name[0] === "l" ? "L" : "R", "y");
      break;
    case "leftStickPress":
    case "rightStickPress":
      body = stick(name[0] === "l" ? "L" : "R", "press");
      break;
    case "dpad":
      body = dpad("all");
      break;
    case "dpadUp":
    case "dpadDown":
    case "dpadLeft":
    case "dpadRight":
      body = dpad(name.slice(4).toLowerCase() as "up");
      break;
    case "select":
    case "start":
    case "misc1":
      body = sym[style][name];
      break;
    case "home":
      body = symbolButton(SYMBOLS.home);
      break;
    case "touchpadPress":
      body = touchpad();
      break;
    case "gyro":
      body = gyro();
      break;
    case "accel":
      body = accel();
      break;
    case "rightPaddle1":
    case "leftPaddle1":
    case "rightPaddle2":
    case "leftPaddle2":
      body = paddle(label);
      break;
    default:
      return null;
  }
  return doc(64, 64, body);
}

// --- The set ----------------------------------------------------------------------------------

class Glyph implements InputGlyph {
  private blobUrl: string | null = null;

  constructor(
    readonly key: string,
    readonly svg: string,
    readonly width: number,
    readonly height: number,
  ) {}

  get url(): string {
    if (this.blobUrl === null) {
      const canBlob = typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
      this.blobUrl = canBlob ? URL.createObjectURL(new Blob([this.svg], { type: "image/svg+xml" })) : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(this.svg)}`;
    }
    return this.blobUrl;
  }

  get asset(): string {
    return `asset:${ASSET_PREFIX}${this.key}.svg`;
  }
}

const made = new Map<string, Glyph | null>();

const PAD_STYLES: ReadonlySet<string> = new Set(["xbox", "playstation", "switch", "generic"]);

function make(key: string): Glyph | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  const family = key.slice(0, slash);
  const name = key.slice(slash + 1);
  if (family === "keyboard") {
    const c = control(`<Keyboard>/${name}`);
    const { svg, width } = keycap(c ? controlLabel(c, "keyboard") : name);
    return new Glyph(key, svg, width, 64);
  }
  if (family === "pointer") {
    const svg = pointerGlyph(name);
    if (svg) return new Glyph(key, svg, 64, 64);
    const c = control(`<Pointer>/${name}`);
    const b = badge(c ? controlLabel(c, "pointer") : name);
    return new Glyph(key, b.svg, b.width, 64);
  }
  if (PAD_STYLES.has(family)) {
    const svg = padGlyph(family as PadStyle, name);
    if (svg) return new Glyph(key, svg, 64, 64);
    const c = control(`<Gamepad>/${name}`);
    const b = badge(c ? controlLabel(c, family as DeviceFamily) : name);
    return new Glyph(key, b.svg, b.width, 64);
  }
  return null;
}

function glyph(key: string): Glyph | null {
  let g = made.get(key);
  if (g === undefined) made.set(key, (g = make(key)));
  return g;
}

/** The glyphs as assets: `@myco/glyphs/<icon key>.svg` serves the glyph's URL. */
Assets.addBuiltinSource({
  has: (path) => path.startsWith(ASSET_PREFIX) && path.endsWith(".svg") && glyph(path.slice(ASSET_PREFIX.length, -4)) !== null,
  get: (path) => glyph(path.slice(ASSET_PREFIX.length, -4))?.url,
});

/**
 * The engine's default button glyphs (ADR 0337), for the icon keys prompts give.
 *
 * ```ts
 * const prompt = this.input.prompt("jump")!;
 * hint.getComponent(UIImage)!.image = InputGlyphs.get(prompt.icons[0])!.asset;
 * ```
 */
export const InputGlyphs = {
  /** The glyph for an icon key (`xbox/buttonSouth`, `keyboard/space`, `pointer/button0`), or null for a key outside the set. */
  get(icon: string): InputGlyph | null {
    return glyph(icon);
  },

  /** The glyphs of a prompt's controls, in order (those outside the set left out). */
  of(prompt: InputPrompt): InputGlyph[] {
    return prompt.icons.map(glyph).filter((g): g is Glyph => g !== null);
  },
};
