// The Spatial screen's state and actions over the real page (ADR 0347, 0341, 0349): which test scene is open (mirrored in
// the route: the file as `asset`), the selection, the tool, the camera, the elevation slab, the clipboard, and the
// audition (the test scene player in the Studio's runtime World). Scene edits go to the open scene's asset document as
// one labelled undo step each (`applyEdit`; drags coalesce into one step); scene files are made, renamed, duplicated
// and deleted through the engine's asset operations; the project settings shown here are edited on `audio.json`
// through the Mixer's document; "Edit attenuation…" edits the playlist's attenuation on its owning document. The panels
// read these signals and call these actions; the rules are the pure models beside this file.
import { computed, effect, signal } from "@preact/signals";
import { assetDocumentsDeleted, openAssetDocument, readAsset, type AssetDocument } from "../../../editor/assetDocuments";
import { whyNotDeletable } from "../../../editor/assetDelete";
import { errorStatus } from "../../../editor/messages";
import { createAsset } from "../../../editor/assetKindHost";
import { duplicateAssets, renameAsset } from "../../../editor/assetOps";
import { assetKinds } from "../../../editor/sdk/contributions";
import { currentProject, docVersion, status } from "../../../editor/state";
import { openCurveEditorDialog } from "../../../editor/ui/curves/openCurveEditorDialog";
import { ATTENUATION_FORMAT, type Attenuation, type AttenuationAsset } from "../../../engine/audio/attenuation/types";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { PlaylistAsset } from "../../../engine/audio/playlist/types";
import { importBaseScene, type BaseSceneImport } from "../../../engine/audio/spatial/baseScene";
import { audioTestSceneToJson, emptyAudioTestScene, parseAudioTestScene, testSceneReferences } from "../../../engine/audio/spatial/testScene";
import { AUDIO_SCENE_SUFFIX, type AudioTestScene } from "../../../engine/audio/spatial/testSceneTypes";
import { World } from "../../../engine/core/World";
import { applyEdit } from "../../../editor/sdk/editResult";
import { openTakeFile } from "../../../plugins/audio/runtime/capture/takeFile";
import { loadBaseScene, type LoadedBaseScene } from "../../../plugins/audio/runtime/testScene/baseScene";
import { playAudioTestScene, type AudioTestScenePlayer, type TestSceneMotionRow, type TestSceneVoiceRow } from "../../../plugins/audio/runtime/testScene/player";
import type { SoundItem } from "../../components/soundPickerModel";
import { playlistBadge, sampleBadge } from "../../components/typeBadgeModel";
import { audioHost, openRoute, toasts } from "../../shell/studioServices";
import { openMixDocument } from "../mixer/mixerDocument";
import { setSpatial } from "../playlists/playlistEdits";
import { baseFramePoints } from "./baseLayer";
import { attenuationDialog, attenuationFromResult, attenuationOwner, NEW_SPATIAL, newAttenuation, occlusionOn, presetNameFor, PRESET_FOLDER, whyNotEditAttenuation, type AttenuationOwner } from "./attenuationModel";
import { NO_AUDITION, auditionScene, isSilenced, liveUpdate, toggleMute, toggleSolo, type AuditionState } from "./audition";
import { INITIAL_SLAB, type Slab } from "./elevation";
import { sameMotion, startFrameLoop } from "./liveMotion";
import { boundsOf, type P2 } from "./geometry";
import { baseSoundRefs } from "./voicesTable";
import { blankScene, copyScene, gameScene, sceneFromTake, type NewSceneKind } from "./newScene";
import { activeListener, deleteObject, framePoints, duplicateObject, findObject, KIND_NOUN, pasteObject, positionOf, type EditResult, type SceneObject } from "./sceneEdits";
import { isScenePath, sceneAfter, sceneName, sceneNote, type FolderChange, type SceneEntry } from "./sceneTree";
import { escape as escapeTool, INITIAL_TOOLS, afterPlace, place, placeLabel, type Tool, type ToolState } from "./tools";
import { DEFAULT_VIEW, fitView, type Size, type View } from "./viewTransform";
import { isSamplePath } from "../playlists/libraryModel";
import { setRuntimeOcclusionCurves } from "../mixer/mixerRuntime";
import { sameOcclusionCurves, type OcclusionCurves } from "../../../engine/audio/occlusionCurves";
import { effectiveOcclusionCurves, OCCLUSION_CONTEXT, OCCLUSION_TARGET, occlusionDialog, occlusionFromResult, setProjectOcclusionCurves, setSceneOcclusionCurves } from "./occlusionCurvesModel";

// --- the scene asset kind --------------------------------------------------------------------------------------------

/** The test scene document kind (ADR 0347 `*.audioscene.json`); the Studio registers it (no plugin does). */
export const SCENE_KIND = "audioScene";
/** Where new scenes go when the project has the folder. */
export const SCENE_FOLDER = "audio/scenes";

