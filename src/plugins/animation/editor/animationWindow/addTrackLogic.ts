// The Animation window's Add Property list (ADR 0373: "add/remove tracks from animatable fields"): every animatable field
// of the nodes under the bound Animator (sub-paths included, D86) that the clip doesn't animate yet, grouped by node.
// The window lists the nodes and their components; this module decides what is offered.
//
// Pure; no DOM.
import type { AnimSource } from "../../../../engine/animation/animSource";
import { fieldPathValue } from "../../../../engine/animation/bindingPath";
import type { Binding } from "../../../../engine/animation/tracks";
import { findTrack } from "./clipEditLogic";
import { animatedPaths } from "./fieldTracksLogic";

/** A node under the Animator, as the list reads it. */
export interface NodeFields {
  /** Relative to the Animator's node ("" for it). */
  readonly path: string;
  readonly components: readonly { readonly type: string; readonly fields: readonly { readonly name: string; readonly value?: unknown }[] }[];
}

/** One field that can get a track. */
export interface PropertyChoice {
  readonly binding: Binding;
  /** "Body/Lamp › Light.intensity". */
  readonly label: string;
  /** Its value now (a sub-path's kind comes from it). */
  readonly value: unknown;
}

const title = (type: string) => type.replace(/^[^.]*\./, "");

/** The fields of `nodes` that can get a track in `clip`, in node, component and field order. */
export function propertyChoices(clip: AnimSource, nodes: readonly NodeFields[], rootName = "Self"): PropertyChoice[] {
  const out: PropertyChoice[] = [];
  for (const node of nodes) {
    for (const c of node.components) {
      for (const f of c.fields) {
        for (const path of animatedPaths(c.type, f.name)) {
          const binding = { nodePath: node.path, component: c.type, field: path };
          if (findTrack(clip, binding) >= 0) continue;
          out.push({ binding, label: `${node.path || rootName} › ${title(c.type)}.${path}`, value: fieldPathValue(f.value, path) });
        }
      }
    }
  }
  return out;
}
