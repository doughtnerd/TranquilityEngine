// Which game parameters a sequence uses (proto A10, spec §4.2.9 "Parameters lists only the parameters this sequence
// uses, each with its uses"): a loop active while a parameter holds (the sequence's own loops, and each clip's loops
// with its overrides) and a curve driven by a parameter (a clip's or a track's automation). Each use is named the way
// the timeline names things ("Skid · brake_skid", "Loop 2", "Engine volume curve"). Pure.
import type { Automation, SequenceSettings } from "../../../../engine/audio/playlist/types";
import { clipLoops } from "./clipGeometry";
import type { SourceOf } from "./sequenceModel";
import { clipName } from "./TimelineClip";
import { loopName } from "./timelineOverlays";

/** Parameter name → the uses, in timeline order. */
export function parameterUses(s: SequenceSettings, sourceOf: SourceOf): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (name: string, use: string) => {
    const list = out.get(name) ?? [];
    if (!list.includes(use)) list.push(use);
    out.set(name, list);
  };
  const curves = (list: readonly Automation[], owner: string) => {
    for (const a of list) if (typeof a.input !== "string") add(a.input.parameter, `${owner} ${a.target.startsWith("fx:") ? "effect" : a.target} curve`);
  };
  for (const l of s.loops) if (l.active === "parameter" && l.binding) add(l.binding.parameter, loopName(s, l.id));
  for (const t of s.tracks) {
    curves(t.automation, t.name);
    for (const c of t.clips) {
      const where = `${t.name} · ${clipName(c)}`;
      for (const l of clipLoops(c, sourceOf(c))) if (l.active === "parameter" && l.binding) add(l.binding.parameter, where);
      curves(c.automation, where);
    }
  }
  return out;
}

/** A use chip's text and tooltip ("1 use" · "Used by Skid · brake_skid, Loop 2"; "unused"). */
export function useChip(uses: readonly string[] | undefined): { readonly text: string; readonly title: string; readonly used: boolean } {
  if (!uses?.length) return { text: "unused", title: "This sequence doesn't use it", used: false };
  return { text: uses.length === 1 ? "1 use" : `${uses.length} uses`, title: `Used by ${uses.join(", ")}`, used: true };
}
