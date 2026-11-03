// Small per-user editor preferences, remembered in browser storage (a per-viewer convenience;
// anything unreadable falls back to the default).
import { effect, signal, type Signal } from "@preact/signals";

export function persisted<T>(key: string, fallback: T): Signal<T> {
  let initial = fallback;
  try {
    // Fall back to the key under the engine's former name (ADR 0037), so preferences carry over.
    const raw = globalThis.localStorage?.getItem(key) ?? globalThis.localStorage?.getItem(key.replace(/^myco\./, "tranquility."));
    if (raw !== null && raw !== undefined) initial = JSON.parse(raw) as T;
  } catch {
    // unreadable: keep the default
  }
  const s = signal<T>(initial);
  effect(() => {
    const value = s.value;
    try {
      globalThis.localStorage?.setItem(key, JSON.stringify(value));
    } catch {
      // storage blocked: the preference just isn't remembered
    }
  });
  return s;
}

/** Ask before deleting an asset or script file from the project (it can't be undone). */
export const askBeforeDeletingAssets = persisted("myco.editor.askBeforeDeletingAssets", true);

/** Ask before deleting a node that other nodes reference (their fields are set to None). */
export const askBeforeClearingReferences = persisted("myco.editor.askBeforeClearingReferences", true);

/**
 * Where edit history files go (ADR 0027): the project folder (`.myco/history/`, the
 * default) or per-user storage outside the project. Read-only projects always use per-user storage.
 */
export const historyLocation = persisted<"project" | "user">("myco.editor.historyLocation", "project");

/** How the Assets panel lists files: tiles in a grid, or rows with kind and size. */
export const assetView = persisted<"grid" | "list">("myco.editor.assetView", "grid");

/** The Assets panel's tile size in the grid (CSS px of the thumbnail's width). */
export const assetTileSize = persisted("myco.editor.assetTileSize", 56);

/**
 * Multiplayer play mode (ADR 0033 §9, `netPlay.ts`): whether Play runs N client Worlds plus T thin
 * clients instead of the project's own client Worlds, how many, and what thin clients send.
 */
export const netPlaySetup = persisted<{ enabled: boolean; clients: number; thin: number; thinInput: "random" | "zeros"; clientScenes?: "server" | "own" }>("myco.editor.netPlay", {
  enabled: false,
  clients: 2,
  thin: 0,
  thinInput: "random",
  // Host pattern (a server template): the clients load the server's scenes and join directly, or their own (a menu).
  clientScenes: "server",
});

/** The simulated network conditions on play mode's loopback links (all off by default). */
export const netConditionsSetting = persisted<{ latencyMs: number; jitterMs: number; lossPercent: number }>("myco.editor.netConditions", {
  latencyMs: 0,
  jitterMs: 0,
  lossPercent: 0,
});
