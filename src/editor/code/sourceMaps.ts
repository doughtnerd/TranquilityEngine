// Reading a source map (version 3) back: which original position a generated one came from. Used to map type errors
// in a Svelte component's generated TypeScript back to the component (ADR 0432, `svelteCheck.ts`). Generic: one map,
// one source, no names.

/** A source map's `mappings` decoded: per generated line, its segments as [generated column, original line, original column], 0-based. */
export type DecodedMappings = readonly (readonly (readonly [number, number, number])[])[];

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT = new Map([...BASE64].map((c, i) => [c, i]));

/**
 * Decode a source map's `mappings` (base64 VLQ). Segments without an original position (one field) are left out; the
 * segments of a line are sorted by generated column.
 */
export function decodeMappings(mappings: string): DecodedMappings {
  const lines: [number, number, number][][] = [];
  let line: [number, number, number][] = [];
  let sourceLine = 0;
  let sourceColumn = 0;
  let i = 0;
  const vlq = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const digit = DIGIT.get(mappings[i++]);
      if (digit === undefined) throw new Error(`Bad source map mappings at ${i - 1}.`);
      value += (digit & 31) << shift;
      if ((digit & 32) === 0) break;
      shift += 5;
    }
    return value & 1 ? -(value >>> 1) : value >>> 1;
  };
  while (i <= mappings.length) {
    let column = 0;
    line = [];
    while (i < mappings.length && mappings[i] !== ";") {
      if (mappings[i] === ",") {
        i++;
        continue;
      }
      column += vlq();
      const fields = [column];
      while (i < mappings.length && mappings[i] !== "," && mappings[i] !== ";") fields.push(vlq());
      if (fields.length >= 4) {
        // fields[1] is the source's index (one source here)
        sourceLine += fields[2];
        sourceColumn += fields[3];
        line.push([column, sourceLine, sourceColumn]);
      }
    }
    lines.push(line.sort((a, b) => a[0] - b[0]));
    i++; // past the ";"
  }
  return lines;
}

/**
 * The original position of generated `line`, `column` (0-based): the segment at or before it on that line (the
 * greatest lower bound, as source map readers look up), or null when the line has none there.
 */
export function originalPosition(mappings: DecodedMappings, line: number, column: number): { line: number; column: number } | null {
  const segments = mappings[line];
  if (!segments) return null;
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid][0] <= column) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? null : { line: segments[found][1], column: segments[found][2] };
}
