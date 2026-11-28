/**
 * Per-asset import settings (ADR 0040): a sidecar file beside each asset, `<asset>.meta.json`
 * (`images/player.png` → `images/player.png.meta.json`), read through the same asset sources as
 * the asset itself. A missing sidecar means the defaults.
 *
 * ```jsonc
 * {
 *   "format": "myco.import@1",
 *   "pixelsPerUnit": 16,          // images: 0 or absent = the SpriteRenderer's, else the project's
 *   "filter": "point",            // "linear" (default) | "point"
 *   "wrap": "clamp",              // "clamp" (default) | "repeat" | "mirror"
 *   "mipmaps": false,             // default true
 *   "maxSize": 1024,              // images: largest side in pixels, 0 or absent = no limit (ADR 0115)
 *   "compression": "normal",      // images: "none" (default) | "low" | "normal" | "high" quality (ADR 0115)
 *   "platforms": {                // images: per-platform overrides of filter, wrap, mipmaps, maxSize, compression
 *     "web": { "maxSize": 512, "compression": "high" },
 *     "desktop": { "mipmaps": false }
 *   },
 *   "pivot": [0.5, 0],            // the whole image's pivot, 0..1 from the bottom-left (default centre)
 *   "sprites": [                  // named slices: rect in pixels from the top-left, pivot as above
 *     { "name": "walk_0", "rect": [0, 0, 16, 16], "pivot": [0.5, 0], "border": [2, 2, 2, 2] }
 *   ],                         // a slice may carry a 2D `skin` (bones, mesh, weights; ADR 0371, `animation/sprites/sidecar.ts`)
 *   "flipbooks": {               // images: slices shown in turn, each a clip `image.png#Flip/<name>` (ADR 0371)
 *     "walk": { "slices": ["walk_0", "walk_1"], "fps": 12, "loop": true }
 *   },
 *   "volume": 0.8,                // audio: multiplies every playback's volume (default 1)
 *   "stream": true,               // audio: decode in pieces while playing instead of up front (default false)
 *   "loopStart": 1.5,             // audio: loop region start in seconds; wins over the file's own points (ADR 0158 §4)
 *   "loopEnd": 7.25,              // audio: loop region end in seconds (exclusive); a lone key overrides just that end
 *   "ambisonic": {                // audio: the clip is ambisonic (ADR 0162 §2.4); required for any clip over 2 channels
 *     "order": 3,                 //   1 | 2 | 3, inferred from the channel count (4, 9, 16) when absent
 *     "convention": "fuma"        //   "ambix" (default: ACN order, SN3D) | "fuma"
 *   },
 *   "scale": 0.01,                // models: multiplies the model's size (default 1)
 *   "upAxis": "z",                // models: the axis that is up in the file, "y" (default) or "z" (ADR 0044)
 *   "normals": "calculate",       // models: "import" (default; calculated when the file has none) or "calculate"
 *   "facing": "back",             // models: the file's +Z faces "forward" (default; mirrors x) or "back" (mirrors z; ADR 0164)
 *   "pivots": "model",            // models: parts turn about their own "node" (default) or the "model" origin (ADR 0118)
 *   "materials": {                // models: a material asset for each of the model's own materials, by name (ADR 0089)
 *     "Paint": "asset:materials/car-paint.material.json"
 *   },
 *   "animation": { "influences": 8, "clips": { "Take 001": [{ "name": "Walk", "to": 1.2, "loop": true }] } }
 *                                 // models: skins, bone map and clip settings (ADR 0371), `animation/import/clips.ts`
 *   "lod": {                      // models: generated LOD levels (ADR 0446 §1); absent or null = none
 *     "levels": [{ "ratio": 0.5, "error": 0.01 }, { "ratio": 0.25, "error": 0.02 }],
 *     "attributes": true, "permissive": false, "lockBorders": false, "pixelError": 1
 *   },
 *   "occluder": "none"            // models: the occluder stand-in (ADR 0447 §3), "auto" (default) | "lod" | "none"
 * }
 * ```
 *
 * A slice is referenced as `asset:<image path>#<slice name>` (`asset:images/hero.png#walk_0`).
 *
 * Audio files may also carry a `sample` block (ADR 0342: loops, markers, trim, tempo, root note…), read and written by
 * `audio/sample/format.ts`; old sidecars without it are unchanged.
 *
 * And an `encoding` block (ADR 0351 §2): how the file is converted per platform in a game build, read and written by
 * `audio/encoding/format.ts` and resolved by `audio/encoding/resolve.ts`. It has its own `platforms`, so image and audio
 * keys never mix:
 *
 * ```jsonc
 * "encoding": { "profile": "UI", "quality": 0.7, "platforms": { "android": { "channels": "mono" } } }
 * ```
 *
 * And a `generated` block (ADR 0360 §6) on a sample baked from a generator, read and written by
 * `audio/generators/provenance.ts`:
 *
 * ```jsonc
 * "generated": { "generator": "audio/ui/coin.generator.json", "hash": "…", "seed": 1734, "variation": 0 }
 * ```
 */
