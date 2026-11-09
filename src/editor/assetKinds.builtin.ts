// The core asset kinds (ADR 0143): scenes, prefabs, images, audio, render textures, scripts and the
// plain text files, registered through the same `AssetKindContribution` plugins use, the way
// `ui/inspectorSections.builtin.ts` registers the built-in Inspector sections. They are Core, not a
// plugin (GLOSSARY.md): they can't be disabled and appear in no manifest. `main.tsx` registers them
// at boot; tests that resolve kinds call `useCoreAssetKinds()` (`testing/coreAssetKinds.ts`).
// Views load on first use (ADR 0083); scene switching loads with the session.
import { audioNodeEntry, prefabInstanceEntry, spriteNodeEntry } from "./assetBrowser";
import { openSpriteEditor } from "./assetImport";
import { assetKinds, type AssetKindContribution } from "./sdk/contributions";

const CODE_ICON = "M9 8l-4 4 4 4M15 8l4 4-4 4M13 6l-2 12";
const FILE_ICON = "M7 3h7l5 5v13H7zM14 3v5h5";

const switchScene = (path: string) => void import("./session").then((m) => m.switchScene(path));

/** Every core kind, in the order they register. */
export const CORE_ASSET_KINDS: readonly AssetKindContribution[] = [
  {
    id: "scene",
    extensions: [".scene.json"],
    label: "Scene",
    icon: "M4 5h16v14H4zM4 15l4.5-4.5 3.5 3.5 2.5-2.5L20 17M15.5 8.5h.01",
    open: switchScene,
    referencedAs: ["scene"],
    preview: "scene",
    addToScene: { keepsOwnPosition: true, nodes: (doc, path, position) => [prefabInstanceEntry(doc, path, position)] },
  },
  {
    id: "prefab",
    extensions: [".prefab.json"],
    label: "Prefab",
    icon: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
    open: switchScene,
    inspector: () => import("./ui/PrefabInspector").then((m) => m.PrefabInspector),
    referencedAs: ["prefab"],
    preview: "prefab",
    addToScene: { keepsOwnPosition: true, nodes: (doc, path, position) => [prefabInstanceEntry(doc, path, position)] },
  },
  {
    id: "image",
    extensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"],
    label: "Image",
    icon: FILE_ICON, // images show themselves; the icon shows only while one loads
    open: (path) => openSpriteEditor(path),
    referencedAs: ["texture", "sprite"],
    addToScene: { nodes: (doc, path, position) => [spriteNodeEntry(doc, path, position)] },
    importSettings: {
      preview: () => import("./ui/ImageImportSettings").then((m) => m.ImagePreview),
      view: () => import("./ui/ImageImportSettings").then((m) => m.ImageImportSettings),
    },
  },
  {
    id: "audio",
    extensions: [".mp3", ".ogg", ".wav"],
    label: "Audio",
    icon: "M9 17V6l10-2v11M9 17a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 15a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
    referencedAs: ["audio"],
    preview: "audio",
    addToScene: { nodes: (doc, path, position) => [audioNodeEntry(doc, path, position)] },
    importSettings: {
      preview: () => import("./ui/AssetPreview").then((m) => m.AudioPreview),
      view: () => import("./ui/AudioImportSettings").then((m) => m.AudioImportSettings),
    },
  },
  {
    // Here until it moves to a plugin (ADR 0143 open question).
    id: "rendertexture",
    extensions: [".rendertexture.json"],
    label: "Render Texture",
    icon: "M4 5h16v14H4zM8 9h8v6H8zM4 5l4 4M20 5l-4 4M4 19l4-4M20 19l-4-4",
    inspector: () => import("./ui/RenderTextureInspector").then((m) => m.RenderTextureInspector),
    referencedAs: ["rendertexture"],
  },
  { id: "json", extensions: [".json"], label: "JSON", icon: "M9 4H8a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1M15 4h1a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-1", codeEditor: true },
  { id: "xml", extensions: [".xml"], label: "XML", icon: CODE_ICON, codeEditor: true },
  { id: "script", extensions: [".ts"], label: "Script", icon: CODE_ICON, codeEditor: true }, // `.d.ts` is no script (the asset kind module)
  { id: "javascript", extensions: [".js", ".mjs", ".cjs"], label: "JS", icon: CODE_ICON, codeEditor: true },
  { id: "typescript", extensions: [".mts", ".cts"], label: "TS Module", icon: CODE_ICON, codeEditor: true },
  { id: "text", extensions: [".md", ".txt"], label: "Text", icon: "M7 3h7l5 5v13H7zM14 3v5h5M10 12h6M10 15h6M10 18h4", codeEditor: true },
];

/** Register the core kinds. Returns a function that removes them again (for tests). */
export function registerCoreAssetKinds(): () => void {
  const undo = CORE_ASSET_KINDS.map((kind) => assetKinds.register(kind));
  return () => undo.forEach((u) => u());
}
