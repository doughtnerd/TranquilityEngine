// Plugin audio effects in a build (ADR 0338 §8). The plan (`planWebBuild`) picks each enabled plugin's audio modules
// (`planAudioEffects`): a project plugin's module file is a project file the build copies (`project/plugins/...`); an
// npm plugin's is written to `code/deps/plugins/<name>/...`. A disabled plugin's module files aren't shipped (its effects
// pass through, data kept). The build writer then reads each module's bytes (`withAudioEffects`), hashes them and writes
// `game.json`'s `audioEffects`, which the player registers before the Engine starts.
import type { OfflineEffectHost } from "../engine/audio/sample/offlinePlugins";
import { offlineHostOf, type OfflineModuleFile } from "../plugins/audio/runtime/effectPlugins/offline";
import { pluginModulePath, type FoundPlugin } from "../plugins/thirdParty";
import { DEPS_DIR, copiedPath, type WebBuildPlan } from "./webBuild";
import { MANIFEST_FILE, PROJECT_DIR, type AudioEffectsEntry, type GameManifest } from "./format";

/** One module the build ships, before its bytes are read: its entry without the hash, and where it is in the project. */
export interface PlannedAudioEffect {
  /** Project-relative (a `node_modules/` path for an npm plugin). */
  readonly source: string;
  readonly entry: Omit<AudioEffectsEntry, "hash">;
}

/**
 * The modules of the enabled plugins with an `audio` section (each module that holds an effect), and the project files
 * a build leaves out: the module files of plugins that are off.
 */
export function planAudioEffects(plugins: readonly FoundPlugin[], enabled: ReadonlySet<string>): { modules: PlannedAudioEffect[]; leaveOut: Set<string> } {
  const modules: PlannedAudioEffect[] = [];
  const leaveOut = new Set<string>();
  for (const p of plugins) {
    const audio = p.manifest.audio;
    if (!audio) continue;
    const on = enabled.has(p.manifest.name);
    for (const m of audio.modules) {
      const source = pluginModulePath(p, m.wasm);
      if (!on) {
        if (p.source.kind === "project") leaveOut.add(source);
        continue;
      }
      const effects = audio.effects.filter((e) => e.module === m.id);
      if (effects.length === 0) continue;
      const url = p.source.kind === "project" ? copiedPath(source) : `${DEPS_DIR}/plugins/${p.manifest.name}/${m.wasm}`;
      modules.push({
        source,
        entry: { plugin: p.manifest.name, ...(p.manifest.title !== undefined && { title: p.manifest.title }), version: p.manifest.version, module: m.id, url, memoryMB: m.memoryMB, effects },
      });
    }
  }
  return { modules, leaveOut };
}

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
const encoder = new TextEncoder();

/**
 * The plan with `game.json`'s `audioEffects` written: each planned module's bytes read through `read` (any project path,
 * `node_modules/` included) and hashed; an npm plugin's module written into the build. A module that can't be read is
 * left out with a line through `log` (its effects pass through in the game). `renders` is the offline host over the
 * same modules, for the build's sample renders (ADR 0338 §7: a baked plugin effect renders as it plays); null when the
 * build ships none.
 */
export async function withAudioEffects(
  plan: WebBuildPlan,
  read: (path: string) => Promise<string | Uint8Array>,
  log: (line: string) => void = () => {},
): Promise<{ plan: WebBuildPlan; renders: OfflineEffectHost | null }> {
  const planned = plan.audioEffects ?? [];
  if (planned.length === 0) return { plan, renders: null };
  const binaries = new Map(plan.binaries ?? []);
  const entries: AudioEffectsEntry[] = [];
  const files: OfflineModuleFile[] = [];
  for (const { source, entry } of planned) {
    let bytes: Uint8Array;
    try {
      const v = await read(source);
      bytes = typeof v === "string" ? encoder.encode(v) : v;
    } catch (err) {
      log(`${source}: the plugin ${entry.plugin}'s audio module ${entry.module} couldn't be read (${(err as Error)?.message ?? err}); its effects pass audio through in the game.`);
      continue;
    }
    const hash = hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
    if (!entry.url.startsWith(`${PROJECT_DIR}/`)) binaries.set(entry.url, bytes); // an npm plugin's: not a project file
    entries.push({ ...entry, hash });
    files.push({ plugin: entry.plugin, version: entry.version, module: entry.module, memoryMB: entry.memoryMB, effects: entry.effects, bytes });
  }
  const manifest: GameManifest = { ...plan.manifest, ...(entries.length > 0 && { audioEffects: entries }) };
  const generated = new Map(plan.generated);
  generated.set(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  const { host, problems } = await offlineHostOf(files);
  for (const line of problems) log(line);
  return { plan: { ...plan, manifest, generated, binaries }, renders: host };
}
