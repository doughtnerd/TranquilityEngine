// The curve menu's clipboard (spec 2.6.3, the prototype's "Copy curves · Paste curves from X"): one set of curves at a
// time, tagged with the kind of target it came from, so pasting voice curves onto an effect's automation (or back) is
// refused. Session state; never saved.
import { signal } from "@preact/signals";

export type CurveKind = "voice" | "effect";

export interface CopiedCurves {
  readonly kind: CurveKind;
  /** Whose they were ("dirt_02"), for "Paste curves from dirt_02". */
  readonly from: string;
  readonly curves: Readonly<Record<string, unknown>>;
}

export const copiedCurves = signal<CopiedCurves | null>(null);

/** Why curves of `kind` can't be pasted now, or null when they can. */
export function pasteRefusal(kind: CurveKind): string | null {
  const c = copiedCurves.value;
  if (!c) return "Copy curves first";
  if (c.kind !== kind) return `The copied curves are ${c.kind === "voice" ? "voice" : "effect"} curves, which don't fit here`;
  return null;
}