import { parseSidecarEncoding, sidecarEncodingToJson } from "../audio/encoding/format";
import type { SidecarEncoding } from "../audio/encoding/types";
import { generatedProvenanceToJson, parseGeneratedProvenance, type GeneratedProvenance } from "../audio/generators/provenance";
import { parseSampleEdits, sampleEditsToJson } from "../audio/sample/format";
import type { SampleEdits } from "../audio/sample/types";
import { modelAnimationToJson, parseModelAnimation, type ModelAnimationSettings } from "../animation/import/clips";
import { flipbooksToJson, parseFlipbooks, parseSliceSkin, sliceSkinToJson, type SliceSkin, type SpriteFlipbook } from "../animation/sprites/sidecar";
import { DEFAULT_LOD_SETTINGS, type LodLevelSettings, type LodSettings, type OccluderSetting } from "./lod/types";

export const IMPORT_FORMAT = "myco.import@1";
export const SIDECAR_SUFFIX = ".meta.json";

export type TextureFilter = "linear" | "point";
export type TextureWrap = "clamp" | "repeat" | "mirror";
/** How hard a texture is compressed on its way to the GPU: `none` keeps it as authored; `high` is smallest and lowest quality (ADR 0115). */
export type TextureCompression = "none" | "low" | "normal" | "high";
export const TEXTURE_COMPRESSIONS: readonly TextureCompression[] = ["none", "low", "normal", "high"];
/** A build target an import setting can differ on (ADR 0115; `android` since ADR 0351 §1). */
export type ImportPlatform = "web" | "desktop" | "android";
export const IMPORT_PLATFORMS: readonly ImportPlatform[] = ["web", "desktop", "android"];
/** The image settings a platform can override. */
export interface PlatformOverrides {
  filter?: TextureFilter;
  wrap?: TextureWrap;
  mipmaps?: boolean;
  maxSize?: number;
  compression?: TextureCompression;
}
export const PLATFORM_OVERRIDE_KEYS = ["filter", "wrap", "mipmaps", "maxSize", "compression"] as const;
/** The axis that points up in a model file (ADR 0044); the engine's up is +Y. */
export type ModelUpAxis = "y" | "z";
/** A model's normals: the file's (calculated when it has none), or always calculated smooth. */
export type ModelNormals = "import" | "calculate";
/**
 * How a right-handed model file (glTF, FBX, OBJ) enters the engine's left-handed world (ADR 0164):
 * "forward" mirrors x, so the file's +Z (glTF's front) faces the engine's forward +Z, as Unity's
 * importers do; "back" mirrors z, so it faces -Z, as models looked before ADR 0164.
 */
export type ModelFacing = "forward" | "back";
export const MODEL_FACINGS: readonly ModelFacing[] = ["forward", "back"];
/** Where a model's parts turn (ADR 0118): about the model's origin, or about their own node in the file. */
export type ModelPivots = "model" | "node";

/** An ambisonic clip's channel convention (ADR 0162 §2.4): AmbiX is ACN order with SN3D, FuMa the older B-format. */
export type AmbisonicConvention = "ambix" | "fuma";
export const AMBISONIC_CONVENTIONS: readonly AmbisonicConvention[] = ["ambix", "fuma"];
/** Audio (ADR 0162 §2.4): marks a clip ambisonic. `order` is null when inferred from the channel count. */
export interface AmbisonicImport {
  order: 1 | 2 | 3 | null;
  convention: AmbisonicConvention;
}

/** A named rectangle of an image, drawn as its own sprite. */
export type SpriteFill = "stretch" | "tile";
export const SPRITE_FILLS: readonly SpriteFill[] = ["stretch", "tile"];

export interface SpriteSlice {
  /** Unique within the image; no `#`, `/` or quotes. */
  name: string;
  /** `[x, y, width, height]` in pixels, from the image's top-left corner. */
  rect: [number, number, number, number];
  /** The point the sprite is placed and turned about, 0..1 across the rect from its bottom-left. */
  pivot: [number, number];
  /** 9-slice borders in pixels, `[left, bottom, right, top]` (drawn 9-sliced by SpriteRenderer, ADR 0115). */
  border?: [number, number, number, number];
  /** How the edges and centre fill their area: `stretch` (default) or `tile` (repeat at pixel size; ADR 0115). Written only when `tile`. */
  fill?: SpriteFill;
  /** A 2D skin (ADR 0371): bones, a mesh and weights, drawn deformed under a `Skeleton2D`. */
  skin?: SliceSkin;
  /** Closed polygons in slice pixels from the slice's bottom-left, y up (ADR 0414): its outline, for 2D shadow casters (ADR 0413). Absent: the rect. */
  outline?: [number, number][][];
}

/** The secondary texture names lit 2D draws read (ADR 0414): a tangent-space normal map and a mask map. */
export const SECONDARY_TEXTURE_NAMES = ["normalMap", "maskMap"] as const;
export type SecondaryTextureName = (typeof SECONDARY_TEXTURE_NAMES)[number];
/** Whether `name` can name a secondary texture: lit sprites read the built-in ones, Secondary Texture graph nodes any (ADR 0415). */
export const isSecondaryTextureName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

