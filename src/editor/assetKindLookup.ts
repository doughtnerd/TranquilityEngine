// The asset kind module (ADR 0133, 0134, 0143): what a project file is and what it can do, answered
// from the registered asset kinds alone. Core kinds register from `assetKinds.builtin.ts`, plugins'
// through their context; nothing here knows a kind by name except the three it answers itself:
// `folder` (a folder entry), `sprite` (a `#slice` entry of a kind with `slices`, ADR 0149) and `other`
// (no match), and `image` for the panorama field rule below.
// Light on imports (no editor state), so `assetBrowser.ts` and `thumbnails/keys.ts` can both use it.
import { isSidecarPath } from "../engine/scene/importSettings";
import { assetKinds, type AssetKindContribution, type AssetSceneNodes, type AssetThumbnail, type ImportSettingsContribution, type LoadComponent } from "./sdk/contributions";

/** The kinds the editor shell registers (ADR 0143) and the ones this module answers itself. */
export type CoreAssetKind = "scene" | "prefab" | "image" | "sprite" | "audio" | "rendertexture" | "json" | "script" | "javascript" | "typescript" | "text" | "xml" | "other";
/** A core kind or a registered one's id. */
export type AssetKind = CoreAssetKind | (string & {});
/** A preview by name: a rendered thumbnail's id (`AssetThumbnail.id`, ADR 0156), or `"audio"`. */
export type PreviewKind = "audio" | (string & {});

/** The core image kind, for the one field rule that takes some of its files (panoramas). */
const IMAGE_KIND = "image";
/** Endings that are no kind even though a shorter ending is: type declarations aren't scripts. */
const NOT_A_KIND: readonly string[] = [".d.ts"];

const FILE_ICON = "M7 3h7l5 5v13H7zM14 3v5h5";
const FOLDER_ICON = "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z";
/** What the module answers for the kinds nobody registers. */
const OWN: Record<"folder" | "sprite" | "other", { label: string; icon: string }> = {
  folder: { label: "Folder", icon: FOLDER_ICON },
  sprite: { label: "Sprite", icon: FILE_ICON },
  other: { label: "File", icon: FILE_ICON },
};

/** The registered kind with this id, or undefined. Reads `assetKinds.version`, so callers in components re-render on (un)registration. */
export function registeredKind(id: string): AssetKindContribution | undefined {
  void assetKinds.version.value;
  return assetKinds.get(id);
}

/**
 * The kind of a project path: the registered kind whose extension is the longest ending of the
 * file name (case-insensitive; a tie goes to the later registration, so a plugin's kind wins over a
 * core one). A dotfile (`.env`) is no match; a `#slice` entry of an image is `sprite`; no match is `other`.
 */
export function assetKind(path: string): AssetKind {
  const hash = path.indexOf("#");
  if (hash >= 0) return hasSlices(assetKind(path.slice(0, hash))) ? "sprite" : "other";
  void assetKinds.version.value;
  const p = path.toLowerCase();
  const nameLength = p.length - p.lastIndexOf("/") - 1;
  // The ending must follow a name: a dotfile such as `.env` is no environment map.
  const matches = (e: string) => p.endsWith(e) && nameLength > e.length;
  let best: { id: string; length: number } | null = null;
  for (const kind of assetKinds.list()) {
    for (const ext of kind.extensions) {
      const e = ext.toLowerCase();
      if (matches(e) && (!best || e.length >= best.length)) best = { id: kind.id, length: e.length };
    }
  }
  if (best && NOT_A_KIND.some((e) => matches(e) && e.length > best!.length)) return "other";
  return best?.id ?? "other";
}

/** True if a kind's files can be cut into slices (its `slices` capability, ADR 0040, 0149): their `#slice` entries are sprites. */
export const hasSlices = (kind: AssetKind | "folder"): boolean => registeredKind(kind)?.slices === true;

/** The registered kind the entry at `path` asks for what it can do: its own, or for a slice its file's. */
function behaviourAt(path: string): AssetKindContribution | undefined {
  const hash = path.indexOf("#");
  return registeredKind(assetKind(hash >= 0 ? path.slice(0, hash) : path));
}
/** The registered kind a kind asks for what it can do: its own, or for `sprite` the first kind with slices (use `behaviourAt` when the path is known). */
function behaviourOf(kind: AssetKind | "folder"): AssetKindContribution | undefined {
  if (kind !== "sprite") return registeredKind(kind);
  void assetKinds.version.value;
  return assetKinds.list().find((k) => k.slices);
}

/** A kind's label in the Assets panel ("Scene", "Particle Effect"; "File" for `other`). */
export function kindLabel(kind: AssetKind | "folder"): string {
  if (kind in OWN) return OWN[kind as keyof typeof OWN].label;
  return registeredKind(kind)?.label ?? kind;
}

/** A kind's icon: an SVG path drawn stroked in a 24×24 box (a file for kinds without one). */
export function kindIcon(kind: AssetKind | "folder"): string {
  if (kind in OWN) return OWN[kind as keyof typeof OWN].icon;
  return registeredKind(kind)?.icon ?? FILE_ICON;
}

/** True if a kind's files open in the Code panel (`codeEditor` without `open`, ADR 0140). */
export function opensInCodePanel(kind: AssetKind | "folder"): boolean {
  const k = registeredKind(kind);
  return k?.codeEditor === true && k.open === undefined;
}

