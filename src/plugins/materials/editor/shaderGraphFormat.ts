// The shader graph and sub-graph asset formats (ADR 0046, 0048, 0134, 0233): how a `*.shadergraph.json` or
// `*.shadersubgraph.json` file becomes a `ShaderGraph` and back, the kinds' `format`. A file the engine can't read
// is the kind's `empty()` (the asset kind host's rule).
import { defaultShaderGraph, defaultShaderSubGraph, formatShaderGraph, parseShaderGraph, type ShaderGraph } from "../../../engine/scene/shaderGraph";
import type { AssetFormat } from "../../../editor/sdk";

/** A graph format whose empty (and new) graph is `empty()`. */
const graphFormat = (empty: () => ShaderGraph): AssetFormat<ShaderGraph> => ({
  parse(raw, path) {
    const read = parseShaderGraph(raw, path);
    return { value: read.graph, problems: read.problems.map((message) => ({ message })) };
  },
  format: formatShaderGraph,
  empty,
});

export const shaderGraphFormat = graphFormat(defaultShaderGraph);
export const shaderSubgraphFormat = graphFormat(defaultShaderSubGraph);