export interface ImportSettings {
  pixelsPerUnit: number;
  filter: TextureFilter;
  wrap: TextureWrap;
  mipmaps: boolean;
  /** Largest side in pixels; 0 = no limit (ADR 0115). */
  maxSize: number;
  compression: TextureCompression;
  /** Images in a game build (ADR 0119): the authored size `[width, height]` of an image the export shrank, so sprites, tiles and slices keep their authored size. Never written by the editor. */
  sourceSize: [number, number] | null;
  /** Per-platform overrides of the image settings above; applied by `resolveImportSettings`. */
  platforms: Partial<Record<ImportPlatform, PlatformOverrides>>;
  pivot: [number, number];
  sprites: SpriteSlice[];
  /**
   * Images (ADR 0414): textures laid out like this one, by name (`normalMap`, `maskMap`; others are kept for shader
   * graph sprite targets), as `asset:` paths. Every slice samples them at its own UV.
   */
  secondaryTextures: Record<string, string>;
  /** Images (ADR 0414): the normal map's green channel points up (OpenGL, default) or down (DirectX). */
  normalMapGreen: "up" | "down";
  /** Images (ADR 0371): flipbooks by name, each a clip `image.png#Flip/<name>` over the named slices. */
  flipbooks: Record<string, SpriteFlipbook>;
  volume: number;
  stream: boolean;
  /** Audio (ADR 0158 §4): the loop region's start in seconds, or null to use the file's own. Wins over the file. */
  loopStart: number | null;
  /** Audio (ADR 0158 §4): the loop region's end in seconds (exclusive), or null to use the file's own. */
  loopEnd: number | null;
  /** Audio (ADR 0162 §2.4): the clip is ambisonic; null (absent) for an ordinary clip. */
  ambisonic: AmbisonicImport | null;
  /**
   * Audio (ADR 0342): the sample's non-destructive edits (loops, markers, trim, tempo, root, normalisation, baked
   * effects…), parsed by `audio/sample/format.ts`; null (absent) for a file nobody edited. When present its `loops`
   * replace `loopStart`/`loopEnd` (`sampleEditsFromSidecar`).
   */
  sample: SampleEdits | null;
  /** Audio (ADR 0351 §2): the file's encoding overrides and profile; null (absent) when it inherits everything. */
  encoding: SidecarEncoding | null;
  /** Audio (ADR 0360 §6): where a baked sample came from (generator, patch hash, seed, variation); null (absent) otherwise. */
  generated: GeneratedProvenance | null;
  /** Models (ADR 0044): multiplies the model's size. */
  scale: number;
  upAxis: ModelUpAxis;
  normals: ModelNormals;
  /** Models (ADR 0164): the file's +Z faces forward (x mirrored) or back (z mirrored). */
  facing: ModelFacing;
  /** Models (ADR 0118): one mesh referenced on its own (`m.glb#Wheel`) is in its node's space ("node") or the model's ("model"). */
  pivots: ModelPivots;
  /** Models (ADR 0089): a material asset (`asset:` path) drawn in place of each of the model's own materials, by the material's name. */
  materials: Record<string, string>;
  /**
   * Models (ADR 0371): skin influences, the bone map and its profile, the retarget source pose and the clips cut from
   * each take, parsed by `animation/import/clips.ts`; null (absent) when every value is the default.
   */
  animation: ModelAnimationSettings | null;
  /** Models (ADR 0446 §1): how LOD levels are generated; null (absent) for none. */
  lod: LodSettings | null;
  /** Models (ADR 0447 §3): the occluder stand-in, beside `lod`. */
  occluder: OccluderSetting;
}

const DEFAULT_IMPORT_SETTINGS: Readonly<ImportSettings> = Object.freeze<ImportSettings>({
  pixelsPerUnit: 0,
  filter: "linear",
  wrap: "clamp",
  mipmaps: true,
  maxSize: 0,
  compression: "none",
  sourceSize: null,
  platforms: {},
  pivot: [0.5, 0.5],
  sprites: [],
  secondaryTextures: Object.freeze({}) as Record<string, string>,
  normalMapGreen: "up",
  flipbooks: Object.freeze({}) as Record<string, SpriteFlipbook>,
  volume: 1,
  stream: false,
  loopStart: null,
  loopEnd: null,
  ambisonic: null,
  sample: null,
  encoding: null,
  generated: null,
  scale: 1,
  upAxis: "y",
  normals: "import",
  facing: "forward",
  pivots: "node",
  materials: Object.freeze({}) as Record<string, string>,
  animation: null,
  lod: null,
  occluder: "auto",
});

/** A copy of the defaults (safe to change). */
export const defaultImportSettings = (): ImportSettings => ({ ...DEFAULT_IMPORT_SETTINGS, pivot: [0.5, 0.5], sprites: [], secondaryTextures: {}, flipbooks: {}, materials: {}, platforms: {} });

