// "Takes save to <folder>" with Change… and Use default (ADR 0408): the Studio's takes folder, where recordings from a
// build go when no project is open. On the start screen's Live session and in the Connect dialog. Hidden where there's
// no takes folder (a browser). Change… opens the folder dialog; `onChange` replaces it (the live session reopens its
// takes folder on the new one).
import { projectFileSystem } from "../../editor/projectFs";
import { chooseTakesFolder, resetTakesFolder, takesFolder, takesFolderIsDefault } from "../takesFolder";
import type { FileSystem } from "../../engine/platform/FileSystem";
import "./biosonic.css";

export interface TakesFolderLineProps {
  /** What Change… does with the file system (default: `chooseTakesFolder`). */
  onChange?(fs: FileSystem): Promise<unknown>;
  /** The line's words before the path (default "Takes save to"). */
  readonly label?: string;
}

export function TakesFolderLine(props: TakesFolderLineProps = {}) {
  const folder = takesFolder.value;
  if (folder === null) return null;
  const change = () =>
    void projectFileSystem()
      .then((fs) => (fs ? (props.onChange ?? chooseTakesFolder)(fs) : null))
      .catch((err) => console.warn("[biosonic] couldn't choose the takes folder:", err));
  return (
    <p class="bs-folder">
      <span class="bs-folder-label">{props.label ?? "Takes save to"}</span>
      <span class="bs-folder-path ap-mono" title={folder}>
        {folder}
      </span>
      <button type="button" class="bs-folder-button" onClick={change}>
        Change…
      </button>
      {!takesFolderIsDefault.value && (
        <button type="button" class="bs-folder-button" onClick={resetTakesFolder}>
          Use default
        </button>
      )}
    </p>
  );
}
