// Where the Worlds panel's node graph draws each World (ADR 0382). Positions are the editor's own data,
// kept in the project folder's `.myco/worlds-graph.json`, never in project.json's `bootstrap` (the runtime
// format, ADR 0032): a World nobody has dragged has no entry and is placed by the auto layout
// (`worldsLayout.ts`). Entries are keyed by what names a node across edits: a start-up World by its
// name, a Spawnable World by its template key (`world:Client`, `template:Server`).
//
// Reads are lenient (ADR 0306): a missing, unreadable or malformed file reads as "no positions", and
// a malformed entry is skipped; reads never throw.
import type { FileSystem } from "../engine/platform/FileSystem";
import { joinPath } from "./projectPaths";

export const WORLDS_GRAPH_PATH = ".myco/worlds-graph.json";
export const WORLDS_GRAPH_FORMAT = "myco.worldsGraph@1";

/** A node's top-left corner, in graph units. */
export type NodePosition = readonly [number, number];
export type NodePositions = ReadonlyMap<string, NodePosition>;
export type WorldNodeKind = "world" | "template";

/** The key a node's position is stored under: a start-up World by name, a Spawnable World by template key. */
export const positionKey = (kind: WorldNodeKind, name: string): string => `${kind}:${name}`;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The positions in a worlds-graph file's text: none when it isn't one, skipping malformed entries. */
export function parseWorldsGraph(text: string): NodePositions {
  const out = new Map<string, NodePosition>();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object" || (raw as { format?: unknown }).format !== WORLDS_GRAPH_FORMAT) return out;
  const positions = (raw as { positions?: unknown }).positions;
  if (!positions || typeof positions !== "object" || Array.isArray(positions)) return out;
  for (const [key, value] of Object.entries(positions)) {
    if (Array.isArray(value) && value.length === 2 && finite(value[0]) && finite(value[1])) out.set(key, [value[0], value[1]]);
  }
  return out;
}

const round = (v: number) => Math.round(v * 10) / 10;

/** A worlds-graph file's text: keys sorted, coordinates to a tenth, ending in a newline. */
export function serializeWorldsGraph(positions: NodePositions): string {
  const sorted = [...positions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const body = sorted.map(([key, [x, y]]) => `    ${JSON.stringify(key)}: [${round(x)}, ${round(y)}]`).join(",\n");
  return `{\n  "format": ${JSON.stringify(WORLDS_GRAPH_FORMAT)},\n  "positions": {${body ? `\n${body}\n  ` : ""}}\n}\n`;
}

/** `positions` with `moved` set, keeping only the keys in `keep` (the nodes the graph has now), so removed Worlds don't linger. */
export function placeNodes(positions: NodePositions, moved: Iterable<readonly [string, NodePosition]>, keep: Iterable<string>): NodePositions {
  const live = new Set(keep);
  const out = new Map([...positions].filter(([key]) => live.has(key)));
  for (const [key, at] of moved) if (live.has(key)) out.set(key, [at[0], at[1]]);
  return out;
}

/** `positions` with a renamed node's entry moved to its new name (unchanged when it had none). */
export function renameNode(positions: NodePositions, kind: WorldNodeKind, from: string, to: string): NodePositions {
  const old = positionKey(kind, from), next = positionKey(kind, to);
  const at = positions.get(old);
  if (!at || old === next) return positions;
  const out = new Map(positions);
  out.delete(old);
  out.set(next, at);
  return out;
}

/** A project folder the positions file lives in (an `EditorProject` is one). */
export interface WorldsGraphFolder {
  readonly root: string | null;
  readonly fileSystem: FileSystem | null;
}

/** The project's stored positions; none when it has no folder or no readable file. */
export async function readWorldsGraph(folder: WorldsGraphFolder): Promise<NodePositions> {
  const { root, fileSystem: fs } = folder;
  if (!root || !fs) return new Map();
  try {
    const path = joinPath(root, WORLDS_GRAPH_PATH);
    if (!(await fs.exists(path))) return new Map();
    return parseWorldsGraph(await fs.readText(path));
  } catch {
    return new Map();
  }
}

/** Write the project's positions to `.myco/worlds-graph.json` (nothing when it has no folder). */
export async function writeWorldsGraph(folder: WorldsGraphFolder, positions: NodePositions): Promise<void> {
  const { root, fileSystem: fs } = folder;
  if (!root || !fs) return;
  const dir = joinPath(root, ".myco");
  if (!(await fs.exists(dir))) await fs.mkdir(dir);
  await fs.writeText(joinPath(root, WORLDS_GRAPH_PATH), serializeWorldsGraph(positions));
}
