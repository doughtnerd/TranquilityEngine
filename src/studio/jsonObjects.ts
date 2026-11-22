// Walking a parsed JSON value's objects for project-wide renames (ADR 0262, 0302): `mapObjects` maps every object depth
// first through a function and keeps identity wherever nothing changed, so a caller can tell an untouched file by `===`.
// Pure.

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `value` with every object in it (depth first, children before their parent) mapped through `fn`. */
export function mapObjects(value: unknown, fn: (o: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    const next = value.map((v) => mapObjects(v, fn));
    return next.some((v, i) => v !== value[i]) ? next : value;
  }
  if (!isRecord(value)) return value;
  let out = value;
  for (const [k, v] of Object.entries(value)) {
    const nv = mapObjects(v, fn);
    if (nv !== v) {
      if (out === value) out = { ...value };
      out[k] = nv;
    }
  }
  return fn(out);
}