/** `images/a.png` → `images/a.png.meta.json`. */
export const sidecarPath = (assetPath: string): string => `${assetPath}${SIDECAR_SUFFIX}`;
/** True for a sidecar file (`*.meta.json`). */
export const isSidecarPath = (path: string): boolean => path.toLowerCase().endsWith(SIDECAR_SUFFIX);
/** The asset a sidecar belongs to: `images/a.png.meta.json` → `images/a.png`. */
export const sidecarAsset = (path: string): string => path.slice(0, -SIDECAR_SUFFIX.length);

/**
 * Split a sprite reference into the image path and slice name: `asset:images/a.png#walk_0` →
 * `{ path: "images/a.png", slice: "walk_0" }`; without `#`, `slice` is null.
 */
export function splitSpriteRef(ref: string): { path: string; slice: string | null } {
  const p = ref.replace(/^asset:/, "").replace(/^\.?\//, "");
  const i = p.indexOf("#");
  return i < 0 ? { path: p, slice: null } : { path: p.slice(0, i), slice: p.slice(i + 1) };
}

/** Why `name` can't name a slice (given the other names), or null if it can. */
export function whyNotSliceName(name: string, others: readonly string[] = []): string | null {
  if (name.trim() === "") return "a name can't be empty";
  if (name !== name.trim()) return "a name can't start or end with a space";
  if (/[#/\\"']/.test(name)) return "a name can't contain # / \\ or quotes";
  if (others.includes(name)) return `there's already a slice named "${name}"`;
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumberArray = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x));

const isMaxSize = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isCompression = (v: unknown): v is TextureCompression => (TEXTURE_COMPRESSIONS as readonly unknown[]).includes(v);

/**
 * Read a sidecar's parsed JSON into settings, with defaults for anything missing. Values of the
 * wrong type are skipped and listed in `problems` (a bad sidecar never stops an asset loading).
 * Throws for a sidecar of another format, such as a newer version.
 */
export function parseImportSettings(raw: unknown, where = "import settings"): { settings: ImportSettings; problems: string[] } {
  const settings = defaultImportSettings();
  const problems: string[] = [];
  if (raw === undefined || raw === null) return { settings, problems };
  if (!isObject(raw)) throw new Error(`${where}: expected an object with "format": "${IMPORT_FORMAT}".`);
  if (raw.format !== IMPORT_FORMAT) throw new Error(`${where}: unknown format ${JSON.stringify(raw.format)}; expected "${IMPORT_FORMAT}".`);
  const bad = (key: string, expected: string) => problems.push(`${where}: "${key}" should be ${expected}; using the default.`);

  if (raw.pixelsPerUnit !== undefined) {
    if (typeof raw.pixelsPerUnit === "number" && raw.pixelsPerUnit >= 0 && Number.isFinite(raw.pixelsPerUnit)) settings.pixelsPerUnit = raw.pixelsPerUnit;
    else bad("pixelsPerUnit", "a number ≥ 0");
  }
  if (raw.filter !== undefined) {
    if (raw.filter === "linear" || raw.filter === "point") settings.filter = raw.filter;
    else bad("filter", '"linear" or "point"');
  }
  if (raw.wrap !== undefined) {
    if (raw.wrap === "clamp" || raw.wrap === "repeat" || raw.wrap === "mirror") settings.wrap = raw.wrap;
    else bad("wrap", '"clamp", "repeat" or "mirror"');
  }
  if (raw.mipmaps !== undefined) {
    if (typeof raw.mipmaps === "boolean") settings.mipmaps = raw.mipmaps;
    else bad("mipmaps", "true or false");
  }
  if (raw.maxSize !== undefined) {
    if (isMaxSize(raw.maxSize)) settings.maxSize = raw.maxSize;
    else bad("maxSize", "a whole number ≥ 0");
  }
  if (raw.compression !== undefined) {
    if (isCompression(raw.compression)) settings.compression = raw.compression;
    else bad("compression", '"none", "low", "normal" or "high"');
  }
  if (raw.sourceSize !== undefined) {
    const v = raw.sourceSize;
    if (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n > 0)) settings.sourceSize = [v[0], v[1]];
    else bad("sourceSize", "[width, height] in whole pixels");
  }
  if (raw.platforms !== undefined) {
    if (!isObject(raw.platforms)) bad("platforms", "an object keyed by platform");
    else {
      for (const [name, value] of Object.entries(raw.platforms)) {
        if (!(IMPORT_PLATFORMS as readonly string[]).includes(name)) {
          problems.push(`${where}: unknown platform "${name}" in "platforms" (expected ${IMPORT_PLATFORMS.join(" or ")}); skipped.`);
          continue;
        }
        if (!isObject(value)) {
          problems.push(`${where}: platforms.${name} should be an object; skipped.`);
          continue;
        }
        const o: PlatformOverrides = {};
        const badOverride = (key: string, expected: string) => problems.push(`${where}: platforms.${name}.${key} should be ${expected}; ignored.`);
        for (const [key, v] of Object.entries(value)) {
          if (key === "filter") (v === "linear" || v === "point" ? (o.filter = v) : badOverride(key, '"linear" or "point"'));
          else if (key === "wrap") (v === "clamp" || v === "repeat" || v === "mirror" ? (o.wrap = v) : badOverride(key, '"clamp", "repeat" or "mirror"'));
          else if (key === "mipmaps") (typeof v === "boolean" ? (o.mipmaps = v) : badOverride(key, "true or false"));
          else if (key === "maxSize") (isMaxSize(v) ? (o.maxSize = v) : badOverride(key, "a whole number ≥ 0"));
          else if (key === "compression") (isCompression(v) ? (o.compression = v) : badOverride(key, '"none", "low", "normal" or "high"'));
          else problems.push(`${where}: platforms.${name}.${key} can't differ per platform (expected ${PLATFORM_OVERRIDE_KEYS.join(", ")}); ignored.`);
        }
        if (Object.keys(o).length > 0) settings.platforms[name as ImportPlatform] = o;
      }
    }
  }
  if (raw.pivot !== undefined) {
    if (isNumberArray(raw.pivot, 2)) settings.pivot = [raw.pivot[0], raw.pivot[1]];
    else bad("pivot", "[x, y]");
  }
  if (raw.volume !== undefined) {
    if (typeof raw.volume === "number" && raw.volume >= 0 && Number.isFinite(raw.volume)) settings.volume = raw.volume;
    else bad("volume", "a number ≥ 0");
  }
  if (raw.stream !== undefined) {
    if (typeof raw.stream === "boolean") settings.stream = raw.stream;
    else bad("stream", "true or false");
  }
  if (raw.loopStart !== undefined) {
    if (typeof raw.loopStart === "number" && raw.loopStart >= 0 && Number.isFinite(raw.loopStart)) settings.loopStart = raw.loopStart;
    else bad("loopStart", "a number of seconds ≥ 0");
  }
  if (raw.loopEnd !== undefined) {
    if (typeof raw.loopEnd === "number" && raw.loopEnd > 0 && Number.isFinite(raw.loopEnd)) settings.loopEnd = raw.loopEnd;
    else bad("loopEnd", "a number of seconds > 0");
  }
  if (settings.loopStart !== null && settings.loopEnd !== null && settings.loopEnd <= settings.loopStart) {
    problems.push(`${where}: loopEnd should be after loopStart; both ignored.`);
    settings.loopStart = null;
    settings.loopEnd = null;
  }
  if (raw.ambisonic !== undefined) {
    const a = raw.ambisonic;
    if (!isObject(a)) bad("ambisonic", 'an object like { "order": 3, "convention": "ambix" }');
    else {
      const amb: AmbisonicImport = { order: null, convention: "ambix" };
      if (a.order !== undefined) {
        if (a.order === 1 || a.order === 2 || a.order === 3) amb.order = a.order;
        else problems.push(`${where}: ambisonic.order should be 1, 2 or 3; inferred from the channel count.`);
      }
      if (a.convention !== undefined) {
        if (a.convention === "ambix" || a.convention === "fuma") amb.convention = a.convention;
        else problems.push(`${where}: ambisonic.convention should be "ambix" or "fuma"; using "ambix".`);
      }
      settings.ambisonic = amb;
    }
  }
  if (raw.sample !== undefined && raw.sample !== null) settings.sample = parseSampleEdits(raw.sample, `${where}: sample`, problems);
  settings.encoding = parseSidecarEncoding(raw.encoding, `${where}: encoding`, problems);
  settings.generated = parseGeneratedProvenance(raw.generated, `${where}: generated`, problems);
  if (raw.scale !== undefined) {
    if (typeof raw.scale === "number" && raw.scale > 0 && Number.isFinite(raw.scale)) settings.scale = raw.scale;
    else bad("scale", "a number > 0");
  }
  if (raw.upAxis !== undefined) {
    if (raw.upAxis === "y" || raw.upAxis === "z") settings.upAxis = raw.upAxis;
    else bad("upAxis", '"y" or "z"');
  }
  if (raw.normals !== undefined) {
    if (raw.normals === "import" || raw.normals === "calculate") settings.normals = raw.normals;
    else bad("normals", '"import" or "calculate"');
  }
  if (raw.facing !== undefined) {
    if (raw.facing === "forward" || raw.facing === "back") settings.facing = raw.facing;
    else bad("facing", '"forward" or "back"');
  }
  if (raw.pivots !== undefined) {
    if (raw.pivots === "model" || raw.pivots === "node") settings.pivots = raw.pivots;
    else bad("pivots", '"model" or "node"');
  }
  if (raw.materials !== undefined) {
    if (!isObject(raw.materials)) bad("materials", "an object of material asset paths by material name");
    else {
      for (const [name, path] of Object.entries(raw.materials)) {
        if (typeof path === "string") {
          if (path) settings.materials[name] = path;
        } else problems.push(`${where}: materials["${name}"] should be a material asset path; ignored.`);
      }
    }
  }
  if (raw.animation !== undefined && raw.animation !== null) {
    const animation = parseModelAnimation(raw.animation, `${where}: animation`, problems);
    settings.animation = modelAnimationToJson(animation) ? animation : null;
  }
  if (raw.lod !== undefined && raw.lod !== null) settings.lod = parseLodSettings(raw.lod, `${where}: lod`, problems);
  if (raw.occluder !== undefined) {
    if (raw.occluder === "auto" || raw.occluder === "lod" || raw.occluder === "none") settings.occluder = raw.occluder;
    else bad("occluder", '"auto", "lod" or "none"');
  }
  if (raw.sprites !== undefined) {
    if (!Array.isArray(raw.sprites)) bad("sprites", "a list");
    else {
      const names: string[] = [];
      raw.sprites.forEach((s, i) => {
        const at = `sprites[${i}]`;
        if (!isObject(s) || typeof s.name !== "string" || !isNumberArray(s.rect, 4)) {
          problems.push(`${where}: ${at} needs a "name" and a "rect" [x, y, width, height]; skipped.`);
          return;
        }
        const why = whyNotSliceName(s.name, names);
        if (why) {
          problems.push(`${where}: ${at}: ${why}; skipped.`);
          return;
        }
        if (s.rect[2] <= 0 || s.rect[3] <= 0) {
          problems.push(`${where}: ${at} ("${s.name}") has no area; skipped.`);
          return;
        }
        names.push(s.name);
        const slice: SpriteSlice = { name: s.name, rect: [s.rect[0], s.rect[1], s.rect[2], s.rect[3]], pivot: isNumberArray(s.pivot, 2) ? [s.pivot[0], s.pivot[1]] : [...settings.pivot] };
        if (s.border !== undefined) {
          if (isNumberArray(s.border, 4)) slice.border = [s.border[0], s.border[1], s.border[2], s.border[3]];
          else problems.push(`${where}: ${at}.border should be [left, bottom, right, top]; ignored.`);
        }
        if (s.fill !== undefined) {
          if (s.fill === "stretch" || s.fill === "tile") slice.fill = s.fill;
          else problems.push(`${where}: ${at}.fill should be "stretch" or "tile"; ignored.`);
        }
        const skin = parseSliceSkin(s.skin, `${where}: ${at}.skin`, problems);
        if (skin) slice.skin = skin;
        if (s.outline !== undefined) {
          const outline = Array.isArray(s.outline) ? s.outline.map((poly) => (Array.isArray(poly) ? poly.filter((p): p is [number, number] => isNumberArray(p, 2)).map((p): [number, number] => [p[0], p[1]]) : [])).filter((poly) => poly.length >= 3) : [];
          if (outline.length > 0) slice.outline = outline;
          else problems.push(`${where}: ${at}.outline should be a list of polygons of [x, y] points (at least 3 each); ignored.`);
        }
        settings.sprites.push(slice);
      });
    }
  }
  if (raw.secondaryTextures !== undefined) {
    if (!isObject(raw.secondaryTextures)) bad("secondaryTextures", "an object of texture asset paths by name");
    else {
      for (const [name, path] of Object.entries(raw.secondaryTextures)) {
        if (typeof path !== "string") {
          problems.push(`${where}: secondaryTextures["${name}"] should be a texture asset path; ignored.`);
          continue;
        }
        if (!path) continue;
        // Custom names are first class (ADR 0415: Sprite Custom Lit graphs read them by name), so they must be names.
        if (!isSecondaryTextureName(name)) problems.push(`${where}: secondaryTextures["${name}"] should be a name of letters, digits and _ not starting with a digit (shader graphs read it by name); kept.`);
        settings.secondaryTextures[name] = path;
      }
    }
  }
  if (raw.normalMapGreen !== undefined) {
    if (raw.normalMapGreen === "up" || raw.normalMapGreen === "down") settings.normalMapGreen = raw.normalMapGreen;
    else bad("normalMapGreen", '"up" or "down"');
  }
  if (raw.flipbooks !== undefined && raw.flipbooks !== null) {
    settings.flipbooks = parseFlipbooks(raw.flipbooks, `${where}: flipbooks`, problems);
    const names = new Set(settings.sprites.map((s) => s.name));
    for (const [name, f] of Object.entries(settings.flipbooks)) {
      const missing = f.slices.filter((s) => !names.has(s));
      if (missing.length) problems.push(`${where}: flipbooks.${name} names slices the image doesn't have (${missing.join(", ")}); those frames draw the whole image.`);
    }
  }
  return { settings, problems };
}

/**
 * The sidecar's `lod` (ADR 0446 §1). A missing or bad key takes its value from `DEFAULT_LOD_SETTINGS` (a bad one with a
 * problem); a level outside 0 < ratio < 1, with a negative error, or not below the level before it is dropped. Null
 * for a value that isn't an object.
 */
function parseLodSettings(raw: unknown, where: string, problems: string[]): LodSettings | null {
  if (!isObject(raw)) {
    problems.push(`${where} should be an object like { "levels": [{ "ratio": 0.5, "error": 0.01 }] } or null; no levels generated.`);
    return null;
  }
  const d = DEFAULT_LOD_SETTINGS;
  const flag = (key: "attributes" | "permissive" | "lockBorders"): boolean => {
    const v = raw[key];
    if (v === undefined) return d[key];
    if (typeof v === "boolean") return v;
    problems.push(`${where}.${key} should be true or false; using ${d[key]}.`);
    return d[key];
  };
  let levels: LodLevelSettings[] = d.levels.map((l) => ({ ...l }));
  if (raw.levels !== undefined) {
    if (!Array.isArray(raw.levels)) problems.push(`${where}.levels should be a list of { "ratio", "error" }; using the defaults.`);
    else {
      levels = [];
      raw.levels.forEach((l: unknown, i) => {
        const at = `${where}.levels[${i}]`;
        if (!isObject(l) || typeof l.ratio !== "number" || !(l.ratio > 0 && l.ratio < 1)) return void problems.push(`${at}.ratio should be a number between 0 and 1; level dropped.`);
        if (typeof l.error !== "number" || !Number.isFinite(l.error) || l.error < 0) return void problems.push(`${at}.error should be a number ≥ 0 (a fraction of the bounding-box diagonal); level dropped.`);
        const last = levels.at(-1);
        if (last && l.ratio >= last.ratio) return void problems.push(`${at}.ratio should be below the level before it (${last.ratio}); level dropped.`);
        levels.push({ ratio: l.ratio, error: l.error });
      });
    }
  }
  const attributes = flag("attributes"), permissive = flag("permissive"), lockBorders = flag("lockBorders");
  let pixelError = d.pixelError;
  if (raw.pixelError !== undefined) {
    if (typeof raw.pixelError === "number" && Number.isFinite(raw.pixelError) && raw.pixelError > 0) pixelError = raw.pixelError;
    else problems.push(`${where}.pixelError should be a number of pixels > 0; using ${d.pixelError}.`);
  }
  return { levels, attributes, permissive, lockBorders, pixelError };
}

/** The sidecar JSON of `lod`: every key written, so the file says what it generates. */
function lodSettingsToJson(lod: LodSettings): Record<string, unknown> {
  return { levels: lod.levels.map((l) => ({ ratio: l.ratio, error: l.error })), attributes: lod.attributes, permissive: lod.permissive, lockBorders: lod.lockBorders, pixelError: lod.pixelError };
}

const samePair = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1];

