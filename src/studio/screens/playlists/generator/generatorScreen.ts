// The Generator editor's state and actions over the real page (ADR 0360 §9), inside the Playlists screen (D63): which
// generator is open (a `*.generator.json` named by the route, or the generator a Clip plays: its file when linked, the
// Clip's own entry when embedded), edits as one labelled undo step of the document that holds it (the generator's
// file, or the playlist file for an embedded one; drags coalesce), the editor's locks (not saved), the preview
// rendered off the main thread, the audition (a gate per held source, played through the Studio's runtime with the
// key's pitch; a generator file's edits, drags included, reach a playing voice at once through an asset source that
// serves the document's value and the runtime's hot reload, which sends `generators.setParams` with a 20 ms glide),
// the Library's New and Add, and Bake. The panels read the signals and
// call these; the rules are the pure models beside this file.
import { audioProject } from "../../../shell/audioProject";
import { computed, effect, signal } from "@preact/signals";
import { openAssetDocument, readAsset, type AssetDocument } from "../../../../editor/assetDocuments";
import { createAsset } from "../../../../editor/assetKindHost";
import { docVersion } from "../../../../editor/state";
import { emptyGenerator, emptyGeneratorBody, generatorToJson, isGeneratorPath } from "../../../../engine/audio/generators/format";
import { Assets, type AssetSource } from "../../../../engine/scene/Assets";
import { generatorSpec, generatorIsEndless } from "../../../../engine/audio/generators/catalogue";
import type { GeneratorAsset, GeneratorBody, GeneratorKind } from "../../../../engine/audio/generators/types";
import { isPlaylistPath } from "../../../../engine/audio/playlist/format";
import { applyEdit } from "../../../../editor/sdk/editResult";
import type { AudioEventHandle } from "../../../../plugins/audio/runtime";
import { audioHost, keymap, openRoute, toasts } from "../../../shell/studioServices";
import { editAt, playlistTitle, whereOf } from "../playlistPaths";
import { editContext, editFile, editOpen, openBody, openPath, openPlaylist, target } from "../playlistsScreen";
import { onSequence } from "../sequence/sequenceModel";
import { EMPTY_GATE, gatePress, gateRelease, gateReleaseAll, keySource, NOTE_KEYS, noteOfKey, type GateCommand, type GateState } from "./auditionGate";
import { BAKE, bakeAvailability, defaultBakeOptions, type BakeOptions } from "./bakeModel";
import { addGenerator, addGeneratorClip, clipGenerator, generatorClipLength, generatorName, setClipGenerator } from "./generatorEntries";
import { toggleLock, type GeneratorEdit } from "./generatorModel";
import { requestPreview, type PreviewPicture } from "./previewClient";

// --- what is open ----------------------------------------------------------------------------------------------------

/** A `*.generator.json` the route opened (shown while no playlist is open). */
export const generatorFile = signal<string | null>(null);

export type GeneratorTarget =
  /** A generator file, opened alone or through the Clip that plays it (`via`). */
  | { readonly kind: "file"; readonly path: string; readonly via: { readonly file: string; readonly indices: readonly number[] } | null }
  /** The generator a Clip holds itself. */
  | { readonly kind: "embedded"; readonly file: string; readonly indices: readonly number[] };

/** The generator the editor shows, or null (a playlist that isn't a generator Clip is open, or nothing). */
export const generatorTarget = computed<GeneratorTarget | null>(() => {
  const t = target.value;
  if (openPath.value && t) {
    const g = clipGenerator(openBody.value);
    if (!g) return null;
    return typeof g.generator === "string" ? { kind: "file", path: g.generator, via: { file: t.file, indices: t.indices } } : { kind: "embedded", file: t.file, indices: t.indices };
  }
  const path = generatorFile.value;
  return path ? { kind: "file", path, via: null } : null;
});

/** A key for per-generator state (locks, the preview). */
export const targetKey = (t: GeneratorTarget): string => (t.kind === "file" ? t.path : `${t.file}#${t.indices.join(".")}`);

/** A generator file's current value (an open document's, edits included), or null. Tracks. */
export function loadGenerator(path: string): GeneratorAsset | null {
  const p = audioProject.value;
  void docVersion.value;
  if (!p || !isGeneratorPath(path) || !p.files.includes(path)) return null;
  try {
    return readAsset<GeneratorAsset>(p, path, "generator").value;
  } catch {
    return null;
  }
}

