// What the Mixer's routing rows and strips say beside each bus (the prototype's Buses panel, spec §4.3.3): its colour
// (its own, else its top-level branch's; Master, returns and VCAs have fixed ones), the meta on the right of its tree
// cell ("fx 1 · auto 2", "+5 inside" when folded, "← 3 sends" on a return, "3 buses" on a VCA), the kind line of a
// strip ("Output", "Bus · in SFX", "Return"), and who uses it (the playlists routed straight to it and through the
// buses inside it). Pure.
import type { AudioProject } from "../../../engine/audio/project/types";
import { ancestorsOf, busOf, descendantsOf, kindOf, masterOf } from "./busTree";

/** The branch colours in order of the top-level buses (the prototype's cycle). */
export const BRANCH_COLOURS: readonly string[] = ["var(--accent)", "var(--accent2)", "var(--warning)", "var(--badge-text)", "var(--link)", "var(--danger)"];
/** Master's colour (the output). */
export const MASTER_COLOUR = "var(--text)";
/** A return's (fed by sends; not in any branch). */
export const RETURN_COLOUR = "var(--border-strong)";
/** A VCA's (violet is kept for VCAs and automation values). */
export const VCA_COLOUR = "var(--series-6)";

/** The colour of the mix item `name`: a bus's own, else the nearest own colour above it, else its branch's. */
export function busColour(p: Pick<AudioProject, "buses" | "returns" | "vcas">, name: string): string {
  const kind = kindOf(p, name);
  if (kind === "return") return RETURN_COLOUR;
  if (kind === "vca") return VCA_COLOUR;
  const master = masterOf(p);
  if (name === master) return busOf(p, name)?.colour ?? MASTER_COLOUR;
  const chain = [name, ...ancestorsOf(p, name)].filter((n) => n !== master);
  const own = chain.map((n) => busOf(p, n)?.colour).find((c) => c !== undefined);
  if (own) return own;
  const top = chain[chain.length - 1];
  const branches = p.buses.filter((b) => b.parent === master).map((b) => b.name);
  const i = top === undefined ? -1 : branches.indexOf(top);
  return i < 0 ? MASTER_COLOUR : BRANCH_COLOURS[i % BRANCH_COLOURS.length]!;
}

/** The default colour of bus `name` if it had none of its own (what "Reset" goes back to). */
export function defaultBusColour(p: Pick<AudioProject, "buses" | "returns" | "vcas">, name: string): string {
  return busColour({ ...p, buses: p.buses.map((b) => (b.name === name ? { ...b, colour: undefined } : b)) }, name);
}

/** Bus `name` with its own colour (null: back to its branch's) ("Bus colour"). */
export function setBusColour(p: AudioProject, name: string, colour: string | null): { next: AudioProject } | { refused: string } {
  const bus = busOf(p, name);
  if (!bus) return { refused: `there's no bus "${name}"` };
  return {
    next: {
      ...p,
      buses: p.buses.map((b) => {
        if (b.name !== name) return b;
        const { colour: _old, ...rest } = b;
        return colour === null ? rest : { ...rest, colour };
      }),
    },
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The meta at the right of a row's tree cell, and its tooltip. */
export function rowMeta(p: AudioProject, name: string, folded = false): { text: string; title: string } {
  const kind = kindOf(p, name);
  if (kind === "vca") {
    const v = p.vcas.find((x) => x.name === name)!;
    return { text: v.members.length === 0 ? "no buses" : plural(v.members.length, "bus", "buses"), title: v.members.length === 0 ? "No member buses yet: pick them in the Inspector" : `Offsets ${v.members.join(", ")} and every bus inside them` };
  }
  if (kind === "return") {
    const feeders = p.buses.filter((b) => b.sends.some((s) => s.to === name)).map((b) => b.name);
    const fx = p.returns.find((r) => r.name === name)?.effects.length ?? 0;
    const sends = feeders.length === 0 ? "no sends" : `← ${plural(feeders.length, "send")}`;
    return { text: [fx > 0 ? `fx ${fx}` : "", sends].filter(Boolean).join(" · "), title: feeders.length === 0 ? "Nothing sends to it yet: add a send in a bus's Inspector" : `Fed by sends from ${feeders.join(", ")}` };
  }
  const bus = busOf(p, name);
  if (!bus) return { text: "", title: "" };
  const fx = bus.effects.length;
  const auto = p.automation.filter((a) => a.on === name).length;
  const parts = [fx > 0 ? `fx ${fx}` : "", auto > 0 ? `auto ${auto}` : ""];
  const titles = [fx > 0 ? plural(fx, "effect") : "", auto > 0 ? `${plural(auto, "automation lane")}` : ""];
  if (folded) {
    const inside = descendantsOf(p, name).length;
    if (inside > 0) {
      parts.push(`+${inside} inside`);
      titles.push(`${plural(inside, "bus", "buses")} folded inside`);
    }
  }
  return { text: parts.filter(Boolean).join(" · "), title: titles.filter(Boolean).join(" · ") };
}

/** A strip's kind line: "Output" (Master), "Bus · to Master", "Bus · in SFX", "Return", "VCA". */
export function stripKind(p: Pick<AudioProject, "buses" | "returns" | "vcas">, name: string): string {
  const kind = kindOf(p, name);
  if (kind === "return") return "Return";
  if (kind === "vca") return "VCA";
  const bus = busOf(p, name);
  if (!bus || bus.parent === null) return "Output";
  return bus.parent === masterOf(p) ? `Bus · to ${bus.parent}` : `Bus · in ${bus.parent}`;
}

/** The Inspector's kind badge: "Output" (Master), "Bus", "Return", "VCA". */
export function kindBadge(p: Pick<AudioProject, "buses" | "returns" | "vcas">, name: string): string {
  const kind = kindOf(p, name);
  if (kind === "return") return "Return";
  if (kind === "vca") return "VCA";
  return name === masterOf(p) ? "Output" : "Bus";
}

/** Who plays through `name` (spec §4.3.4 "Used by"): the files routed straight to it, and those routed to buses inside it. */
export interface UsedBy {
  readonly direct: readonly string[];
  /** Files routed to a bus inside it (not to it). */
  readonly inside: number;
}

/** "Used by" from `usersOf` (the files naming a bus), keeping the playlists (`isPlaylist`). */
export function usedBy(p: Pick<AudioProject, "buses">, name: string, usersOf: (bus: string) => readonly string[], isPlaylist: (path: string) => boolean): UsedBy {
  const direct = usersOf(name).filter(isPlaylist);
  const inside = new Set<string>();
  for (const d of descendantsOf(p, name)) for (const f of usersOf(d)) if (isPlaylist(f) && !direct.includes(f)) inside.add(f);
  return { direct: [...direct].sort((a, b) => a.localeCompare(b)), inside: inside.size };
}

/** The toolbar's words while bus `bus` is dragged over `over` (null: off any bus), and whether the drop is refused. */
export function dragHint(bus: string, over: string | null, refusal: string | null): { text: string; refused: boolean } {
  if (over === null || over === bus) return { text: `Drop on a bus to route ${bus} into it`, refused: false };
  if (refusal) return { text: `Can't route ${bus} there: ${refusal}`, refused: true };
  return { text: `Drop: route ${bus} into ${over}`, refused: false };
}

/** A playlist path as the Used by list names it ("audio/music/Theme.playlist.json" → "Theme"). */
export const playlistName = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.playlist\.json$/, "");
