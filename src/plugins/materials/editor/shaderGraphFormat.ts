// The shader graph and sub-graph asset formats (ADR 0046, 0048, 0134): how a `*.shadergraph.json`
// or `*.shadersubgraph.json` file becomes a `ShaderGraph` and back, for their asset documents
// (`openAssetDocument(project, path, "shadergraph" | "shadersubgraph")`).
import { defaultShaderGraph, defaultShaderSubGraph, formatShaderGraph, parseShaderGraph, type ShaderGraph } from "../../../engine/scene/shaderGraph";
import type { AssetFormatContribution, AssetProblem } from "../../../editor/sdk/contributions";

/** Parse a graph file's JSON; never throws. A missing or unreadable file is `fallback()` with the reason as a problem. */
function parseGraph(raw: unknown, path: string, fallback: () => ShaderGraph): { value: ShaderGraph; problems: readonly AssetProblem[] } {
  try {
    const read = parseShaderGraph(raw, path);
    return { value: read.graph, problems: read.problems.map((message) => ({ message })) };
  } catch (err) {
    return { value: fallback(), problems: [{ message: (err as Error).message }] };
  }
}

export const shaderGraphFormat: AssetFormatContribution<ShaderGraph> = {
  id: "shadergraph",
  parse: (raw, path) => parseGraph(raw, path, defaultShaderGraph),
  format: formatShaderGraph,
};

export const shaderSubgraphFormat: AssetFormatContribution<ShaderGraph> = {
  id: "shadersubgraph",
  parse: (raw, path) => parseGraph(raw, path, defaultShaderSubGraph),
  format: formatShaderGraph,
};