/** The document that holds the open generator (its file's, or the playlist file's for an embedded one). */
export const generatorDoc = computed<AssetDocument<unknown> | null>(() => {
  const t = generatorTarget.value;
  const p = audioProject.value;
  void docVersion.value;
  if (!t || !p || !p.files.includes(t.kind === "file" ? t.path : t.file)) return null;
  try {
    return t.kind === "file" ? openAssetDocument<GeneratorAsset>(p, t.path, "generator") : openAssetDocument(p, t.file, "playlist");
  } catch {
    return null;
  }
});

/** The open generator's value (a file's from its document, unsaved edits and drags included). */
export const generatorBody = computed<GeneratorBody | null>(() => {
  const t = generatorTarget.value;
  if (!t) return null;
  if (t.kind === "file") return (generatorDoc.value?.value.value as GeneratorAsset | undefined) ?? null;
  const g = clipGenerator(openBody.value);
  return g && typeof g.generator !== "string" ? g.generator : null;
});

/** The editor's title and where the generator lives. */
export const generatorTitle = computed(() => {
  const t = generatorTarget.value;
  const b = generatorBody.value;
  if (!t || !b) return { title: "", where: "" };
  if (t.kind === "file") return { title: generatorName(t.path), where: t.via ? `${t.path} · played by ${playlistTitle(t.via.file)}${t.via.indices.length ? ` › ${whereOf(t.via.indices)}` : ""}` : t.path };
  return { title: `${generatorSpec(b.kind).label} generator`, where: `Embedded in ${playlistTitle(t.file)}${t.indices.length ? ` › ${whereOf(t.indices)}` : ""}` };
});

/** Open a generator file in the editor (the route follows, so a reload opens it again). */
export function openGeneratorFile(path: string): void {
  releaseAll();
  generatorFile.value = path;
  openPath.value = null;
  openRoute({ screen: "playlists", asset: path });
}

/** Follow the route: a generator file it names opens; a playlist it names closes the generator. Returns the stop. */
export function followGeneratorRoute(route: { readonly value: { asset?: string } }): () => void {
  return effect(() => {
    const asset = route.value.asset;
    if (asset && isGeneratorPath(asset)) {
      if (generatorFile.peek() !== asset || openPath.peek()) {
        generatorFile.value = asset;
        openPath.value = null;
      }
    } else if (asset && isPlaylistPath(asset)) generatorFile.value = null;
  });
}

// --- edits -----------------------------------------------------------------------------------------------------------

/** Apply an edit of the open generator as one undo step labelled `label` (a drag coalesces until `drag` is false). */
export function editGenerator(label: string, edit: GeneratorEdit, drag = false): boolean {
  const t = generatorTarget.peek();
  const current = generatorBody.peek();
  const p = audioProject.peek();
  if (!t || !current || !p) return false;
  const options = drag ? { label, coalesce: true } : { label };
  if (t.kind === "file") {
    const doc = openAssetDocument<GeneratorAsset>(p, t.path, "generator");
    return applyEdit(edit(current), label, (next) => doc.edit({ ...next, format: doc.value.peek().format }, options), current);
  }
  const r = edit(current);
  if ("refused" in r) return applyEdit(r, label, () => {});
  if (r.next === current) return true;
  return editFile(t.file, label, (root) => editAt(root, t.indices, (b) => setClipGenerator(b, r.next)), drag);
}

/** The editor's locks by generator (session only: presets, Randomise and Mutate keep these parameters). */
const locksByKey = signal<Readonly<Record<string, readonly string[]>>>({});
export const openLocks = computed<readonly string[]>(() => {
  const t = generatorTarget.value;
  return t ? (locksByKey.value[targetKey(t)] ?? []) : [];
});
export function toggleGeneratorLock(name: string): void {
  const t = generatorTarget.peek();
  if (!t) return;
  const key = targetKey(t);
  locksByKey.value = { ...locksByKey.peek(), [key]: toggleLock(locksByKey.peek()[key] ?? [], name) };
}

// --- preview ---------------------------------------------------------------------------------------------------------

export const preview = signal<PreviewPicture | null>(null);
export const previewBusy = signal(false);
/** Why the last preview couldn't render (the offline module didn't load), or null. */
export const previewError = signal<string | null>(null);
/** How long the preview waits after an edit before it renders again, ms (a drag renders as it settles). */
const PREVIEW_DELAY = 60;

