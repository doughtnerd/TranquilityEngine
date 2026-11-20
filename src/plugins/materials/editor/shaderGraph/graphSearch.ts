// What find reads in a shader graph (ADR 0117): each node's title, its type, the property it reads,
// its other string settings and a Custom Function's name. The matcher, the box and notes and group
// titles are the graph layer's (`findInGraph`, `useGraphFind`, ADR 0259).
import { nodeDef } from "../../../../engine/render/shaderGraph/nodes";
import type { ShaderGraph } from "../../../../engine/scene/shaderGraph";
import type { FindItem } from "../../../../editor/sdk";
import { nodeTitle } from "./nodeLayout";

/** The shader graph's nodes as find reads them, in the graph's order. */
export function shaderFindItems(graph: ShaderGraph): FindItem[] {
  return graph.nodes.map((n) => {
    const title = nodeTitle(n);
    const fields: [string, string][] = [["title", title], ["type", `${n.type} ${nodeDef(n.type)?.title ?? ""}`]];
    if (n.settings?.property) fields.push(["property", n.settings.property]);
    for (const v of Object.values(n.settings ?? {})) if (typeof v === "string" && v) fields.push(["setting", v]);
    if (n.function?.name) fields.push(["title", n.function.name]);
    return { id: n.id, label: title, fields };
  });
}
