/**
 * The lenient JSON reading the Audio Studio formats share (effects, attenuation, playlists, samples): a bad value falls
 * back to its default with one problem line under `where`, a value out of range is clamped with one problem line, and
 * nothing throws (the engine's lenient parse, ADR 0306). It sits at the top of `audio/` because every format folder
 * (effects, attenuation, playlist, sample, project) reads with it and none of them owns it.
 *
 * Pure; no plugin, no DOM.
 */
import { parseCurve, type Curve } from "../core/curve";

/** At most this many keys in one curve of the new audio formats (ADR 0329 "keys per curve ≤ 64"; declared once here). */
export const CURVE_KEY_LIMIT = 64;

export type JsonRecord = Record<string, unknown>;

export const isRecord = (v: unknown): v is JsonRecord => typeof v === "object" && v !== null && !Array.isArray(v);
export const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Reads values into a shared problem list. */
export class LenientReader {
  constructor(readonly problems: string[]) {}

  problem(where: string, message: string): void {
    this.problems.push(`${where}: ${message}`);
  }

  /** A finite number in `min..max` (clamped with a problem); absent gives `fallback` silently. */
  num(raw: unknown, where: string, fallback: number, min = -Infinity, max = Infinity): number {
    if (raw === undefined) return fallback;
    if (!isFiniteNumber(raw)) {
      this.problem(where, `must be a number; using ${fallback}.`);
      return fallback;
    }
    if (raw < min || raw > max) {
      const c = Math.min(max, Math.max(min, raw)) + 0;
      this.problem(where, `${raw} is outside ${min}..${max}; using ${c}.`);
      return c;
    }
    // `+ 0` turns -0 into 0, so a value the writer leaves out as "0" reads back the same.
    return raw + 0;
  }

  /** A whole number in `min..max`; a fraction is rounded with a problem. */
  int(raw: unknown, where: string, fallback: number, min = -Infinity, max = Infinity): number {
    const n = this.num(raw, where, fallback, min, max);
    if (Number.isInteger(n)) return n;
    const r = Math.min(max, Math.max(min, Math.round(n)));
    this.problem(where, `must be a whole number; using ${r}.`);
    return r;
  }

  bool(raw: unknown, where: string, fallback: boolean): boolean {
    if (raw === undefined) return fallback;
    if (typeof raw !== "boolean") {
      this.problem(where, `must be true or false; using ${fallback}.`);
      return fallback;
    }
    return raw;
  }

  str(raw: unknown, where: string, fallback: string): string {
    if (raw === undefined) return fallback;
    if (typeof raw !== "string") {
      this.problem(where, `must be a string; using "${fallback}".`);
      return fallback;
    }
    return raw;
  }

  /** A string or null (absent gives `fallback`). */
  strOrNull(raw: unknown, where: string, fallback: string | null): string | null {
    if (raw === undefined) return fallback;
    if (raw === null) return null;
    if (typeof raw !== "string") {
      this.problem(where, `must be a string or null; using ${JSON.stringify(fallback)}.`);
      return fallback;
    }
    return raw;
  }

  /** An optional string: absent stays absent; a non-string is dropped with a problem. */
  optStr(raw: unknown, where: string): string | undefined {
    if (raw === undefined) return undefined;
    if (typeof raw !== "string") {
      this.problem(where, "must be a string; dropped.");
      return undefined;
    }
    return raw;
  }

  pick<T extends string>(raw: unknown, where: string, options: readonly T[], fallback: T): T {
    if (raw === undefined) return fallback;
    if (typeof raw === "string" && (options as readonly string[]).includes(raw)) return raw as T;
    this.problem(where, `must be one of ${options.join(", ")}; using "${fallback}".`);
    return fallback;
  }

  /** `[lo, hi]` finite numbers in `min..max` with lo <= hi (swapped with a problem); absent gives `fallback`. */
  pair(raw: unknown, where: string, fallback: [number, number], min = -Infinity, max = Infinity): [number, number] {
    if (raw === undefined) return [fallback[0], fallback[1]];
    if (!Array.isArray(raw) || raw.length !== 2 || !isFiniteNumber(raw[0]) || !isFiniteNumber(raw[1])) {
      this.problem(where, `must be [low, high] numbers; using [${fallback.join(", ")}].`);
      return [fallback[0], fallback[1]];
    }
    let lo = this.num(raw[0], `${where}[0]`, fallback[0], min, max);
    let hi = this.num(raw[1], `${where}[1]`, fallback[1], min, max);
    if (lo > hi) {
      this.problem(where, "low was above high; swapped.");
      [lo, hi] = [hi, lo];
    }
    return [lo, hi];
  }

  /** A list, or `[]` with a problem when it isn't one (absent: `[]`). */
  list(raw: unknown, where: string): unknown[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      this.problem(where, "must be a list; ignored.");
      return [];
    }
    return raw;
  }

  /** An object, or null with a problem when it isn't one (absent: null). */
  record(raw: unknown, where: string): JsonRecord | null {
    if (raw === undefined || raw === null) return null;
    if (!isRecord(raw)) {
      this.problem(where, "must be an object; ignored.");
      return null;
    }
    return raw;
  }

  /** An engine curve (`parseCurve`) of at most `CURVE_KEY_LIMIT` keys; null when it isn't a list. */
  curve(raw: unknown, where: string): Curve | null {
    const keys = parseCurve(raw, where, this.problems);
    if (!keys) return null;
    if (keys.length > CURVE_KEY_LIMIT) {
      this.problem(where, `at most ${CURVE_KEY_LIMIT} keys; the rest are dropped.`);
      keys.length = CURVE_KEY_LIMIT;
    }
    return keys;
  }
}

/** A curve as JSON: the engine curve's own writer (one writer for every key form, Bézier included). */
export { curveToJson } from "../core/curve";

/**
 * Hands out ids unique within one scope: `take(raw, where, prefix)` keeps a valid unused id and otherwise makes a fresh
 * one (`prefix1`, `prefix2`, …) with a problem.
 */
export class IdScope {
  private readonly used = new Set<string>();
  constructor(private readonly r: LenientReader) {}

  has(id: string): boolean {
    return this.used.has(id);
  }

  fresh(prefix: string): string {
    let n = 1;
    while (this.used.has(`${prefix}${n}`)) n++;
    const id = `${prefix}${n}`;
    this.used.add(id);
    return id;
  }

  take(raw: unknown, where: string, prefix: string): string {
    if (typeof raw === "string" && raw !== "" && !this.used.has(raw)) {
      this.used.add(raw);
      return raw;
    }
    const id = this.fresh(prefix);
    if (raw === undefined) this.r.problem(where, `has no id; using "${id}".`);
    else if (typeof raw === "string" && raw !== "") this.r.problem(where, `id "${raw}" is used twice; using "${id}".`);
    else this.r.problem(where, `id must be a non-empty string; using "${id}".`);
    return id;
  }
}
