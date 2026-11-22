/**
 * The particle-effect compile (ADR 0315): what "the effect as the game sees it" is, in one call. It
 * takes an effect's raw JSON (the game, the warm-up, thumbnails) or an already-parsed graph (the
 * editor's open document) plus an asset resolver, and runs the whole sequence: parse (ADR 0060),
 * expand sub-graphs and custom blocks (ADR 0095), compile (`compileParticleGraph`), and collect the
 * expansion's dependencies. Renderer-neutral: the effect player adds its kernel plan on top; the
 * editor passes its own resolver. Nothing here throws (a resolver that throws reads as a missing asset).
 */
import { compileParticleGraph, type ParticleProgram } from "./particleCompile";
import type { GraphProblem, ParticleGraph } from "./particleGraph";
import { parseParticleGraph } from "./particleGraphFormat";
import { expandParticleGraph, expansionDependencies, type AssetResolver } from "./particleSubgraphs";

/** An effect to compile: its JSON (`where` names it in problems) or a graph parsed already. */
export type ParticleEffectSource = { raw: unknown; where?: string } | { graph: ParticleGraph };

export interface CompiledParticleEffect {
  /** The graph with its sub-graphs and custom blocks inlined: what `program` was compiled from. */
  graph: ParticleGraph;
  program: ParticleProgram;
  /** Every problem, each once: the parse's (raw JSON only), the expansion's, then the compiler's. */
  problems: GraphProblem[];
  /** The sub-graph and custom block assets the expansion reads, nested ones included (rebuild when one changes). */
  dependencies: string[];
}

/** Parse (when raw), expand and compile an effect with `resolve` reading its sub-graph and custom block assets. */
export function compileParticleEffect(source: ParticleEffectSource, resolve: AssetResolver): CompiledParticleEffect {
  const read: AssetResolver = (ref) => {
    try {
      return resolve(ref);
    } catch {
      return undefined;
    }
  };
  const parsed = "graph" in source ? { graph: source.graph, problems: [] } : parseParticleGraph(source.raw, source.where);
  const expanded = expandParticleGraph(parsed.graph, read);
  const program = compileParticleGraph(expanded.graph);
  const seen = new Set<string>();
  const problems = [...parsed.problems, ...expanded.problems, ...program.problems].filter((p) => {
    const key = `${p.at ?? ""}|${p.message}`;
    return !seen.has(key) && !!seen.add(key);
  });
  return { graph: expanded.graph, program, problems, dependencies: expansionDependencies(parsed.graph, read) };
}
