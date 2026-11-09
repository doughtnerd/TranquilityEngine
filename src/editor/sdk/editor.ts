// The editor SDK's project and editor surface (ADR 0147): one `editor` object grouping the open
// project, asset paths, the status bar and the open scene, over the shell's state (state.ts),
// which plugins never import. Its getters track like the signals they read.
import { showPanel } from "../layout/store";
import { messages, type MessagesSurface } from "./messages";
import { assets, project, type AssetsSurface, type ProjectSurface } from "./project";
import { scene, type SceneSurface } from "./scene";

export interface EditorSurface {
  /** The open project, its change version, paths and creating files. */
  readonly project: ProjectSurface;
  /** What a project path is: its kind, file name, folder, import settings; revealing and opening it. */
  readonly assets: AssetsSurface;
  /** The status bar and message log. */
  readonly messages: MessagesSurface;
  /** The open scene tabs, the node selection and play mode. */
  readonly scene: SceneSurface;
  /** Bring a panel to the front of its dock, opening it where it was last: a shell panel's id or a plugin panel's `id`. */
  showPanel(id: string): void;
}

export const editor: EditorSurface = { project, assets, messages, scene, showPanel };