const SCENE_ICON = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z";

/** Register the test scene kind once per page: the engine's lenient parse and writer, and what a scene names. */
export function ensureSceneKind(): void {
  if (assetKinds.get(SCENE_KIND)) return;
  assetKinds.register({
    id: SCENE_KIND,
    extensions: [AUDIO_SCENE_SUFFIX],
    label: "Test scene",
    icon: SCENE_ICON,
    folder: SCENE_FOLDER,
    format: {
      parse: (raw, path) => {
        const read = parseAudioTestScene(raw, path);
        return { value: read.scene, problems: read.problems.map((message) => ({ message })) };
      },
      format: (value: AudioTestScene) => `${JSON.stringify(audioTestSceneToJson(value), null, 2)}\n`,
      empty: emptyAudioTestScene,
      writeDelay: 200,
    },
    references: {
      extensions: [AUDIO_SCENE_SUFFIX],
      read: (_path, text) => {
        try {
          return [...new Set(testSceneReferences(parseAudioTestScene(JSON.parse(text)).scene).map((r) => r.path))];
        } catch {
          return [];
        }
      },
    },
  });
}

// --- state -----------------------------------------------------------------------------------------------------------

/** The open scene file (null: none). */
export const openPath = signal<string | null>(null);
/** The selected object's id. */
export const selected = signal<string | null>(null);
export const tools = signal<ToolState>(INITIAL_TOOLS);
export const view = signal<View>(DEFAULT_VIEW);
/** The viewport's size, set by the Scene view (Fit needs it). */
export const viewportSize = signal<Size>({ width: 800, height: 600 });
export const slab = signal<Slab>(INITIAL_SLAB);
export const sideView = signal(false);
export const audition = signal<AuditionState>(NO_AUDITION);
/** The screen's Play is on. */
export const playing = signal(false);
/** The player's readout, polled while playing. */
export const voices = signal<readonly TestSceneVoiceRow[]>([]);
/** Where each emitter is now, read every animation frame while playing (empty when stopped: the plan shows the authored start). */
export const motion = signal<readonly TestSceneMotionRow[]>([]);
/** Folders made in this session that hold no scene yet. */
export const extraFolders = signal<readonly string[]>([]);
/** A dialog of the New menu that needs a choice (a game scene, a take and a time). */
export const newDialog = signal<{ kind: "game" | "take"; folder: string } | null>(null);
/** "Edit attenuation…" on a playlist without any: Create preset or Inline. */
export const attenuationChoice = signal<{ emitter: string; playlist: string } | null>(null);
/** The node being renamed in place on the plan. */
export const renaming = signal<string | null>(null);
/** An object hovered in the Outline (highlighted on the plan). */
export const hover = signal<string | null>(null);

let clipboard: SceneObject | null = null;

const project = () => currentProject.value;
const writable = () => !!currentProject.peek()?.canSave;

/** The document of a scene file. */
export function docFor(path: string): AssetDocument<AudioTestScene> | null {
  const p = currentProject.peek();
  if (!p) return null;
  ensureSceneKind();
  return openAssetDocument<AudioTestScene>(p, path, SCENE_KIND);
}

/** A scene file's value (an open document's, edits included), or null. Tracks. */
export function loadScene(path: string): AudioTestScene | null {
  const p = project();
  void docVersion.value;
  if (!p || !p.files.includes(path)) return null;
  ensureSceneKind();
  try {
    return readAsset<AudioTestScene>(p, path, SCENE_KIND).value;
  } catch {
    return null;
  }
}

export const openDoc = computed(() => (openPath.value && loadScene(openPath.value) ? docFor(openPath.value) : null));
export const scene = computed<AudioTestScene | null>(() => openDoc.value?.value.value ?? null);
export const readOnly = computed(() => !project()?.canSave || !!openDoc.value?.readOnly);

/**
 * The open scene's base game scene as imported (ADR 0347: its audio components and colliders, read-only underneath), or
 * null when it names none. Read from the project's files (the game scene's latest saved content). Tracks.
 */
export const baseImport = computed<BaseSceneImport | null>(() => {
  const base = scene.value?.base;
  void docVersion.value;
  if (!base) return null;
  if (!project()?.files.includes(base)) return importBaseScene(base, { read: () => undefined }); // missing: the warning
  return importBaseScene(base);
});

/** The project's scene files with their folders, for the Scenes tree. Tracks. */
export const sceneEntries = computed<SceneEntry[]>(() => {
  const p = project();
  void docVersion.value;
  if (!p) return [];
  return p.files.filter(isScenePath).map((path) => {
    const s = loadScene(path);
    return { path, folder: s?.folder ?? "", ...(s ? { note: sceneNote(s) } : {}) };
  });
});

