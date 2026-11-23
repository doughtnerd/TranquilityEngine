// Plugin effect health for the Studio's effect cards and the Profiler's Plugins panel (ADR 0352 §9): the rows of the
// runtime's public `Audio.debug().plugins`, read twice a second while a view that shows them is mounted, and the Reset
// plugin action, which goes to the audio backend's `effectPlugins` capability (`reset`: the effect's faults and its
// off-after-faults state cleared, its instances re-created). Where the runtime has no rows (no core, no plugin loaded)
// the views get none.
import { useEffect, useState } from "preact/hooks";
import { Audio } from "../../plugins/audio/runtime/Audio";
import { audioBackend, hasAudioBackend } from "../../plugins/audio/runtime/backend";
import type { AudioPluginDebug } from "../../plugins/audio/runtime/debugTypes";

/** How often the rows are read, ms. */
const EVERY_MS = 500;

/** The runtime's plugin rows now (none when it has no backend yet or reports none). */
export function readPluginHealth(): readonly AudioPluginDebug[] {
  if (!hasAudioBackend()) return [];
  try {
    return Audio.debug().plugins ?? [];
  } catch {
    return [];
  }
}

/** The plugin rows, kept fresh while `on` (a chain with a plugin effect, the Plugins panel showing). */
export function usePluginHealth(on: boolean): readonly AudioPluginDebug[] {
  const [rows, setRows] = useState<readonly AudioPluginDebug[]>(() => (on ? readPluginHealth() : []));
  useEffect(() => {
    if (!on) return;
    setRows(readPluginHealth());
    const timer = setInterval(() => setRows(readPluginHealth()), EVERY_MS);
    return () => clearInterval(timer);
  }, [on]);
  return rows;
}

/** Reset plugin: clears effect `type`'s faults and off state on the running backend. False when nothing runs it. */
export function resetPluginEffect(type: string): boolean {
  if (!hasAudioBackend()) return false;
  const plugins = audioBackend().effectPlugins;
  if (!plugins) return false;
  plugins.reset(type);
  return true;
}