/** The `platforms` object to write: only overrides that differ from the base settings, or null for none. */
function platformsJSON(settings: ImportSettings): Record<string, Record<string, unknown>> | null {
  const out: Record<string, Record<string, unknown>> = {};
  for (const platform of IMPORT_PLATFORMS) {
    const o = settings.platforms[platform];
    if (!o) continue;
    const kept: Record<string, unknown> = {};
    for (const key of PLATFORM_OVERRIDE_KEYS) if (o[key] !== undefined && o[key] !== settings[key]) kept[key] = o[key];
    if (Object.keys(kept).length > 0) out[platform] = kept;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** `settings` with one platform override set (`value` undefined clears it, dropping an emptied platform). Doesn't change `settings`. */
export function withPlatformOverride<K extends keyof PlatformOverrides>(settings: ImportSettings, platform: ImportPlatform, key: K, value: PlatformOverrides[K] | undefined): ImportSettings {
  const next: PlatformOverrides = { ...settings.platforms[platform] };
  if (value === undefined) delete next[key];
  else next[key] = value;
  const platforms = { ...settings.platforms };
  if (Object.keys(next).length > 0) platforms[platform] = next;
  else delete platforms[platform];
  return { ...settings, platforms };
}

/**
 * The settings as one platform sees them: its overrides applied over the base, with `platforms`
 * emptied. Returns `settings` itself when the platform overrides nothing (ADR 0115).
 */
export function resolveImportSettings(settings: ImportSettings, platform: ImportPlatform): ImportSettings {
  const o = settings.platforms[platform];
  if (!o || Object.keys(o).length === 0) return settings;
  const out: ImportSettings = { ...settings, platforms: {} };
  for (const key of PLATFORM_OVERRIDE_KEYS) {
    const v = o[key];
    if (v !== undefined) (out as unknown as Record<string, unknown>)[key] = v;
  }
  return out;
}

/**
 * A texture's size after `maxSize` (the longest side is clamped, aspect kept, never below 1 px).
 * Game exports apply it (ADR 0119; `compression` changes the encoding, not the size).
 */
export function clampTextureSize(width: number, height: number, maxSize: number): [number, number] {
  const longest = Math.max(width, height);
  if (maxSize <= 0 || longest <= maxSize) return [width, height];
  const k = maxSize / longest;
  return [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))];
}