/** The project's mix (`audio.json`), through the Mixer's document. Tracks. */
export const mixDoc = computed(() => openMixDocument(project()));
export const mix = computed<AudioProject | null>(() => mixDoc.value?.value.value ?? null);
export const busNames = computed(() => (mix.value?.buses ?? []).map((b) => b.name));
export const materials = computed(() => mix.value?.settings.occlusion.materials ?? []);

/** A playlist file's value, or null. Tracks. */
export function loadPlaylist(path: string): PlaylistAsset | null {
  const p = project();
  void docVersion.value;
  if (!p || !p.files.includes(path)) return null;
  try {
    return readAsset<PlaylistAsset>(p, path, "playlist").value;
  } catch {
    return null;
  }
}

/** An attenuation preset's value, or null. Tracks. */
export function loadPreset(path: string): Attenuation | null {
  const p = project();
  void docVersion.value;
  if (!p || !p.files.includes(path)) return null;
  try {
    return readAsset<AttenuationAsset>(p, path, "attenuation").value;
  } catch {
    return null;
  }
}

/** The sounds the picker offers: playlists (with their type badge) and samples. */
export function soundItems(): SoundItem[] {
  const files = currentProject.peek()?.files ?? [];
  const out: SoundItem[] = [];
  for (const f of files) {
    if (f.toLowerCase().endsWith(".playlist.json")) {
      const p = loadPlaylist(f);
      out.push({ path: f, kind: "playlist", badge: p ? playlistBadge(p.type, p.blend?.axes.length === 2 ? 2 : 1).code : "QUE" });
    } else if (isSamplePath(f)) out.push({ path: f, kind: "sample", badge: sampleBadge().code });
  }
  return out;
}

// --- opening ---------------------------------------------------------------------------------------------------------

/** Open scene `path` (the route follows); the camera frames it. */
export function openScene(path: string): void {
  stopAudition();
  openPath.value = path;
  selected.value = null;
  tools.value = INITIAL_TOOLS;
  renaming.value = null;
  queueMicrotask(fit);
  openRoute({ screen: "spatial", asset: path });
}

/** Follow the route: a scene it names that isn't open opens; `select` selects an object. Returns the stop. */
export function followRoute(route: { readonly value: { asset?: string; select?: string } }): () => void {
  return effect(() => {
    const r = route.value;
    if (!r.asset || !isScenePath(r.asset)) return;
    if (openPath.peek() !== r.asset) {
      stopAudition();
      openPath.value = r.asset;
      selected.value = null;
      tools.value = INITIAL_TOOLS;
      queueMicrotask(fit);
    }
    if (r.select) selected.value = r.select;
  });
}

// --- edits -----------------------------------------------------------------------------------------------------------

/** Apply an edit of the open scene as one undo step labelled `label` (a drag coalesces until `endDrag`). */
export function editScene(label: string, edit: (s: AudioTestScene) => EditResult<AudioTestScene>, drag = false): boolean {
  const doc = openDoc.peek();
  if (!doc) return false;
  const before = doc.value.peek();
  return applyEdit(edit(before), label, (next) => doc.edit(next, drag ? { label, coalesce: true } : { label }), before);
}

/** End a drag: its coalesced edits become one step now. */
export function endDrag(): void {
  void openDoc.peek()?.flush();
}

/** Edit `audio.json` (the project's settings) as one undo step of the mix document. */
export function editMix(label: string, edit: (p: AudioProject) => EditResult<AudioProject>, drag = false): boolean {
  const doc = mixDoc.peek();
  if (!doc) return false;
  const before = doc.value.peek();
  return applyEdit(edit(before), label, (next) => doc.edit(next, drag ? { label, coalesce: true } : { label }), before);
}


/** Place `tool`'s object at `at`: one step, selected; Select comes back (a moving emitter opens its path). */
export function placeAt(tool: Exclude<Tool, "select">, at: P2, slabLow: number): void {
  const s = scene.peek();
  const m = mix.peek();
  if (!s) return;
  const r = place(s, tool, at, { slabLow, material: m?.settings.occlusion.defaultMaterial ?? "concrete", buses: busNames.peek() });
  if ("refused" in r) {
    editScene(placeLabel(tool), () => r);
    return;
  }
  if (editScene(placeLabel(tool), () => ({ next: r.next.scene }))) {
    selected.value = r.next.id;
    tools.value = afterPlace(tool, r.next.id);
  }
}

/** Copy the selection. */
export function copySelection(): boolean {
  const s = scene.peek();
  const o = s && selected.peek() ? findObject(s, selected.peek()!) : null;
  if (!o) return false;
  clipboard = structuredClone(o);
  status.value = { kind: "info", text: `Copied ${o.obj.name}.` };
  return true;
}

