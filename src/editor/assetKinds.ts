// Asset kinds (ADR 0133, 0134): which kind a project file is, and the editor's own kinds. Every kind is
// an `AssetKindContribution` in the `assetKinds` registry: the core asset kinds below (scenes, prefabs,
// images, sprite slices, audio, render textures, the code and text kinds, and plain files) are
// registered at boot before the first-party plugins activate (`plugins/editorBoot.ts`, and the Vitest
// setup), and plugins add theirs. Every question about a kind (label, icon, opening, Inspector,
// preview, field kinds, adding to a scene, import settings) is asked of its contribution; there are
// no other tables. Light on purpose (registry, pure node entries, lazy opens), so the Vitest setup
// can register the core kinds for every test file.
import { assetKinds, type AssetKindContribution } from "./sdk/contributions";
import { audioNodeEntry, prefabInstanceEntry, spriteNodeEntry } from "./assetNodeEntries";

/** The ids of the core asset kinds. */
export type CoreAssetKind = "scene" | "prefab" | "image" | "sprite" | "audio" | "rendertexture" | "json" | "script" | "javascript" | "typescript" | "text" | "xml" | "other";
/** A core kind or a plugin's kind id. */
export type AssetKind = CoreAssetKind | (string & {});

/**
 * The registered kind of `path`: the one whose extension is the longest ending of it (case-insensitive;
 * of equal ones, the last registered). A slice entry (`images/a.png#walk_0`) is a sprite if its file is
 * an image. Undefined for a file no kind claims (a plain file, `other`). Reads `assetKinds.version`, so
 * callers in components re-render on (un)registration.
 */
export function assetKindFor(path: string): AssetKindContribution | undefined {
  void assetKinds.version.value;
  const hash = path.indexOf("#");
  if (hash >= 0) return assetKindFor(path.slice(0, hash))?.id === "image" ? assetKinds.get("sprite") : undefined;
  const p = path.toLowerCase();
  const nameLength = p.length - p.lastIndexOf("/") - 1;
  let best: AssetKindContribution | undefined;
  let bestLength = 0;
  for (const kind of assetKinds.list()) {
    for (const ext of kind.extensions) {
      const e = ext.toLowerCase();
      // The ending must follow a name: a dotfile such as `.env` is no environment map.
      if (p.endsWith(e) && nameLength > e.length && e.length >= bestLength) {
        best = kind;
        bestLength = e.length;
      }
    }
  }
  return best;
}

/** The id of `path`'s kind (`assetKindFor`), `other` for a file no kind claims. */
export const assetKind = (path: string): AssetKind => assetKindFor(path)?.id ?? "other";

/** The registered kind with this id, or undefined (also reads `assetKinds.version`). */
export function assetKindInfo(id: string): AssetKindContribution | undefined {
  void assetKinds.version.value;
  return assetKinds.get(id);
}

/** True if files of a kind open in the Code panel: its `codeEditor` policy (scripts, JSON, text; UI documents and stylesheets, ADR 0140). */
export const opensInCodePanel = (kind: AssetKind | "folder") => assetKindInfo(kind)?.codeEditor === true;

// --- the core asset kinds -------------------------------------------------------------------------

/** Brackets and a slash: source code. */
const CODE_ICON = "M9 8l-4 4 4 4M15 8l4 4-4 4M13 6l-2 12";
/** A page with a folded corner. */
const FILE_ICON = "M7 3h7l5 5v13H7zM14 3v5h5";

// Opening loads its module on first use: they pull in the editor's state, which this module stays clear of.
const openScene = (path: string) => void import("./session").then((m) => m.switchScene(path));
const openSpriteEditor = (image: string) => void import("./assetImport").then((m) => m.openSpriteEditor(image));
/** A code or text kind: opens in the Code panel. */
const codeKind = (id: CoreAssetKind, label: string, extensions: readonly string[], icon = CODE_ICON): AssetKindContribution => ({ id, label, extensions, icon, codeEditor: true });

/** The editor's own asset kinds, registered by `registerCoreAssetKinds`. */
export const CORE_ASSET_KINDS: readonly AssetKindContribution[] = [
  {
    id: "scene",
    extensions: [".scene.json"],
    label: "Scene",
    icon: "M4 5h16v14H4zM4 15l4.5-4.5 3.5 3.5 2.5-2.5L20 17M15.5 8.5h.01",
    open: openScene,
    referencedAs: ["scene"],
    preview: "scene",
    addToScene: { instance: true, nodes: (doc, path, position) => [prefabInstanceEntry(doc, path, position)] },
  },
  {
    id: "prefab",
    extensions: [".prefab.json"],
    label: "Prefab",
    icon: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
    open: openScene,
    inspector: () => import("./ui/AssetInspector").then((m) => m.PreviewInspector),
    referencedAs: ["prefab"],
    preview: "prefab",
    addToScene: { instance: true, nodes: (doc, path, position) => [prefabInstanceEntry(doc, path, position)] },
  },
  {
    id: "image",
    extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"],
    label: "Image",
    // Images show themselves; this draws while one loads.
    icon: FILE_ICON,
    open: openSpriteEditor,
    referencedAs: ["texture", "sprite"],
    addToScene: { nodes: (doc, path, position) => [spriteNodeEntry(doc, path, position)] },
    importSettings: "image",
  },
  {
    // A slice of an image (ADR 0040), `images/sheet.png#walk_0`: no file name of its own (`assetKindFor`).
    id: "sprite",
    extensions: [],
    label: "Sprite",
    icon: FILE_ICON,
    open: (entry) => openSpriteEditor(entry.slice(0, entry.indexOf("#"))),
    referencedAs: ["sprite"],
    addToScene: { nodes: (doc, path, position) => [spriteNodeEntry(doc, path, position)] },
  },
  {
    id: "audio",
    extensions: [".mp3", ".ogg", ".wav"],
    label: "Audio",
    icon: "M9 17V6l10-2v11M9 17a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 15a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
    referencedAs: ["audio"],
    preview: "audio",
    addToScene: { nodes: (doc, path, position) => [audioNodeEntry(doc, path, position)] },
    importSettings: "audio",
  },
  {
    id: "rendertexture",
    extensions: [".rendertexture.json"],
    label: "Render Texture",
    icon: "M4 5h16v14H4zM8 9h8v6H8zM4 5l4 4M20 5l-4 4M4 19l4-4M20 19l-4-4",
    inspector: () => import("./ui/RenderTextureInspector").then((m) => m.RenderTextureInspector),
    referencedAs: ["rendertexture"],
  },
  codeKind("json", "JSON", [".json"], "M9 4H8a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1M15 4h1a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-1"),
  codeKind("script", "Script", [".ts"]),
  codeKind("javascript", "JS", [".js", ".mjs", ".cjs"]),
  codeKind("typescript", "TS Module", [".mts", ".cts"]),
  codeKind("text", "Text", [".md", ".txt"], "M7 3h7l5 5v13H7zM14 3v5h5M10 12h6M10 15h6M10 18h4"),
  codeKind("xml", "XML", [".xml"]),
  // Any other file. Its one extension keeps declaration files (`.d.ts`) from being scripts.
  { id: "other", extensions: [".d.ts"], label: "File", icon: FILE_ICON },
];

let coreRegistered = false;

/** Register the core asset kinds, once (`plugins/editorBoot.ts` at startup, `plugins/testSetup.ts` for tests). They are never unregistered. */
export function registerCoreAssetKinds(): void {
  if (coreRegistered) return;
  coreRegistered = true;
  for (const kind of CORE_ASSET_KINDS) assetKinds.register(kind);
}
