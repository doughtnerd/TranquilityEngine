// The Spatial screen's state and actions over the real page (ADR 0333, 0327, 0335): which test scene is open (mirrored in
// the route: the file as `asset`), the selection, the tool, the camera, the elevation slab, the clipboard, and the
// audition (the test scene player in the Studio's runtime World). Scene edits go to the open scene's asset document as
// one labelled undo step each (`applyEdit`; drags coalesce into one step); scene files are made, renamed, duplicated
// and deleted through the engine's asset operations; the project settings shown here are edited on `audio.json`
// through the Mixer's document; "Edit attenuation…" edits the playlist's attenuation on its owning document. The panels
// read these signals and call these actions; the rules are the pure models beside this file.
import { computed, effect, signal } from "@preact/signals";
import { openAssetDocument, readAsset, type AssetDocument } from "../../../editor/assetDocuments";
import { deleteAssets } from "../../../editor/assetDelete";
import { createAsset } from "../../../editor/assetKindHost";
import { duplicateAssets, renameAsset } from "../../../editor/assetOps";
import { assetKinds } from "../../../editor/sdk/contributions";
import { currentProject, docVersion, status } from "../../../editor/state";
import { openCurveEditorDialog } from "../../../editor/ui/curves/openCurveEditorDialog";
import { ATTENUATION_FORMAT, type Attenuation, type AttenuationAsset } from "../../../engine/audio/attenuation/types";
import type { AudioProject } from "../../../engine/audio/project/types";
import type { PlaylistAsset } from "../../../engine/audio/playlist/types";
import { audioTestSceneToJson, emptyAudioTestScene, parseAudioTestScene, testSceneReferences } from "../../../engine/audio/spatial/testScene";
import { AUDIO_SCENE_SUFFIX, type AudioTestScene } from "../../../engine/audio/spatial/testSceneTypes";
import { World } from "../../../engine/core/World";
import { applyEdit } from "../../../plugins/audio/editor/editResult";
import { openTakeFile } from "../../../plugins/audio/runtime/capture/takeFile";
import { playAudioTestScene, type AudioTestScenePlayer, type TestSceneVoiceRow } from "../../../plugins/audio/runtime/testScene/player";
import type { SoundItem } from "../../components/soundPickerModel";
import { playlistBadge, sampleBadge } from "../../components/typeBadgeModel";
import { audioHost, openRoute, toasts } from "../../shell/studioServices";
import { openMixDocument } from "../mixer/mixerDocument";
import { setSpatial } from "../playlists/playlistEdits";
import { attenuationDialog, attenuationFromResult, attenuationOwner, newAttenuation, presetNameFor, PRESET_FOLDER, type AttenuationOwner } from "./attenuationModel";
import { NO_AUDITION, auditionScene, isSilenced, liveUpdate, toggleMute, toggleSolo, type AuditionState } from "./audition";
import { INITIAL_SLAB, type Slab } from "./elevation";
import { boundsOf, type P2 } from "./geometry";
import { blankScene, copyScene, gameScene, sceneFromTake, type NewSceneKind } from "./newScene";
import { activeListener, deleteObject, framePoints, duplicateObject, findObject, KIND_NOUN, pasteObject, positionOf, type EditResult, type SceneObject } from "./sceneEdits";
import { isScenePath, sceneName, type FolderChange, type SceneEntry } from "./sceneTree";
import { escape as escapeTool, INITIAL_TOOLS, afterPlace, place, placeLabel, type Tool, type ToolState } from "./tools";
import { DEFAULT_VIEW, fitView, type Size, type View } from "./viewTransform";
import { isSamplePath } from "../playlists/libraryModel";

// --- the scene asset kind --------------------------------------------------------------------------------------------

/** The test scene document kind (ADR 0333 `*.audioscene.json`); the Studio registers it (no plugin does). */
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