/** Paste the clipboard 3 m along; the copy is selected. */
export function pasteClipboard(): boolean {
  const c = clipboard;
  if (!c || !scene.peek()) return false;
  let id: string | null = null;
  const ok = editScene(`Paste ${KIND_NOUN[c.kind]}`, (s) => {
    const r = pasteObject(s, c);
    if ("refused" in r) return r;
    id = r.next.id;
    return { next: r.next.scene };
  });
  if (ok && id) selected.value = id;
  return ok;
}

/** Duplicate the selection beside itself; the copy is selected. */
export function duplicateSelection(): boolean {
  const sel = selected.peek();
  const s = scene.peek();
  const o = s && sel ? findObject(s, sel) : null;
  if (!o) return false;
  let id: string | null = null;
  const ok = editScene(`Duplicate ${o.obj.name}`, (x) => {
    const r = duplicateObject(x, o.obj.id);
    if ("refused" in r) return r;
    id = r.next.id;
    return { next: r.next.scene };
  });
  if (ok && id) selected.value = id;
  return ok;
}

/** Delete object `id` (default: the selection). */
export function deleteSelected(id = selected.peek()): boolean {
  const s = scene.peek();
  const o = s && id ? findObject(s, id) : null;
  if (!o) return false;
  const ok = editScene(`Delete ${o.obj.name}`, (x) => deleteObject(x, o.obj.id));
  if (ok) {
    if (selected.peek() === o.obj.id) selected.value = null;
    if (tools.peek().pathEdit === o.obj.id) tools.value = INITIAL_TOOLS;
  }
  return ok;
}

/** Esc in the Scene view. */
export function escapeKey(): void {
  renaming.value = null;
  const r = escapeTool(tools.peek());
  tools.value = r.state;
  if (r.deselect) selected.value = null;
}

// --- camera ----------------------------------------------------------------------------------------------------------

/** Frame the open scene. */
export function fit(): void {
  const s = scene.peek();
  // At least 60 m across: a new scene (one listener) opens framed like a scene, not zoomed onto the listener.
  const b = s ? boundsOf([...framePoints(s), ...baseFramePoints(baseImport.peek())], 60) : null;
  view.value = b ? fitView(b, viewportSize.peek()) : DEFAULT_VIEW;
}

// --- audition --------------------------------------------------------------------------------------------------------

let player: AudioTestScenePlayer | null = null;
/** The scene the running player was built from (as auditioned). */
let played: AudioTestScene | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let follow: (() => void) | null = null;
let stopFrames: (() => void) | null = null;
/** ADR 0362 item 6: keeps the runtime's occlusion curves on the ones the playing scene hears (its own, else the project's). */
let curvesFollow: (() => void) | null = null;
/** The curves last handed to the runtime (undefined: none). */
let runtimeCurves: OcclusionCurves | undefined = undefined;

/** Hand `curves` to the running runtime when they differ from what it has (the live op `setOcclusionCurves`). */
function syncRuntimeCurves(curves: OcclusionCurves | undefined): void {
  if (sameOcclusionCurves(runtimeCurves, curves)) return;
  if (setRuntimeOcclusionCurves(curves ?? null)) runtimeCurves = curves;
}
/** How often the Voices table and the rays are read, ms. */
export const VOICES_POLL_MS = 250;

/**
 * The Studio runtime's World, while the runtime can play: the Engine the Studio starts (`engineRuntime.ts`) is the page's
 * only one and keeps its World current (`World.active`), as the test scene player's own tests reach it.
 * TODO(ADR 0341): a `world` on the runtime host would make this a seam instead of the current-World lookup.
 */
function studioWorld(): World | null {
  if (!audioHost().playable.peek()) return null;
  return World.active;
}

/** The base game scene loaded in the World under the audition (ADR 0347), by the path the scene names. */
let loadedBase: { readonly path: string; readonly loaded: LoadedBaseScene } | null = null;
/** Bumped by every start, base change and stop, so a base load that finishes after the audition moved on is dropped. */
let auditionGen = 0;

function unloadBase(): void {
  loadedBase?.loaded.dispose();
  loadedBase = null;
}

/**
 * Make the World's base the game scene `path` (null: none), loading it underneath (its audio components and colliders,
 * through the engine's scene loading) when it changed. Resolves false when the audition moved on meanwhile. A base
 * that's missing or fails to load is said on the status line and the scene plays without it.
 */
async function useBase(path: string | null, gen: number): Promise<boolean> {
  if ((loadedBase?.path ?? null) === path) return true;
  unloadBase();
  if (!path) return true;
  const shown = baseImport.peek();
  const imported = shown?.path === path ? shown : importBaseScene(path);
  let loaded: LoadedBaseScene;
  try {
    loaded = await loadBaseScene(path, imported);
  } catch (err) {
    if (gen === auditionGen) status.value = { kind: "error", text: `Couldn't load the base scene ${path}, so the scene plays without it: ${err instanceof Error ? err.message : String(err)}` };
    return gen === auditionGen;
  }
  if (gen !== auditionGen) {
    loaded.dispose();
    return false;
  }
  loadedBase = { path, loaded };
  if (!imported.found) status.value = { kind: "info", text: imported.problems[0] ?? `The base scene ${path} isn't in the project; the scene plays without it.` };
  return true;
}

