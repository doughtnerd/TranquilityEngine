/**
 * The lenient JSON reading the localisation formats share (languages, string tables, translations, subtitle settings):
 * a bad value falls back to its default with one problem line under `where`, a value out of range is clamped with one
 * problem line, and nothing throws (the engine's lenient parse, ADR 0306). Localisation is engine-level and imports
 * nothing from audio, so it has its own small reader beside `audio/lenientRead.ts`'s.
 *
 * Pure; no plugin, no DOM.
 */

export type JsonRecord = Record<string, unknown>;

export const isRecord = (v: unknown): v is JsonRecord => typeof v === "object" && v !== null && !Array.isArray(v);
export const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Reads values into a shared problem list. */
export class Reader {
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
      const c = Math.min(max, Math.max(min, raw));
      this.problem(where, `${raw} is outside ${min}..${max}; using ${c}.`);
      return c;
    }
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

  /** A list, or `[]` with a problem when it isn't one (absent or null: `[]`). */
  list(raw: unknown, where: string): unknown[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      this.problem(where, "must be a list; ignored.");
      return [];
    }
    return raw;
  }

  /** An object, or null with a problem when it isn't one (absent or null: null). */
  record(raw: unknown, where: string): JsonRecord | null {
    if (raw === undefined || raw === null) return null;
    if (!isRecord(raw)) {
      this.problem(where, "must be an object; ignored.");
      return null;
    }
    return raw;
  }

  /** A list of strings, at most `limit`; a non-string entry is dropped with a problem. */
  strings(raw: unknown, where: string, limit = Infinity): string[] {
    const out: string[] = [];
    this.list(raw, where).forEach((v, i) => {
      if (typeof v !== "string") return void this.problem(`${where}[${i}]`, "must be a string; dropped.");
      if (out.length >= limit) return void this.problem(`${where}[${i}]`, `at most ${limit}; dropped.`);
      out.push(v);
    });
    return out;
  }
}
