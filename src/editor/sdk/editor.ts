// The editor SDK's project and editor surface (ADR 0147): one `editor` object grouping the open
// project, asset paths, the status bar, the open scene and the scene view's tools, over the shell's
// state (state.ts), which plugins never import. Its getters track like the signals they read.
import { showPanel } from "../layout/store";
import { messages, type MessagesSurface } from "./messages";
import { assets, project, type AssetsSurface, type ProjectSurface } from "./project";
import { scene, type SceneSurface } from "./scene";
import { viewport, type ViewportSurface } from "./viewport";
import type { StudioScreen } from "../studioAssets";

export interface EditorSurface {
  /** The open project, its change version, paths and creating files. */
  readonly project: ProjectSurface;
  /** What a project path is: its kind, file name, folder, import settings; revealing and opening it. */
  readonly assets: AssetsSurface;
  /** The status bar and message log. */
  readonly messages: MessagesSurface;
  /** The open scene tabs, the node selection, play mode and undo steps. */
  readonly scene: SceneSurface;
  /** The active viewport tool and its mode (ADR 0231). */
  readonly viewport: ViewportSurface;
  /** Bring a panel to the front of its dock, opening it where it was last: a shell panel's id or a plugin panel's `id`. */
  showPanel(id: string): void;
  /**
   * @internal ADR 0341: open the Audio Studio on the open project, at a screen or an asset (the audio plugin's Project
   * Settings > Audio). Failures go to the status bar.
   */
  openAudioStudio(target?: { readonly asset?: string; readonly screen?: StudioScreen }): void;
}

/** The shell's Studio launcher, loaded on first use (it reaches the desktop shell and the browser's windows). */
function openAudioStudio(target: { readonly asset?: string; readonly screen?: StudioScreen } = {}): void {
  void import("../studioLaunch").then((m) => m.openAudioStudio(m.studioRequest(project.current, target)));
}

export const editor: EditorSurface = { project, assets, messages, scene, viewport, showPanel, openAudioStudio };
