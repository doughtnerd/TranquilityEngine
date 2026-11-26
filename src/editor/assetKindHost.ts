// The asset kind host (ADR 0233): what the editor does for every asset kind from what the kind declares. A kind
// gives its format, default folder and panel (`AssetKindContribution`); the host creates its files (the New… entry
// and `editor.assets.create`), opens them (its `open`, its panel, or the Code panel) and remembers which file each
// panel has open. The current value of a file is the asset document module's (`readAsset`), so it is one rule.
// Plugins reach all of it through `editor.assets` (sdk/project.ts).
import { signal } from "@preact/signals";
import { fileName } from "./assetBrowser";
import { isSliceEntry, splitSliceEntry } from "./assetEntry";
import { assetKind, opensInCodePanel, opensWithAudioStudio, registeredKind } from "./assetKindLookup";
import { freePath } from "./freePath";
import { showPanel } from "./layout/store";
import type { EditorProject } from "./projects";
import { readOnlyMessage } from "./readOnly";
import { isUISourcePath } from "../projectCode/uiModules";

import { assetKinds } from "./sdk/contributions";
import { messages } from "./sdk/messages";
import { currentProject, docVersion } from "./state";

/** True (after an info message naming `what`, plural) when the project is read-only (a sample). */
export function refuseReadOnly(project: EditorProject, what: string): boolean {
  if (project.canSave) return false;
  messages.info(readOnlyMessage(project, `add ${what}`));
  return true;
}

/** What `createProjectFile` writes: a new file in `folder`, named `name` or the first free "<base> 2", "<base> 3"… */
export interface CreateFileOptions {
  folder: string;
  name: string;
  /** What the file is, plural, for the read-only message: "materials", "skies". */
  what: string;
  /** Write the file's first contents at `path` (throws on failure). */
  write(project: EditorProject, path: string): Promise<void>;
  /** The status message once it's written (default "Created <file name>."). */
  created?(path: string): string;
}

/**
 * Create a file: refuses in a read-only project, picks a free name, writes it, reports success or the error in the
 * status bar and bumps the project version. Its path, or null when nothing was written.
 */
export async function createProjectFile(options: CreateFileOptions): Promise<string | null> {
  const p = currentProject.peek();
  if (!p || refuseReadOnly(p, options.what)) return null;
  const path = freePath(p, options.folder, options.name);
  try {
    await options.write(p, path);
  } catch (err) {
    messages.failed(`Couldn't create ${path}`, err);
    return null;
  }
  docVersion.value++;
  messages.info(options.created ? options.created(path) : `Created ${fileName(path)}.`);
  // UI code (ADR 0419) compiles with the scripts: a new component loads (and a UIView's field can take it) once they reload.
  if (isUISourcePath(path)) await (await import("./session")).reloadScripts();
  return path;
}


/** What `createAsset` makes. */
export interface CreateAssetOptions<T> {
  /** The folder to create it in. Absent: the kind's `folder` when the project has it, else the project root. */
  folder?: string;
  /** Its value (default: the kind's `create.value`, else its format's `empty()`). */
  value?: T;
  /** Its name without the extension (default: the kind's `create.name`, else its New… label). */
  name?: string;
}

/** Where a new file of `kind` goes when no folder is asked for: the kind's `folder` if the project has it, else the root. */
function defaultFolder(kind: string): string {
  const folder = registeredKind(kind)?.folder;
  return folder && currentProject.peek()?.folders.includes(folder) ? folder : "";
}

/**
 * Create a file of the asset kind `kind` (ADR 0233): `<name><first extension>` (or `… 2`) holding `value` written
 * with the kind's format. A kind with its own `create` writes it itself in that folder, unless a value or name is
 * given and it has a format. Its path, or null when nothing was written (read-only, a failed write, no such kind).
 */
export function createAsset<T>(kind: string, options: CreateAssetOptions<T> = {}): Promise<string | null> {
  const k = registeredKind(kind);
  const folder = options.folder ?? defaultFolder(kind);
  const create = k?.create;
  const custom = create && "create" in create ? create : null;
  if (custom && !(k?.format && ("value" in options || options.name !== undefined))) return custom.create(folder);
  if (k?.format) {
    const format = k.format;
    const name = options.name ?? (create && "what" in create ? (create.name ?? create.label) : k.label);
    const what = create && "what" in create ? create.what : `${k.label.toLowerCase()} files`;
    const value = "value" in options ? (options.value as T) : create && "what" in create && create.value ? create.value() : format.empty();
    return createProjectFile({ folder, name: `${name}${k.extensions[0]}`, what, write: (project, path) => project.writeText(path, format.format(value)) });
  }
  return Promise.resolve(null);
}

/** An entry of the Assets panel's New… menu: a registered kind's `create` (ADR 0149). */
export interface KindCreator {
  /** The kind that creates. */
  readonly kind: string;
  readonly label: string;
  /** The Create menu's submenu it goes in (ADR 0383), as the kind's `create` names it; undefined: none named. */
  readonly category?: string;
  /** Create one in the folder the Assets panel shows; at the project root, in the kind's `folder` (ADR 0233). */
  create(folder: string): Promise<string | null>;
}

/**
 * The New… menu's file entries (ADR 0149): every registered kind's `create`, in registration order (the core kinds
 * first). A disabled plugin's kinds, and so its entries, are gone.
 */
export function kindCreators(): KindCreator[] {
  void assetKinds.version.value;
  return assetKinds
    .list()
    .flatMap((k) => (k.create ? [{ kind: k.id, label: k.create.label, category: k.create.category, create: (folder: string) => createAsset(k.id, folder === "" ? {} : { folder }) }] : []));
}

/** The file each panel has open, with the project it was opened in. */
const panelFiles = signal<ReadonlyMap<string, { project: EditorProject | null; path: string }>>(new Map());

/** The file open in `panel` (ADR 0233), or null: none was opened there in the open project. Tracks. */
export function openIn(panel: string): string | null {
  const open = panelFiles.value.get(panel);
  return open && open.project === currentProject.value ? open.path : null;
}

/** Open the file at `path` as its kind says (a slice opens its file): its `open`, its panel, the Code panel, or the Audio Studio. False when it doesn't open. */
export function openAsset(path: string): boolean {
  const kind = assetKind(path);
  const file = isSliceEntry(path) ? splitSliceEntry(path).image : path;
  const k = registeredKind(assetKind(file));
  if (k?.open) {
    k.open(file);
    return true;
  }
  if (k?.panel) {
    panelFiles.value = new Map(panelFiles.peek()).set(k.panel, { project: currentProject.peek(), path: file });
    showPanel(k.panel);
    return true;
  }
  if (kind !== "sprite" && opensInCodePanel(kind)) {
    void import("./code/codeBuffers").then((m) => m.openScript(file));
    return true;
  }
  // ADR 0341: the Studio's files (playlists, samples, legacy audio events, ...) open there.
  if (opensWithAudioStudio(path)) {
    void import("./studioLaunch").then((m) => m.openAudioStudio(m.studioRequest(currentProject.peek(), { asset: file })));
    return true;
  }
  return false;
}