/** True if opening (double-clicking) the file at `path` does something: its kind has `open`, opens in the Code panel, or it is a slice of an image that opens. */
export function kindOpens(path: string): boolean {
  const k = behaviourAt(path);
  return k?.open !== undefined || (!path.includes("#") && opensInCodePanel(assetKind(path)));
}

/** Open the file at `path` as its kind says (a slice opens its image). False when its kind doesn't open. */
export function openAsset(path: string): boolean {
  const kind = assetKind(path);
  const k = behaviourAt(path);
  const file = kind === "sprite" ? path.slice(0, path.indexOf("#")) : path;
  if (k?.open) {
    k.open(file);
    return true;
  }
  if (kind !== "sprite" && opensInCodePanel(kind)) {
    void import("./code/codeState").then((m) => m.openScript(file));
    return true;
  }
  return false;
}

/** What adding a file of this kind to a scene makes, if anything (a sprite adds as its image does). */
export const sceneNodesOf = (kind: AssetKind): AssetSceneNodes | undefined => behaviourOf(kind)?.addToScene;

/** What adding the entry at `path` to a scene makes, if anything (a slice adds as its file does). */
export const sceneNodesAt = (path: string): AssetSceneNodes | undefined => behaviourAt(path)?.addToScene;

/** True if the file at `path` has a scene node to become. */
export const canAddToScene = (path: string): boolean => sceneNodesAt(path) !== undefined;

/** An entry of the Assets panel's New… menu: a registered kind's `create` (ADR 0149). */
export interface KindCreator {
  /** The kind that creates. */
  readonly kind: string;
  readonly label: string;
  create(folder: string): Promise<string | null>;
}

/**
 * The New… menu's file entries (ADR 0149): every registered kind's `create`, in registration order
 * (the core kinds first). A disabled plugin's kinds, and so its entries, are gone.
 */
export function kindCreators(): KindCreator[] {
  void assetKinds.version.value;
  return assetKinds.list().flatMap((k) => (k.create ? [{ kind: k.id, label: k.create.label, create: (folder: string) => k.create!.create(folder) }] : []));
}

/** A kind's own Inspector view, if it has one. */
export const kindInspector = (kind: AssetKind): LoadComponent<{ path: string }> | undefined => registeredKind(kind)?.inspector;

/** A kind's import settings (ADR 0040), if it has them and no Inspector view of its own. */
export function kindImportSettings(kind: AssetKind): ImportSettingsContribution | undefined {
  const k = registeredKind(kind);
  return k?.inspector ? undefined : k?.importSettings;
}

/** The preview the file at `path` gets (a rendered thumbnail's or `"audio"`), or undefined: slices and sidecars have none. */
function previewAt(path: string): AssetKindContribution["preview"] {
  if (path.includes("#") || isSidecarPath(path.toLowerCase())) return undefined;
  return registeredKind(assetKind(path))?.preview;
}

/** The file at `path`'s preview: its thumbnail's id ("model", "sky"), `"audio"`, or null for none. */
export function previewOf(path: string): PreviewKind | null {
  const preview = previewAt(path);
  return preview === undefined ? null : preview === "audio" ? "audio" : preview.id;
}

/** The rendered thumbnail of the file at `path` (its kind's stage, ADR 0156), or null: audio, slices and sidecars have none. */
export function thumbnailOf(path: string): AssetThumbnail | null {
  const preview = previewAt(path);
  return preview && preview !== "audio" ? preview : null;
}

/** The field kinds (ADR 0131) a kind's files satisfy: its `referencedAs` (a sprite's are `sprite`). */
export function fieldKindsOf(kind: AssetKind): readonly string[] {
  if (kind === "sprite") return ["sprite"];
  return registeredKind(kind)?.referencedAs ?? [];
}

/**
 * Field kinds whose files are not those of whole asset kinds, kept as core rules (ADR 0143): a mesh
 * is a file of any kind referenced as a model (and a built-in mesh, `assetFieldKinds.ts`); panoramas
 * are PNG and JPEG images; a baked `.env` is one ending of the Environment plugin's kind; fonts and
 * navigation bakes have no asset kind of their own.
 */
const CORE_FIELD_RULES: Readonly<Record<string, (path: string, kind: AssetKind) => boolean>> = {
  mesh: (_, kind) => fieldKindsOf(kind).includes("model"),
  environment: (path, kind) => kind === IMAGE_KIND && /\.(png|jpe?g)$/i.test(path),
  envmap: (path, kind) => kind === "environment" && /\.env$/i.test(path),
  font: (path) => /\.(ttf|otf|woff2?)$/i.test(path),
  navbake: (path) => /\.nav\.bin$/i.test(path),
};

/** True if the file at `path` suits field kind `fieldKind`: its kind declares it, or a core rule takes it. */
export function satisfiesFieldKind(fieldKind: string, path: string): boolean {
  const kind = assetKind(path);
  return fieldKindsOf(kind).includes(fieldKind) || CORE_FIELD_RULES[fieldKind]?.(path, kind) === true;
}

/** True if some registered kind, or a core rule, can satisfy field kind `fieldKind`. */
export function fieldKindKnown(fieldKind: string): boolean {
  void assetKinds.version.value;
  return fieldKind in CORE_FIELD_RULES || assetKinds.list().some((k) => k.referencedAs?.includes(fieldKind));
}