/** An image's authored size: the sidecar's `sourceSize` when the build shrank it (ADR 0119), else the texture's own. */
export function authoredSize(settings: ImportSettings, width: number, height: number): [number, number] {
  return settings.sourceSize ? [settings.sourceSize[0], settings.sourceSize[1]] : [width, height];
}

/** The sidecar JSON for `settings`: the format, then only what differs from the defaults. */
function importSettingsJSON(settings: ImportSettings): Record<string, unknown> {
  const d = DEFAULT_IMPORT_SETTINGS;
  const out: Record<string, unknown> = { format: IMPORT_FORMAT };
  if (settings.pixelsPerUnit !== d.pixelsPerUnit) out.pixelsPerUnit = settings.pixelsPerUnit;
  if (settings.filter !== d.filter) out.filter = settings.filter;
  if (settings.wrap !== d.wrap) out.wrap = settings.wrap;
  if (settings.mipmaps !== d.mipmaps) out.mipmaps = settings.mipmaps;
  if (settings.maxSize !== d.maxSize) out.maxSize = settings.maxSize;
  if (settings.compression !== d.compression) out.compression = settings.compression;
  if (settings.sourceSize) out.sourceSize = [...settings.sourceSize];
  const platforms = platformsJSON(settings);
  if (platforms) out.platforms = platforms;
  if (!samePair(settings.pivot, d.pivot)) out.pivot = [...settings.pivot];
  if (settings.volume !== d.volume) out.volume = settings.volume;
  if (settings.stream !== d.stream) out.stream = settings.stream;
  if (settings.loopStart !== d.loopStart) out.loopStart = settings.loopStart;
  if (settings.loopEnd !== d.loopEnd) out.loopEnd = settings.loopEnd;
  if (settings.ambisonic) {
    const a = settings.ambisonic;
    out.ambisonic = { ...(a.order !== null ? { order: a.order } : {}), ...(a.convention !== "ambix" ? { convention: a.convention } : {}) };
  }
  if (settings.sample) out.sample = sampleEditsToJson(settings.sample);
  const encoding = sidecarEncodingToJson(settings.encoding ?? null);
  if (encoding) out.encoding = encoding;
  if (settings.generated) out.generated = generatedProvenanceToJson(settings.generated);
  if (settings.scale !== d.scale) out.scale = settings.scale;
  if (settings.upAxis !== d.upAxis) out.upAxis = settings.upAxis;
  if (settings.normals !== d.normals) out.normals = settings.normals;
  if (settings.facing !== d.facing) out.facing = settings.facing;
  if (settings.pivots !== d.pivots) out.pivots = settings.pivots;
  const materials = Object.entries(settings.materials ?? {}).filter(([, v]) => v);
  if (materials.length) out.materials = Object.fromEntries(materials);
  const animation = modelAnimationToJson(settings.animation);
  if (animation) out.animation = animation;
  if (settings.lod) out.lod = lodSettingsToJson(settings.lod);
  if (settings.occluder !== d.occluder) out.occluder = settings.occluder;
  if (settings.sprites.length > 0) {
    out.sprites = settings.sprites.map((s) => ({ name: s.name, rect: [...s.rect], pivot: [...s.pivot], ...(s.border && s.border.some((b) => b !== 0) ? { border: [...s.border] } : {}), ...(s.fill === "tile" ? { fill: "tile" } : {}), ...(s.skin ? { skin: sliceSkinToJson(s.skin) } : {}), ...(s.outline && s.outline.length ? { outline: s.outline.map((poly) => poly.map((p) => [p[0], p[1]])) } : {}) }));
  }
  const secondary = Object.entries(settings.secondaryTextures ?? {}).filter(([, v]) => v);
  if (secondary.length) out.secondaryTextures = Object.fromEntries(secondary);
  if (settings.normalMapGreen === "down") out.normalMapGreen = "down";
  const flipbooks = flipbooksToJson(settings.flipbooks);
  if (flipbooks) out.flipbooks = flipbooks;
  return out;
}