/** Keep the preview following the open generator while the editor shows. Returns the stop. */
export function followPreview(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let shown: string | null = null;
  const stop = effect(() => {
    const t = generatorTarget.value;
    const body = generatorBody.value;
    if (timer) clearTimeout(timer);
    if (!t || !body) {
      preview.value = null;
      previewError.value = null;
      shown = null;
      return;
    }
    const key = targetKey(t);
    if (shown !== key) preview.value = null; // another generator: don't show the last one's picture
    previewBusy.value = true;
    timer = setTimeout(() => {
      void requestPreview(key, body).then((pic) => {
        if (!pic) return; // a newer request replaced it
        shown = key;
        previewBusy.value = false;
        if ("failed" in pic) {
          preview.value = null;
          previewError.value = pic.failed;
          return;
        }
        preview.value = pic;
        previewError.value = null;
      });
    }, shown === key ? PREVIEW_DELAY : 0);
  });
  return () => {
    if (timer) clearTimeout(timer);
    stop();
  };
}

// --- audition --------------------------------------------------------------------------------------------------------

export const gate = signal<GateState>(EMPTY_GATE);
const voices = new Map<string, AudioEventHandle>();

/** What the audition plays: the generator file, or the Clip file whose own generator it is (an embedded one at the root). */
export const auditionPath = computed<string | null>(() => {
  const t = generatorTarget.value;
  if (!t) return null;
  if (t.kind === "file") return t.path;
  return t.indices.length === 0 ? t.file : null;
});

/** Whether the audition can play now, and why not. */
export const auditionState = computed(() => {
  const path = auditionPath.value;
  if (!path) return { available: false, reason: "A generator embedded in another playlist plays with it: trigger that playlist, or Make shared to audition it here." };
  const s = audioHost().state.value;
  if (s.kind === "failed") return { available: false, reason: s.reason };
  if (s.kind === "idle" || s.kind === "starting") return { available: false, reason: "The audio runtime is starting." };
  return { available: true, reason: null };
});

function run(commands: readonly GateCommand[]): void {
  const path = auditionPath.peek();
  for (const c of commands) {
    if (c.kind === "release") {
      voices.get(c.source)?.release();
      voices.delete(c.source);
      continue;
    }
    if (!path) continue;
    const h = audioHost().audition(path, { pitch: c.pitch });
    if (h) voices.set(c.source, h);
    else toasts.show({ text: `Nothing played: ${path} was refused (Plays now says why).`, kind: "error" });
  }
}

/** A gate source pressed (Space, the Play button, a key): a voice starts at its pitch while it is held. */
export function pressGate(source: string, semitones = 0): void {
  if (!auditionState.peek().available) return;
  const step = gatePress(gate.peek(), source, semitones);
  gate.value = step.state;
  run(step.commands);
}

/** A gate source let go: its voice keys off (an endless one releases; a blip plays out). */
export function releaseGate(source: string): void {
  const step = gateRelease(gate.peek(), source);
  gate.value = step.state;
  run(step.commands);
}

/** Every held source let go. */
export function releaseAll(): void {
  const step = gateReleaseAll(gate.peek());
  gate.value = step.state;
  run(step.commands);
}

/**
 * While the editor shows a generator file: an asset source ahead of the project's serves its document's value as it
 * is now (a drag's values before they are written), and each change is announced, so a playing voice follows every
 * edit at once: the runtime's hot reload sends the changed parameters through the backend's `generators.setParams`
 * with its 20 ms glide (ADR 0360 §5). Returns the stop.
 */
export function followLiveEdits(): () => void {
  let path: string | null = null;
  let value: unknown;
  const source: AssetSource = { has: (p) => p === path, get: () => value, paths: () => (path ? [path] : []) };
  Assets.addSource(source);
  const stop = effect(() => {
    const t = generatorTarget.value;
    const body = generatorBody.value;
    const was = path;
    path = t?.kind === "file" && body ? t.path : null;
    value = path && body ? generatorToJson(body) : undefined;
    if (was && was !== path) Assets.notifyChanged(was);
    if (path) Assets.notifyChanged(path);
  });
  return () => {
    stop();
    Assets.removeSource(source);
    if (path) Assets.notifyChanged(path);
  };
}

/** Space while a generator is open (the screen's Space binding hands it here): gate on; the key-up lets it go. */
export function generatorSpace(): boolean {
  if (!generatorTarget.peek()) return false;
  pressGate("space", 0);
  return true;
}

/**
 * While the editor shows: the computer keys A–K play notes (bindings on the screen, so they win over the global
 * single-key shortcuts only while a generator is open), key-ups let Space and the notes go, and losing the window lets
 * everything go. Returns the stop.
 */