function build(s: AudioTestScene): boolean {
  const world = studioWorld();
  if (!world) return false;
  const a = auditionScene(s, audition.peek());
  try {
    // D43: the base game scene's own sounds play underneath; the Voices table and the rays read them too.
    player = playAudioTestScene(world, a, { base: baseSoundRefs(loadedBase?.path === s.base ? loadedBase.loaded.import : null) });
  } catch (err) {
    status.value = { kind: "error", text: `Couldn't play the scene: ${err instanceof Error ? err.message : String(err)}` };
    player = null;
    return false;
  }
  played = a;
  return true;
}

/** Build the player for the open scene once its base is in the World (false: stopped or superseded meanwhile). */
async function buildWithBase(gen: number): Promise<boolean> {
  const s = scene.peek();
  if (!s) return false;
  if (!(await useBase(s.base, gen))) return false;
  const now = scene.peek(); // edits made while the base loaded
  if (!now || gen !== auditionGen) return false;
  if (now.base !== s.base) return buildWithBase(gen);
  return build(now);
}

/** Play the open scene from its active listener (the screen's Play), over its base game scene when it names one. */
export function playScene(): void {
  const s = scene.peek();
  if (!s || playing.peek()) return;
  const host = audioHost();
  if (!host.playable.peek()) {
    const st = host.state.peek();
    status.value = { kind: "info", text: st.kind === "failed" ? st.reason : "The Studio's audio runtime isn't running yet." };
    return;
  }
  if (!studioWorld()) {
    status.value = { kind: "info", text: "The Studio's audio runtime has no World to play the scene in yet." };
    return;
  }
  const gen = ++auditionGen;
  if (s.base && loadedBase?.path !== s.base) status.value = { kind: "info", text: `Loading ${s.base} underneath…` };
  void buildWithBase(gen).then((ok) => {
    if (!ok && gen === auditionGen) stopAudition();
  });
  playing.value = true;
  poll = setInterval(() => {
    try {
      voices.value = player?.voices() ?? [];
    } catch {
      voices.value = [];
    }
  }, VOICES_POLL_MS);
  // The Engine steps the World (and so the route movers and Doppler) every animation frame; the plan follows each frame.
  stopFrames = startFrameLoop(() => {
    let next: readonly TestSceneMotionRow[];
    try {
      next = player?.motion() ?? [];
    } catch {
      next = [];
    }
    if (!sameMotion(motion.peek(), next)) motion.value = next;
  });
  // The scene's own occlusion curves stand in for the project's while it plays, and follow edits of either.
  runtimeCurves = mix.peek()?.settings.occlusion.curves;
  curvesFollow = effect(() => syncRuntimeCurves(effectiveOcclusionCurves(mix.value, scene.value)));
  // Edits reach the running player: moves as poses, anything else rebuilds it.
  follow = effect(() => {
    const next = scene.value;
    const a = audition.value;
    if (!player || !played) return;
    if (!next) return stopAudition();
    const want = auditionScene(next, a);
    const u = liveUpdate(played, want);
    if (u.kind === "none") return;
    if (u.kind === "rebuild") {
      player.dispose();
      player = null;
      played = null;
      if (next.base === (loadedBase?.path ?? null)) {
        if (!build(next)) stopAudition();
        return;
      }
      const gen = ++auditionGen; // a new base: load it, then build
      void buildWithBase(gen).then((ok) => {
        if (!ok && gen === auditionGen) stopAudition();
      });
      return;
    }
    for (const { id, pose } of u.poses) player.moveObject(id, pose);
    if (u.listener) player.setActiveListener(u.listener);
    played = want;
  });
}

/** Stop the audition. */
export function stopAudition(): void {
  follow?.();
  follow = null;
  curvesFollow?.();
  curvesFollow = null;
  syncRuntimeCurves(mix.peek()?.settings.occlusion.curves); // back to the project's
  runtimeCurves = undefined;
  if (poll) clearInterval(poll);
  poll = null;
  stopFrames?.();
  stopFrames = null;
  auditionGen++;
  player?.dispose(); // before the base: the player's nodes are under the base's scene node
  player = null;
  played = null;
  unloadBase();
  playing.value = false;
  voices.value = [];
  motion.value = [];
}

export const togglePlay = (): void => (playing.peek() ? stopAudition() : playScene());

/** Hear object `id` on its own (again: everything), starting the audition if it's off. */
export function solo(id: string): void {
  audition.value = toggleSolo(audition.peek(), id);
  if (!playing.peek() && audition.peek().solo !== null) playScene();
}

/** Mute or unmute object `id` in the audition. */
export const mute = (id: string): void => void (audition.value = toggleMute(audition.peek(), id));

