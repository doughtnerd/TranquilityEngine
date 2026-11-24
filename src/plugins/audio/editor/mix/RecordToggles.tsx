// ADR 0348: Record take and Record capture on the Play toolbar (the Audio plugin's `registerPlayToolbarItem`). Each is
// a toggle over `RecordToggle` (`recordToggleModel.ts`): enabled while playing, it records through `Audio.take` or
// `Audio.capture` and writes the file into the project's `recordings/` folder when pressed again or when Play
// stops.
import { editor } from "../../../../editor/sdk";
import { audioTake, takeFileBytes } from "../../runtime/capture/take";
import { audioCapture, captureFileBytesNow } from "../../runtime/capture/capture";
import { RecordToggle, type RecordKind, type RecordToggleSeams } from "./recordToggleModel";
import { RecordButton } from "./RecordButton";

/** The project write both toggles use: a new file through the editor (read-only projects refuse, the status bar reports). */
function writeIntoProject(kind: RecordKind): RecordToggleSeams["write"] {
  return (path, bytes) => {
    const slash = path.lastIndexOf("/");
    return editor.project.createFile({
      folder: path.slice(0, slash),
      name: path.slice(slash + 1),
      what: kind === "take" ? "takes" : "captures",
      write: (project, at) => project.writeBinary(at, bytes),
      created: (at) => `Saved ${at}.`,
    });
  };
}

const files = (): readonly string[] => editor.project.peek()?.files ?? [];

/** One model per kind for the page: the toolbar may re-mount, the recording goes on. */
const toggles: Record<RecordKind, RecordToggle> = {
  take: new RecordToggle("take", { recorder: audioTake, bytes: takeFileBytes, files, write: writeIntoProject("take") }),
  capture: new RecordToggle("capture", { recorder: audioCapture, bytes: captureFileBytesNow, files, write: writeIntoProject("capture") }),
};

/** Both toggles, for the Play toolbar. */
export function RecordToggles() {
  const playing = editor.scene.playState === "playing";
  return (
    <>
      <RecordButton model={toggles.take} playing={playing} label="Record take" />
      <RecordButton model={toggles.capture} playing={playing} label="Record capture" />
    </>
  );
}