export function installGeneratorKeys(): () => void {
  const stops = NOTE_KEYS.map(([key, st]) =>
    keymap.register({
      id: `playlists.generator.note.${key}`, keys: [key], label: `Play a note (+${st} st)`, group: "Generator", scope: { screen: "playlists" },
      run: () => {
        if (!generatorTarget.peek()) return false;
        pressGate(keySource(key), st);
      },
    }),
  );
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space" || e.key === " ") releaseGate("space");
    else if (noteOfKey(e.key) !== null) releaseGate(keySource(e.key));
  };
  const onBlur = () => releaseAll();
  addEventListener("keyup", onKeyUp, true);
  addEventListener("blur", onBlur);
  return () => {
    for (const stop of stops) stop();
    removeEventListener("keyup", onKeyUp, true);
    removeEventListener("blur", onBlur);
    releaseAll();
  };
}

// --- library: new and add --------------------------------------------------------------------------------------------

const folderOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** New generator file of `kind` (beside the open playlist or generator), opened in the editor. */
export async function newGenerator(kind: GeneratorKind): Promise<void> {
  const near = target.peek()?.file ?? generatorFile.peek();
  const path = await createAsset<GeneratorAsset>("generator", { ...(near ? { folder: folderOf(near) } : {}), name: `New ${generatorSpec(kind).label.toLowerCase()}`, value: emptyGenerator(kind) });
  if (path) openGeneratorFile(path);
}

/** Add generator `generator` (a path or a new embedded body) to the open playlist: one undo step. */
export function addGeneratorToOpen(generator: string | GeneratorBody, label = "Add generator"): boolean {
  const b = openBody.peek();
  if (!b) return false;
  if (b.type === "sequence") {
    const body = typeof generator === "string" ? loadGenerator(generator) : generator;
    return editOpen(`${label} clip`, onSequence((s) => addGeneratorClip(s, generator, 0, generatorClipLength(body))));
  }
  const n = b.entries.length;
  if (!editOpen(label, (x) => addGenerator(x, generator, editContext.peek()))) return false;
  // A new embedded generator in a Queue (or any playlist but a Clip) opens in the editor.
  if (typeof generator !== "string" && b.type !== "clip" && openPath.peek()) openPlaylist([...openPath.peek()!, { entry: n }]);
  return true;
}

/** New embedded generator of `kind` in the open playlist. */
export const newEmbeddedGenerator = (kind: GeneratorKind): boolean => addGeneratorToOpen(emptyGeneratorBody(kind), `New ${generatorSpec(kind).label.toLowerCase()} generator`);

/** The Library's "Add to …" name: the open playlist's title, null when none is open. */
export const libraryAddTarget = computed(() => {
  const t = target.value;
  return t && openBody.value ? (t.indices.length ? `${playlistTitle(t.file)} › ${whereOf(t.indices)}` : playlistTitle(t.file)) : null;
});

// --- bake ------------------------------------------------------------------------------------------------------------

/** The Bake dialog's state: closed, open, or baking. */
export const baking = signal<"closed" | "open" | "busy">("closed");

/** The open generator's Bake availability. */
export const bakeState = computed(() => {
  const t = generatorTarget.value;
  const p = audioProject.value;
  return bakeAvailability(BAKE, t?.kind === "file" ? t.path : null, p ? p.canSave : null);
});

/** The dialog's starting options for the open generator. */
export const bakeDefaults = computed<BakeOptions | null>(() => {
  const t = generatorTarget.value;
  const b = generatorBody.value;
  return t?.kind === "file" && b ? defaultBakeOptions(t.path, generatorIsEndless(b.kind, b.params)) : null;
});

/** Bake `path` with `options` through G5's bake (a toast says what it wrote, or why it failed). */
export async function bake(path: string, options: BakeOptions): Promise<void> {
  if (!BAKE) return;
  baking.value = "busy";
  try {
    const r = await BAKE(path, options);
    toasts.show({ text: `Baked ${generatorName(path)}: ${r.files.length === 1 ? r.files[0] : `${r.files.length} files`}${r.queue ? ` and ${r.queue}` : ""}.` });
  } catch (err) {
    toasts.show({ text: `Couldn't bake ${generatorName(path)}: ${err instanceof Error ? err.message : String(err)}`, kind: "error" });
  } finally {
    baking.value = "closed";
  }
}