/** Play everything from listener `id` ("Play all"). */
export function playAllFrom(id: string): void {
  audition.value = { ...audition.peek(), solo: null };
  listenHere(id);
  if (!playing.peek()) playScene();
}

/** Hear the scene from listener `id` (one step on the scene). */
export function listenHere(id: string): void {
  const s = scene.peek();
  if (!s || s.activeListener === id) return;
  editScene("Listen here", (x) => (x.listeners.some((l) => l.id === id) ? { next: { ...x, activeListener: id } } : { refused: "there's no such listener" }));
}

export const silenced = (id: string): boolean => isSilenced(audition.value, id);

/** The player bar's status line. */
export function auditionStatus(): string | undefined {
  const s = scene.value;
  if (!playing.value || !s) return undefined;
  const a = audition.value;
  const soloed = a.solo ? findObject(s, a.solo) : null;
  if (soloed) return `Auditioning ${soloed.obj.name} on its own`;
  return `Playing from ${activeListener(s).name}`;
}

// --- scene files -----------------------------------------------------------------------------------------------------

const folderOfFile = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** Where a new scene file goes: beside the open one, else the kind's folder. */
function fileFolder(): string | undefined {
  const open = openPath.peek();
  return open ? folderOfFile(open) : undefined;
}

/** Make a scene file holding `value` named `name`, and open it. */
async function createScene(name: string, value: AudioTestScene): Promise<string | null> {
  ensureSceneKind();
  const path = await createAsset<AudioTestScene>(SCENE_KIND, { folder: fileFolder(), name, value });
  if (path) openScene(path);
  return path;
}

/** The New menu: Blank, From current, From open game scene (asks), From take (asks). */
export function newScene(kind: NewSceneKind, folder: string): void {
  if (kind === "blank") void createScene("New scene", blankScene(folder));
  else if (kind === "current") {
    const s = scene.peek();
    const open = openPath.peek();
    if (s && open) void createScene(`${sceneName(open)} copy`, copyScene(s, folder));
  } else newDialog.value = { kind, folder };
}

/** From open game scene: a blank scene over game scene `base`. */
export function newFromGameScene(base: string, folder: string): void {
  newDialog.value = null;
  const name = base.slice(base.lastIndexOf("/") + 1).replace(/\.scene\.json$/i, "");
  void createScene(name || "Game scene", gameScene(base, folder));
}

