// The launcher's way into Biosonic (ADR 0380): the Audio Studio's window, created or focused by Rust
// (`create_studio_window`), then handed the project over the Studio's own hand-off (`myco://studio-open`, ADR 0341),
// as the editor's Window > Audio Studio does. A project the launcher resolved is a folder or a sample.
import type { StudioOpenRequest } from "../studioAssets";
import { linkToStudio } from "../studioHandoff";
import type { OpenRequest } from "./handoff";

/** Open `request` in the Studio window; resolves once it has opened it, throws `StudioRefusal` with its reason, or `StudioTimeout`. */
export async function openInStudioWindow(request: StudioOpenRequest): Promise<void> {
  const [{ invoke }, { tauriBus }] = await Promise.all([import("@tauri-apps/api/core"), import("./handoff")]);
  // Listening before the window exists, so a window created now is heard saying it's ready.
  const link = linkToStudio(await tauriBus());
  try {
    await invoke("create_studio_window");
    await link.open(request);
  } finally {
    link.dispose();
  }
}

/** The Studio's request for a project the launcher resolved. */
export const studioRequestFor = (request: OpenRequest): StudioOpenRequest => (request.kind === "folder" ? { project: request.root } : { project: null, sample: request.id });
