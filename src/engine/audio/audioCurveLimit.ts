/**
 * The audio formats' curve limit (ADR 0158 §3, raised by ADR 0346): declared once, here, and applied by every audio
 * parse that reads an automation curve (events, music, and through `eventFormat.ts` the mix). It is the core's curve
 * table (`automation.rs` `CURVE_KEYS`). A module of its own so `musicFormat.ts` and `eventFormat.ts`, which import each
 * other, both read it without an import cycle at load.
 */
import { parseCurve, type Curve } from "../core/curve";

/** At most this many keys per automation curve (the core's curve table; 64 since ADR 0346, 32 before). */
export const MAX_CURVE_KEYS = 64;

/** An automation curve: `parseCurve`, capped at `MAX_CURVE_KEYS` keys. `null` when it has no keys. */
export function audioCurve(raw: unknown, where: string, problems: string[]): Curve | null {
  const curve = parseCurve(raw, where, problems);
  if (!curve || curve.length === 0) return null;
  if (curve.length > MAX_CURVE_KEYS) {
    problems.push(`${where}: at most ${MAX_CURVE_KEYS} keys; the rest are dropped.`);
    curve.length = MAX_CURVE_KEYS;
  }
  return curve;
}