/** The project's scene files with their folders, for the Scenes tree. Tracks. */
export const sceneEntries = computed<SceneEntry[]>(() => {
  const p = project();
  void docVersion.value;
  if (!p) return [];
  return p.files.filter(isScenePath).map((path) => ({ path, folder: loadScene(path)?.folder ?? "" }));
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
  const b = s ? boundsOf(framePoints(s), 20) : null;
  view.value = b ? fitView(b, viewportSize.peek()) : DEFAULT_VIEW;
}

// --- audition --------------------------------------------------------------------------------------------------------

let player: AudioTestScenePlayer | null = null;
/** The scene the running player was built from (as auditioned). */
let played: AudioTestScene | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let follow: (() => void) | null = null;
/** How often the Voices table and the rays are read, ms. */
export const VOICES_POLL_MS = 250;

/**
 * The Studio runtime's World, while the runtime can play: the Engine the Studio starts (`engineRuntime.ts`) is the page's
 * only one and keeps its World current (`World.active`), as the test scene player's own tests reach it.
 * TODO(ADR 0327): a `world` on the runtime host would make this a seam instead of the current-World lookup.
 */
function studioWorld(): World | null {
  if (!audioHost().playable.peek()) return null;
  return World.active;
}

function build(s: AudioTestScene): boolean {
  const world = studioWorld();
  if (!world) return false;
  const a = auditionScene(s, audition.peek());
  try {
    player = playAudioTestScene(world, a);
  } catch (err) {
    status.value = { kind: "error", text: `Couldn't play the scene: ${err instanceof Error ? err.message : String(err)}` };
    player = null;
    return false;
  }
  played = a;
  return true;
}

/** Play the open scene from its active listener (the screen's Play). */
export function playScene(): void {
  const s = scene.peek();
  if (!s || playing.peek()) return;
  const host = audioHost();
  if (!host.playable.peek()) {
    const st = host.state.peek();
    status.value = { kind: "info", text: st.kind === "failed" ? st.reason : "The Studio's audio runtime isn't running yet." };
    return;
  }
  if (!build(s)) {
    status.value = { kind: "info", text: "The Studio's audio runtime has no World to play the scene in yet." };
    return;
  }
  if (s.base) status.value = { kind: "info", text: `Playing without ${s.base} underneath: the Studio doesn't load game scenes into its runtime yet.` };
  playing.value = true;
  poll = setInterval(() => {
    try {
      voices.value = player?.voices() ?? [];
    } catch {
      voices.value = [];
    }
  }, VOICES_POLL_MS);
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
      if (!build(next)) stopAudition();
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
  if (poll) clearInterval(poll);
  poll = null;
  player?.dispose();
  player = null;
  played = null;
  playing.value = false;
  voices.value = [];
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
  const name = `${path.slice(path.lastIndexOf("/") + 1).replace(/\.mycotake$/i, "")} @ ${Math.floor(t / 60)}m${String(Math.floor(t % 60)).padStart(2, "0")}s`;
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
export async function deleteScenes(paths: readonly string[]): Promise<void> {
  const saved = paths.map((path) => ({ path, value: loadScene(path) })).filter((x): x is { path: string; value: AudioTestScene } => x.value !== null);
  if (!(await deleteAssets(paths))) return;
  if (paths.includes(openPath.peek() ?? "")) {
    stopAudition();
    openPath.value = null;
    selected.value = null;
  }
  const name = paths.length === 1 ? sceneName(paths[0]!) : `${paths.length} scenes`;
  toasts.show({
    text: `Deleted ${name}.`,
    undo: () => {
      for (const s of saved) void createAsset<AudioTestScene>(SCENE_KIND, { folder: folderOfFile(s.path), name: sceneName(s.path), value: s.value });
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
      title: "Attenuation",
      target,
      context: name ? `Heard by ${name}` : undefined,
      onCancel: () => {},
      onApply: (result) => apply(attenuationFromResult(att, result)),
    });
  };
  const fileName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
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
    status.value = { kind: "info", text: owner.kind === "preset" ? `The attenuation preset ${fileName(owner.preset)} isn't in the project.` : "This emitter's sound has no attenuation to edit." };
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
