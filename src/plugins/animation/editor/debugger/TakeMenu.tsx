// The graph editor's take menu (ADR 0348, 0373; T73): `TakePicker` over the project's `recordings/` files and the take state
// (`takeControl.ts`). A take file is read from the project's assets (a URL for a binary file) when it is opened.
import { editor } from "../../../../editor/sdk";
import { TakePicker } from "./TakeBar";
import { closeTake, openTake, openedTake, takeBusy, takeError } from "./takeControl";
import { takeSession } from "./takeSession";

/** The project's take files (`*.sporesample`), sorted. */
const takeFiles = (): string[] => (editor.project.current?.files ?? []).filter((f) => f.toLowerCase().endsWith(".sporesample"));

export function TakeMenu() {
  const project = editor.project.current;
  return (
    <TakePicker files={takeFiles()} open={openedTake.value?.path ?? null} busy={takeBusy.value} error={takeError.value} onClose={closeTake}
      onOpen={(path) => void openTake(path, async () => {
        const url = project?.assets.get(path);
        if (typeof url !== "string") throw new Error(`"${path}" isn't in the project`);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`reading "${path}" failed (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      }, takeSession)} />
  );
}
