// The Particles plugin's asset formats (ADR 0057, 0060, 0095, 0126, 0134): how a particle effect
// (`*.particles.json`), a particle sub-graph (`*.particlesubgraph.json`) or a custom block
// (`*.particleblock.json`) becomes the `ParticleGraph` the Particle Graph edits, and back, for their
// asset documents (`openAssetDocument(project, path, "particles" | "particlesubgraph" | "particleblock")`).
// A sub-graph or block reads as a document with Input, Output and block pseudo-nodes (`particleGraph/assetDocs.ts`).
// Files in the old `myco.particles@1` format read as migrated graphs and are written as graphs on the first edit.
import type { GraphProblem, ParticleGraph } from "../../../engine/scene/particleGraph";
import { defaultParticleGraph, formatParticleGraph, parseParticleGraph } from "../../../engine/scene/particleGraphFormat";
import type { AssetFormatContribution } from "../../../editor/sdk";
import { assetToDoc, docToAsset, formatAsset, type AssetDocKind } from "./particleGraph/assetDocs";

/** What parsing found: the graph, its problems (`GraphProblem`s, which say where), and whether the file is in the old format. */
export interface ParsedEffect {
  graph: ParticleGraph;
  problems: GraphProblem[];
  migrated: boolean;
}

/** Parse an effect file's JSON; never throws. An unreadable one is the default graph with the reason as a problem. */
export function parseEffect(raw: unknown, path: string): ParsedEffect {
  try {
    return parseParticleGraph(raw, path);
  } catch (err) {
    return { graph: defaultParticleGraph(), problems: [{ severity: "error", message: (err as Error).message }], migrated: false };
  }
}

/** Parse a sub-graph or block asset's JSON as a document; never throws. */
export function parseAssetDoc(raw: unknown, kind: AssetDocKind): ParsedEffect {
  try {
    return { ...assetToDoc(raw, kind), migrated: false };
  } catch (err) {
    return { graph: defaultParticleGraph(), problems: [{ severity: "error", message: (err as Error).message }], migrated: false };
  }
}

const formatAssetDoc = (graph: ParticleGraph): string => formatAsset(docToAsset(graph));

export const particlesFormat: AssetFormatContribution<ParticleGraph> = {
  id: "particles",
  parse: (raw, path) => {
    const read = parseEffect(raw, path);
    return { value: read.graph, problems: read.problems };
  },
  format: formatParticleGraph,
};

export const particleSubgraphFormat: AssetFormatContribution<ParticleGraph> = {
  id: "particlesubgraph",
  parse: (raw) => {
    const read = parseAssetDoc(raw, "subgraph");
    return { value: read.graph, problems: read.problems };
  },
  format: formatAssetDoc,
};

export const particleBlockFormat: AssetFormatContribution<ParticleGraph> = {
  id: "particleblock",
  parse: (raw) => {
    const read = parseAssetDoc(raw, "block");
    return { value: read.graph, problems: read.problems };
  },
  format: formatAssetDoc,
};
