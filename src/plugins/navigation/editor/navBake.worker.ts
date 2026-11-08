// The editor's navigation bake worker (ADR 0065): bakes chunks off the main thread so the editor stays
// responsive. It loads the navigation WebAssembly module once and, through `bakeChunk`, keeps one baker
// per chunk, so a rebake in the same session reuses the tiles whose inputs didn't change.
//
// Messages in: `{ id, type: "bake", request }` (see navBake.ts `NavBakeRequest`; the mesh arrays are
// transferred), `{ id, type: "release", scenePath?, chunkNodeId? }`. Messages out: `{ id, type: "stage",
// stage }`, `{ id, type: "done", result }` (the bytes transferred), `{ id, type: "error", message }`.
import { bakeChunk, releaseBakeCaches } from "../../../engine/nav/bake";
import { loadNavigation } from "../../../engine/nav/loader";
import type { NavBakeRequest } from "./navBake";

type Inbound = { id: number; type: "bake"; request: NavBakeRequest } | { id: number; type: "release"; scenePath?: string; chunkNodeId?: string };

const scope = self as unknown as { onmessage: ((e: MessageEvent<Inbound>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };

scope.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "release") {
      releaseBakeCaches(msg.scenePath, msg.chunkNodeId);
      scope.postMessage({ id: msg.id, type: "done", result: null });
      return;
    }
    const { meshes, settings, scenePath, chunkNodeId, chunk } = msg.request;
    scope.postMessage({ id: msg.id, type: "stage", stage: "loading" });
    await loadNavigation();
    scope.postMessage({ id: msg.id, type: "stage", stage: "baking" });
    const result = await bakeChunk(meshes, settings, scenePath, chunkNodeId, chunk);
    scope.postMessage({ id: msg.id, type: "done", result }, [result.bytes.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ id: msg.id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
