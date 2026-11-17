// The Particles plugin's asset formats (ADR 0057, 0060, 0095, 0126, 0134, 0233): how a particle effect
// (`*.particles.json`), a particle sub-graph (`*.particlesubgraph.json`) or a custom block
// (`*.particleblock.json`) becomes the `ParticleGraph` the Particle Graph edits, and back: each kind's `format`.
// A sub-graph or block reads as a document with Input, Output and block pseudo-nodes (`particleGraph/assetDocs.ts`).
// Files in the old `myco.particles@1` format read as migrated graphs and are written as graphs on the first edit.
// A file that can't be read at all is the kind's `empty()` (the asset kind host's rule, ADR 0233).
import type { ParticleGraph } from "../../../engine/scene/particleGraph";
import { defaultParticleGraph, formatParticleGraph, parseParticleGraph } from "../../../engine/scene/particleGraphFormat";
import type { AssetFormat } from "../../../editor/sdk";
import { assetToDoc, blockTemplate, docToAsset, formatAsset, subgraphTemplate, type AssetDocKind } from "./particleGraph/assetDocs";

/** The `particles` kind's format; a new effect is the Simple Loop template. */
export const particlesFormat: AssetFormat<ParticleGraph> = {
  parse: (raw, path) => {
    const read = parseParticleGraph(raw, path);
    return { value: read.graph, problems: read.problems };
  },
  format: formatParticleGraph,
  empty: defaultParticleGraph,
};

/** The format of sub-graph or block assets, read as documents; `template` is a new file's asset JSON. */
function assetDocFormat(kind: AssetDocKind, template: () => Record<string, unknown>): AssetFormat<ParticleGraph> {
  return {
    parse: (raw) => {
      const read = assetToDoc(raw, kind);
      return { value: read.graph, problems: read.problems };
    },
    format: (graph) => formatAsset(docToAsset(graph)),
    empty: () => assetToDoc(template(), kind).graph,
  };
}

/** The `particlesubgraph` kind's format; a new sub-graph wires one number input to one number output. */
export const particleSubgraphFormat = assetDocFormat("subgraph", subgraphTemplate);
/** The `particleblock` kind's format; a new block is one input driving a Set Size block. */
export const particleBlockFormat = assetDocFormat("block", blockTemplate);