/** A project file's bytes (its asset URL fetched). */
async function readProjectBytes(path: string): Promise<Uint8Array> {
  const url = currentProject.peek()?.assets.get(path);
  if (typeof url !== "string") throw new Error(`${path} isn't in the project`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`couldn't read ${path} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Open a take for From take: its duration and a scene maker. */
export async function openTake(path: string): Promise<{ duration: number; at(t: number, folder: string): AudioTestScene }> {
  const { take } = await openTakeFile(await readProjectBytes(path));
  return { duration: take.duration, at: (t, folder) => sceneFromTake({ meta: take.meta, requests: take.requests }, t, folder) };
}

/** From take: positions at `t` of take `path`. */
export function newFromTake(path: string, scene: AudioTestScene, t: number): void {
  newDialog.value = null;
  const name = `${path.slice(path.lastIndexOf("/") + 1).replace(/\.sporesample$/i, "")} @ ${Math.floor(t / 60)}m${String(Math.floor(t % 60)).padStart(2, "0")}s`;
  void createScene(name, scene);
}

/** Rename a scene file (the open path follows). */
export async function renameScene(path: string, name: string): Promise<void> {
  const clean = name.trim().replace(/\.audioscene\.json$/i, "");
  if (!clean || clean === sceneName(path)) return;
  const next = `${folderOfFile(path) ? `${folderOfFile(path)}/` : ""}${clean}${AUDIO_SCENE_SUFFIX}`;
  if ((await renameAsset(path, `${clean}${AUDIO_SCENE_SUFFIX}`)) && openPath.peek() === path) openScene(next);
}

export async function duplicateScene(path: string): Promise<void> {
  const made = await duplicateAssets([path]);
  if (made[0]) openScene(made[0]);
}

/** Delete scene files (the engine asks first); an undo toast writes them back. */
/**
 * Delete test scenes at once, without asking: the toast that follows undoes it by writing them back (D27; the
 * prototype's "Deleted <name> · Undo"), so a "can't be undone" question would be untrue. Nothing refers to a test scene,
 * so there are no references to clean. Refused (read-only, play, gone) with the reason in the status bar.
 */
export async function deleteScenes(paths: readonly string[]): Promise<void> {
  const p = currentProject.peek();
  if (!p || paths.length === 0) return;
  const name = paths.length === 1 ? sceneName(paths[0]!) : `${paths.length} scenes`;
  const refused = whyNotDeletable(p, paths);
  if (refused) return void (status.value = { kind: "info", text: `Can't delete ${name}: ${refused}.` });
  const saved = paths.map((path) => ({ path, value: loadScene(path) })).filter((x): x is { path: string; value: AudioTestScene } => x.value !== null);
  // Deleting the open scene opens the next one in the tree (the prototype's), once the files are gone.
  const next = paths.includes(openPath.peek() ?? "") ? sceneAfter(sceneEntries.peek(), paths) : null;
  if (paths.includes(openPath.peek() ?? "")) {
    stopAudition();
    openPath.value = null;
    selected.value = null;
  }
  const gone: string[] = [];
  try {
    for (const path of paths) {
      await p.deleteFile(path);
      gone.push(path);
    }
  } catch (err) {
    status.value = errorStatus(`Couldn't delete ${name}`, err);
  }
  await assetDocumentsDeleted(gone); // their open documents go, with their undo (the toast brings the scene back)
  docVersion.value++;
  if (gone.length === 0) return;
  if (next && !gone.includes(next) && openPath.peek() === null) openScene(next);
  const back = saved.filter((s) => gone.includes(s.path));
  toasts.show({
    text: `Deleted ${gone.length === 1 ? sceneName(gone[0]!) : `${gone.length} scenes`}.`,
    undo: () => {
      for (const s of back) void createAsset<AudioTestScene>(SCENE_KIND, { folder: folderOfFile(s.path), name: sceneName(s.path), value: s.value });
    },
  });
}

/** Change scenes' `folder` fields: one step on each scene's document. */
export function applyFolderChanges(changes: readonly FolderChange[], label: string): void {
  for (const c of changes) {
    const doc = docFor(c.path);
    if (!doc) continue;
    const before = doc.value.peek();
    if (before.folder !== c.folder) doc.edit({ ...before, folder: c.folder }, { label });
  }
}

// --- attenuation -----------------------------------------------------------------------------------------------------

/** Who owns emitter `id`'s attenuation. */
export function ownerOf(id: string): AttenuationOwner | null {
  const s = scene.value;
  const o = s ? findObject(s, id) : null;
  if (!o || o.kind !== "emitter") return null;
  return attenuationOwner(o.obj.sound, loadPlaylist, loadPreset);
}

/** Whether emitter `id`'s sound is traced for occlusion (false: its playlist's spatial block turns it off). */
export function occlusionOnFor(id: string): boolean {
  const s = scene.value;
  const o = s ? findObject(s, id) : null;
  return !o || o.kind !== "emitter" || occlusionOn(o.obj.sound, loadPlaylist);
}

/**
 * "Make it 3D" (J9.2): give the flat playlist emitter `id` plays a spatial block (`NEW_SPATIAL`), one step on the
 * playlist, so it is heard in place and Edit attenuation… opens. False when it isn't a flat playlist or can't change.
 */
export function makeSpatial(id: string): boolean {
  const owner = ownerOf(id);
  if (owner?.kind !== "flat") return false;
  const doc = playlistDoc(owner.playlist);
  if (!doc) return false;
  const name = owner.playlist.slice(owner.playlist.lastIndexOf("/") + 1);
  if (!writable() || doc.readOnly) {
    status.value = { kind: "info", text: `Can't make ${name} 3D: the project is read-only.` };
    return false;
  }
  const before = doc.value.peek();
  return applyEdit(setSpatial(before, { ...NEW_SPATIAL }) as EditResult<PlaylistAsset>, "Make it 3D", (next) => doc.edit(next, { label: "Make it 3D" }), before);
}

/** The emitter's distance from the active listener now (the readout's, else from the plan). */
function distanceNow(id: string): number | undefined {
  const row = voices.peek().find((r) => r.id === id);
  if (row?.distance != null) return row.distance;
  const s = scene.peek();
  const o = s ? findObject(s, id) : null;
  const p = o ? positionOf(o) : null;
  if (!s || !p) return undefined;
  const l = activeListener(s).position;
  return Math.hypot(p.x - l.x, p.y - l.y, p.z - l.z);
}

const playlistDoc = (path: string): AssetDocument<PlaylistAsset> | null => {
  const p = currentProject.peek();
  return p ? openAssetDocument<PlaylistAsset>(p, path, "playlist") : null;
};
const presetDoc = (path: string): AssetDocument<AttenuationAsset> | null => {
  const p = currentProject.peek();
  return p ? openAssetDocument<AttenuationAsset>(p, path, "attenuation") : null;
};

/** Set a playlist's attenuation (a preset path or an inline object) as one step on the playlist. */
function setPlaylistAttenuation(playlist: string, attenuation: string | Attenuation, label: string): boolean {
  const doc = playlistDoc(playlist);
  if (!doc) return false;
  const before = doc.value.peek();
  return applyEdit(setSpatial(before, { attenuation }) as EditResult<PlaylistAsset>, label, (next) => doc.edit(next, { label }), before);
}

/** "Edit attenuation…": the curve editor on the owner's attenuation; one step per Apply on the owning document. */
export function editAttenuation(id: string, doc: Document = document): void {
  const owner = ownerOf(id);
  if (!owner) return;
  const s = scene.peek();
  const name = s ? (findObject(s, id)?.obj.name ?? "") : "";
  const open = (att: Attenuation, target: string, apply: (next: Attenuation) => void) => {
    openCurveEditorDialog(doc, {
      ...attenuationDialog(att, distanceNow(id)),
      target,
      // "Distance curves · footstep · Campfire · Attenuation · metres from the listening player" (the prototype's title).
      context: `${name ? `${name} · ` : ""}Attenuation · metres from the listening player`,
      onCancel: () => {},
      onApply: (result) => apply(attenuationFromResult(att, result)),
    });
  };
  const fileName = (p: string) => p.slice(p.lastIndexOf("/") + 1).replace(/\.(playlist|attenuation)\.json$/i, "");
  if (owner.kind === "preset" && owner.attenuation) {
    const preset = owner.preset;
    open(owner.attenuation, fileName(preset), (next) => {
      const d = presetDoc(preset);
      if (!d) return;
      if (!writable() || d.readOnly) return void (status.value = { kind: "info", text: `Can't change ${fileName(preset)}: the project is read-only.` });
      d.edit({ format: ATTENUATION_FORMAT, ...next }, { label: "Edit attenuation" });
    });
  } else if (owner.kind === "inline") {
    open(owner.attenuation, fileName(owner.playlist), (next) => void setPlaylistAttenuation(owner.playlist, next, "Edit attenuation"));
  } else if (owner.kind === "none") {
    attenuationChoice.value = { emitter: id, playlist: owner.playlist };
  } else {
    status.value = { kind: "info", text: `Can't edit attenuation: ${whyNotEditAttenuation(owner) ?? "there's none to edit"}.` };
  }
}

/** The choice for a playlist without attenuation: a new shared preset it names, or inline curves; then the editor opens. */
export async function chooseAttenuation(how: "preset" | "inline", doc: Document = document): Promise<void> {
  const c = attenuationChoice.peek();
  attenuationChoice.value = null;
  if (!c) return;
  const value = newAttenuation();
  if (how === "inline") {
    if (setPlaylistAttenuation(c.playlist, value, "Inline attenuation")) editAttenuation(c.emitter, doc);
    return;
  }
  const folders = currentProject.peek()?.folders ?? [];
  const path = await createAsset<AttenuationAsset>("attenuation", { folder: folders.includes(PRESET_FOLDER) ? PRESET_FOLDER : undefined, name: presetNameFor(c.playlist), value: { format: ATTENUATION_FORMAT, ...value } });
  if (path && setPlaylistAttenuation(c.playlist, path, "Use attenuation preset")) editAttenuation(c.emitter, doc);
}

/** Apply a rolloff preset (the format's) to the owner's volume curve: one step on the owner. */
export function applyRolloff(id: string, next: (a: Attenuation) => Attenuation): void {
  const owner = ownerOf(id);
  if (!owner) return;
  if (owner.kind === "preset" && owner.attenuation) {
    const d = presetDoc(owner.preset);
    if (d && !d.readOnly) d.edit({ format: ATTENUATION_FORMAT, ...next(owner.attenuation) }, { label: "Attenuation preset" });
  } else if (owner.kind === "inline") setPlaylistAttenuation(owner.playlist, next(owner.attenuation), "Attenuation preset");
}

/** Open a playlist on the Playlists screen. */
export const openPlaylist = (path: string): void => openRoute({ screen: "playlists", asset: path });

// --- occlusion curves (ADR 0362 item 6) -------------------------------------------------------------------------------

/**
 * The Scene settings' Curves chip: the Curves window in its Occlusion mode on the curves the open scene hears (its own
 * when it keeps them, else the project's; none yet: a starting point). Apply writes them back where they came from, one
 * undo step on that document (`audio.json` or the scene file); a playing scene hears them at once.
 */
export function editOcclusionCurves(doc: Document = document): void {
  const s = scene.peek();
  const m = mix.peek();
  if (!m) return;
  const own = !!s?.settings?.occlusion?.curves;
  openCurveEditorDialog(doc, {
    ...occlusionDialog(effectiveOcclusionCurves(m, s)),
    target: OCCLUSION_TARGET,
    context: own ? `${OCCLUSION_CONTEXT} · this scene's own` : OCCLUSION_CONTEXT,
    onCancel: () => {},
    onApply: (result) => {
      const curves = occlusionFromResult(result);
      if (own) editScene("Occlusion curves", (sc) => setSceneOcclusionCurves(sc, curves));
      else editMix("Occlusion curves", (p) => setProjectOcclusionCurves(p, curves));
    },
  });
}
