/**
 * Materials as scripts see them (ADR 0107): a material asset plus runtime values and keywords, with no
 * render-backend types. `Material.shared(path)` is the one Material per asset: changing it changes every
 * renderer drawing that asset. An instance (`renderer.materialInstance`, `clone()`, `new Material(path)`)
 * is an independent copy. The render backend reads `_values`, `_keywords` and `_version`.
 *
 * ```ts
 * Material.shared("asset:materials/glow.material.json").setColor("emission", Color.from("#ff8800"));
 * const mine = renderer.materialInstance;   // this renderer only
 * mine.setFloat("roughness", 0.2);
 * mine.setKeyword("RIM", true);             // shader graphs and shader assets (ADR 0106)
 * ```
 *
 * Names are the material's properties: a shader graph's or shader asset's property names, or for the
 * built-in lit, unlit and physical materials `color`, `emission`, `metalness`, `roughness`, `texture`
 * and the physical fields (`clearcoat`, `sheen`, `transmission`…). A value a Material doesn't set reads
 * the asset's. Runtime only: never saved, never replicated.
 */
import { Color, Vector2, Vector3 } from "../core/math";
import { normalizeAssetPath } from "../scene/Assets";
import type { KeywordValue } from "../scene/shaderKeywords";

/** A material value: a number, vector, colour, 2–4 numbers, or a texture's asset path. */
export type MaterialValue = number | Vector2 | Vector3 | Color | readonly number[] | string;

const shared = new Map<string, Material>();

const copyValue = (v: MaterialValue): MaterialValue => (v instanceof Color || v instanceof Vector2 || v instanceof Vector3 ? v.clone() : Array.isArray(v) ? [...v] : v);

export class Material {
  /** The material asset it reads its defaults from (`asset:materials/wood.material.json`); "" is the default lit material. */
  readonly asset: string;
  /** False for the shared Material of an asset, true for copies. */
  readonly isInstance: boolean;
  private readonly values = new Map<string, MaterialValue>();
  private readonly keywordValues = new Map<string, KeywordValue>();
  /** @internal Bumped on every change, so the render backend applies it. */
  _version = 0;

  /** A new instance of a material asset ("" for the default lit material), with no values of its own. */
  constructor(asset: string) {
    this.asset = asset;
    this.isInstance = true;
  }

  /** The shared Material of a material asset: one per asset for the Engine. */
  static shared(asset: string): Material {
    const key = normalizeAssetPath(asset);
    let m = shared.get(key);
    if (!m) {
      m = new Material(asset);
      (m as { isInstance: boolean }).isInstance = false;
      shared.set(key, m);
    }
    return m;
  }

  /** @internal The shared Material of an asset if one was made, without making it (the renderer asks every frame). */
  static _sharedIfAny(asset: string): Material | undefined {
    return shared.get(normalizeAssetPath(asset));
  }

  /** @internal Forget every shared Material's values (the editor leaving play mode, tests). */
  static _resetShared(): void {
    for (const m of shared.values()) {
      if (m.values.size || m.keywordValues.size) m._version++;
      m.values.clear();
      m.keywordValues.clear();
    }
  }

  /** An independent instance with the same asset, values and keywords. */
  clone(): Material {
    const m = new Material(this.asset);
    for (const [k, v] of this.values) m.values.set(k, copyValue(v));
    for (const [k, v] of this.keywordValues) m.keywordValues.set(k, v);
    return m;
  }

  setColor(name: string, color: Color): void {
    this.set(name, color);
  }
  setFloat(name: string, value: number): void {
    this.set(name, value);
  }
  /** A vector property: a `Vector2`, `Vector3`, or 2–4 numbers (a vector4). */
  setVector(name: string, value: Vector2 | Vector3 | readonly number[]): void {
    this.set(name, value);
  }
  /** A texture property: an image's asset path ("" for none). */
  setTexture(name: string, path: string): void {
    this.set(name, path);
  }

  /** The colour this Material sets for `name`, or undefined when it reads the asset's. */
  getColor(name: string): Color | undefined {
    const v = this.values.get(name);
    return v instanceof Color ? v.clone() : undefined;
  }
  getFloat(name: string): number | undefined {
    const v = this.values.get(name);
    return typeof v === "number" ? v : undefined;
  }
  getVector(name: string): Vector2 | Vector3 | readonly number[] | undefined {
    const v = this.values.get(name);
    return v instanceof Vector2 || v instanceof Vector3 ? v.clone() : Array.isArray(v) ? [...v] : undefined;
  }
  getTexture(name: string): string | undefined {
    const v = this.values.get(name);
    return typeof v === "string" ? v : undefined;
  }

  /** Whether this Material sets `name` itself. */
  hasOverride(name: string): boolean {
    return this.values.has(name);
  }

  /** Go back to the asset's value for `name`. */
  clear(name: string): void {
    if (this.values.delete(name)) this._version++;
  }

  /** Go back to the asset's values and keywords. */
  clearAll(): void {
    if (!this.values.size && !this.keywordValues.size) return;
    this.values.clear();
    this.keywordValues.clear();
    this._version++;
  }

  /**
   * Set a keyword (ADR 0106): `true`/`false` for an on/off keyword, a value's name for an enum keyword.
   * Each combination is its own shader variant; mark keywords scripts switch with `"variants": "all"` so
   * warm-up compiles them before they're needed.
   */
  setKeyword(name: string, value: KeywordValue): void {
    if (this.keywordValues.get(name) === value) return;
    this.keywordValues.set(name, value);
    this._version++;
  }

  /** The keyword's value this Material sets, or undefined when it reads the asset's. */
  getKeyword(name: string): KeywordValue | undefined {
    return this.keywordValues.get(name);
  }

  /** Whether this Material switches an on/off keyword on. */
  isKeywordEnabled(name: string): boolean {
    return this.keywordValues.get(name) === true;
  }

  /** Go back to the asset's value for a keyword. */
  clearKeyword(name: string): void {
    if (this.keywordValues.delete(name)) this._version++;
  }

  /** @internal The values it sets, by name. */
  get _values(): ReadonlyMap<string, MaterialValue> {
    return this.values;
  }

  /** @internal The keywords it sets, by name. */
  get _keywords(): ReadonlyMap<string, KeywordValue> {
    return this.keywordValues;
  }

  /** @internal Whether it sets anything (a shared Material that sets nothing draws the asset as it is). */
  get _empty(): boolean {
    return this.values.size === 0 && this.keywordValues.size === 0;
  }

  private set(name: string, value: MaterialValue): void {
    this.values.set(name, copyValue(value));
    this._version++;
  }
}
