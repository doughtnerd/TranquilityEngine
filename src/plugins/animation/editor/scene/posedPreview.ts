// Posing the Inspector's live previews (ADR 0373, T18b). The preview host (`LargePreview`'s `posed`, in `src/editor`) loads
// the nodes a plugin describes into a World of its own that steps while the preview is open. This module is what the
// Animation plugin puts there: clips served from memory, and a driver that plays them on the preview World's Animators
// through the runtime (`Animator.play(path, { speed: 0, normalizedTime })`, the Animation window's approach, D129), so the
// animation core evaluates the pose and the skinning feature draws it. The World, and with it the core's namespace and the
// handles it holds, is torn down by the host when the preview stops; `dispose` here drops the served files.
//
// The runtime acquires a clip once per Animator and path and keeps it (D119), so each version of a clip is served under a
// path of its own (`.clip-preview/<n>/<name>`): an edit's next preview plays the new one. Served content is deduplicated,
// so an unchanged clip keeps its path (and its acquired handle) as the playhead moves.
import type { PosedPreview } from "../../../../editor/sdk";
import { animSourceToJson, type AnimSource } from "../../../../engine/animation/animSource";
import { fnv1aHex } from "../../../../engine/animation/compile/hash";
import { Assets, type AssetSource } from "../../../../engine/scene/Assets";
import type { SceneFile } from "../../../../engine/scene/SceneLoader";
import type { World } from "../../../../engine/core/World";
import { readClipInfo } from "../../runtime/assetInfo";
import { loadClipSource } from "../../runtime/features/clipSources";
import { Animator } from "../../runtime/components/Animator";
import { normalizedTimeAt, type PlayRange } from "./posedPreviewLogic";
import { assetRefTarget } from "../../../../editor/sdk";
import { clipRefKind } from "../../../../engine/animation/compile/keys";

/** Versions kept in the served source (older ones are dropped; an Animator holding one keeps its loaded copy). */
const KEPT = 8;
const ROOT = ".clip-preview";
/** Every served version of every preview gets its own number: an Animator that outlives a preview's files never meets a path again. */
let versions = 0;

/** A clip ready to play on the preview: where it is served, how long it is, and the part of it the playhead spans. */
export interface PreviewClip {
  readonly path: string;
  readonly duration: number;
  readonly looping: boolean;
  readonly range?: PlayRange;
}

/** The in-memory files the preview plays clips from. */
export class PreviewClipFiles {
  private readonly files = new Map<string, unknown>();
  private readonly byContent = new Map<string, string>();
  private readonly source: AssetSource = { has: (p) => this.files.has(p), get: (p) => this.files.get(p), paths: () => this.files.keys() };

  private serve(content: string, name: string, value: unknown): string {
    const known = this.byContent.get(content);
    if (known !== undefined && this.files.has(known)) return known;
    const path = `${ROOT}/${++versions}/${name}`;
    this.files.set(path, value);
    this.byContent.set(content, path);
    while (this.files.size > KEPT) {
      const oldest = this.files.keys().next().value!;
      this.files.delete(oldest);
    }
    if (!Assets.has(path)) Assets.addSource(this.source); // first use, or the sources were cleared
    return path;
  }

  /** Serve an authored clip (`myco.anim-source@1`); the same content keeps its path. */
  serveSource(clip: AnimSource): string {
    const json = animSourceToJson(clip);
    return this.serve(`json:${JSON.stringify(json)}`, "clip.anim.json", json);
  }

  /** Serve a compiled clip's bytes (`myco.anim@1`, as a retarget bake writes them); the same bytes keep their path. */
  serveBytes(bytes: Uint8Array, name = "clip.anim.bin"): string {
    const url = `data:application/octet-stream;base64,${base64(bytes)}`;
    return this.serve(`bin:${fnv1aHex(bytes)}:${bytes.length}`, name, url);
  }

  /** Drop every served version and leave the asset sources. */
  dispose(): void {
    this.files.clear();
    this.byContent.clear();
    Assets.removeSource(this.source);
  }
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** An authored clip's served path and timing. */
export function previewClipOfSource(files: PreviewClipFiles, source: AnimSource, range?: PlayRange): PreviewClip {
  return { path: files.serveSource(source), duration: source.duration, looping: source.loop, ...(range ? { range } : {}) };
}

/**
 * The clip `entry` names (an authored `*.anim.json`, a compiled `*.anim.bin`, or a model's `model#Anim/<name>`) ready to
 * play on the preview, or null when it can't be read. A model's clip is served as its authored source (what the importer
 * cut), which binds by bone name to the Animator's skeleton.
 */
export async function prepareClip(files: PreviewClipFiles, entry: string): Promise<PreviewClip | null> {
  const path = assetRefTarget(entry);
  try {
    if (clipRefKind(path) === "compiled") {
      if (!Assets.has(path)) return null;
      const bytes = await Assets.bytes(path);
      // The header's length and loop flag, as the Inspector's scrubber reads them (`clipTiming`).
      const info = readClipInfo(bytes);
      return info ? { path: files.serveBytes(bytes), duration: info.duration, looping: info.looping } : null;
    }
    const data = await loadClipSource(path);
    return data ? previewClipOfSource(files, data.source) : null;
  } catch {
    return null;
  }
}

/** Drives the preview World's Animators from a playhead: what plays on which model, and the time it is shown at. */
export class PosedClipPreview {
  readonly files = new PreviewClipFiles();
  private readonly clips = new Map<string, PreviewClip>();
  private time = 0;
  /** What each Animator was last asked to show, so a still playhead asks nothing. */
  private readonly shown = new WeakMap<Animator, { path: string; normalizedTime: number }>();

  /** The clip the model whose root node is named `role` plays (null: it stands in its rest pose). */
  setClip(role: string, clip: PreviewClip | null): void {
    if (clip) this.clips.set(role, clip);
    else this.clips.delete(role);
  }

  /** The playhead: seconds into what the preview shows. */
  setTime(seconds: number): void {
    this.time = seconds;
  }

  /** The content a `LargePreview` poses: `scene`, kept by `key`, driven by this preview. */
  content(key: string, scene: SceneFile): PosedPreview {
    return { key, scene, frame: (world) => this.frame(world) };
  }

  /** Before each frame of the preview World: ask each Animator for the pose at the playhead when it changed. */
  frame(world: World): void {
    for (const animator of world._componentsOfType(Animator)) {
      const clip = this.clips.get(animator.node.name);
      if (!clip) continue;
      const normalizedTime = normalizedTimeAt(this.time, clip.duration, clip.range);
      const last = this.shown.get(animator);
      if (last && last.path === clip.path && last.normalizedTime === normalizedTime) continue;
      this.shown.set(animator, { path: clip.path, normalizedTime });
      void animator.play(clip.path, { speed: 0, normalizedTime, loop: false });
    }
  }

  /** Drop the served files (the host tears the World down). */
  dispose(): void {
    this.clips.clear();
    this.files.dispose();
  }
}
