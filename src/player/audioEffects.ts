// A build's plugin audio effects (ADR 0338 §8): `game.json`'s `audioEffects` (one entry per module, written by the
// exporter's `audioEffects.ts`) become the audio plugin's effect set before the Engine starts, so the first scene's
// chains find them: their specs join the catalogue and their modules the core's chains as soon as the core is up. A
// module whose bytes don't match the hash the build recorded is refused (its effects pass through), as is an entry that
// isn't shaped like one. The player imports this only when the build has entries.
import type { PluginAudio, PluginEffectDecl } from "../engine/audio/effects/types";
import type { AudioEffectsEntry } from "../export/format";
import type { EffectPluginEngines } from "../plugins/audio/runtime/effectPlugins/engineGate";
import type { EffectPluginPackage } from "../plugins/audio/runtime/effectPlugins/load";
import { applyEffectPluginSet } from "../plugins/audio/runtime/effectPlugins/projectSet";

/** Reads a build file's bytes by its path from the build's root; null when it isn't there. */
export type ReadBuildFile = (path: string) => Promise<Uint8Array | null>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The entries of `raw` shaped like `AudioEffectsEntry`; the others are problems. */
function entriesOf(raw: unknown, problems: string[]): AudioEffectsEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push("audio: game.json's audioEffects isn't a list; no plugin effects run.");
    return [];
  }
  const out: AudioEffectsEntry[] = [];
  for (const e of raw) {
    const ok =
      isRecord(e) && typeof e.plugin === "string" && typeof e.version === "string" && typeof e.module === "string" && typeof e.url === "string" &&
      typeof e.hash === "string" && typeof e.memoryMB === "number" && Array.isArray(e.effects) && e.effects.every((d) => isRecord(d) && isRecord(d.spec) && typeof d.spec.type === "string");
    if (ok) out.push(e as unknown as AudioEffectsEntry);
    else problems.push(`audio: an entry of game.json's audioEffects isn't one (${isRecord(e) && typeof e.plugin === "string" ? e.plugin : "unnamed"}); it was left out.`);
  }
  return out;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The effect set of `raw` (`game.json`'s `audioEffects`): one package per plugin, its modules read through `read` and checked against their hash. */
export function buildEffectSetOf(raw: unknown, read: ReadBuildFile, engines?: EffectPluginEngines, problems: string[] = []): EffectPluginPackage[] {
  const byPlugin = new Map<string, AudioEffectsEntry[]>();
  for (const e of entriesOf(raw, problems)) byPlugin.set(e.plugin, [...(byPlugin.get(e.plugin) ?? []), e]);
  const out: EffectPluginPackage[] = [];
  for (const [plugin, entries] of byPlugin) {
    const first = entries[0]!;
    const audio: PluginAudio = {
      abi: 1,
      // The module's `wasm` is its file in the build, so `read` gets the build path.
      modules: entries.map((e) => ({ id: e.module, wasm: e.url, memoryMB: e.memoryMB })),
      effects: entries.flatMap((e) => e.effects as readonly PluginEffectDecl[]),
    };
    const hashes = new Map(entries.map((e) => [e.url, e.hash]));
    out.push({
      plugin,
      version: first.version,
      ...(first.title !== undefined && { title: first.title }),
      enabled: true,
      audio,
      async read(path) {
        const bytes = await read(path);
        if (!bytes) return null;
        if ((await sha256(bytes)) !== hashes.get(path)) {
          console.warn(`[myco] audio: the plugin ${plugin}'s module ${path} isn't the file the build was made with (its hash differs); its effects pass audio through.`);
          return null;
        }
        return bytes;
      },
      ...(engines !== undefined && { engines }),
    });
  }
  return out;
}

/** Registers the build's plugin effects (`game.json`'s `audioEffects`). Resolves to the problems, each warned once. */
export async function registerBuildAudioEffects(raw: unknown, read: ReadBuildFile, engines?: EffectPluginEngines): Promise<string[]> {
  const problems: string[] = [];
  const set = buildEffectSetOf(raw, read, engines, problems);
  for (const line of problems) console.warn(`[myco] ${line}`);
  return [...problems, ...(await applyEffectPluginSet(set))];
}