/** Sidecar text: two-space JSON with number lists on one line, one slice per line. */
export function formatImportSettings(settings: ImportSettings): string {
  const json = importSettingsJSON(settings);
  const { sprites, flipbooks, ...rest } = json;
  let text = JSON.stringify(rest, null, 2).replace(/\[\s+([-\d.e+,\s]+?)\s+\]/g, (_, inner: string) => `[${inner.split(/,\s*/).join(", ")}]`);
  // One object per line: `"key": value` pairs, number lists spaced.
  const inline = (o: Record<string, unknown>) => `{ ${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${Array.isArray(v) && v.every((x) => typeof x === "number") ? `[${v.join(", ")}]` : JSON.stringify(v)}`).join(", ")} }`;
  if (Array.isArray(sprites)) {
    const lines = (sprites as Record<string, unknown>[]).map((s) => `    ${inline(s)}`);
    text = `${text.slice(0, -2)},\n  "sprites": [\n${lines.join(",\n")}\n  ]\n}`;
  }
  if (flipbooks) {
    const lines = Object.entries(flipbooks as Record<string, Record<string, unknown>>).map(([name, f]) => `    ${JSON.stringify(name)}: ${inline(f)}`);
    text = `${text.slice(0, -2)},\n  "flipbooks": {\n${lines.join(",\n")}\n  }\n}`;
  }
  return `${text}\n`;
}

/** The slice named `name`, or undefined. */
export const findSlice = (settings: ImportSettings, name: string): SpriteSlice | undefined => settings.sprites.find((s) => s.name === name);
