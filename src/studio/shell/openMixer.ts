// "Open in Mixer" from the Profiler and the Take screen (ADR 0408, 0410): the Mixer, with a bus selected when one is
// named. In a takes folder the Mixer shows the build's downloaded audio, so with none mounted it says what's missing.
import { isTakesFolder } from "../../editor/projects";
import { currentProject, status } from "../../editor/state";
import { mountedAudioProject } from "./audioProject";
import { openRoute } from "./studioServices";

/** Opens the Mixer (with `bus` selected), or says why it can't show one in a takes folder. */
export function openMixer(bus?: string): void {
  if (isTakesFolder(currentProject.peek()) && !mountedAudioProject.peek()) {
    status.value = { kind: "info", text: "The Mixer needs the game's audio: open the take in its project, or connect to its build with Download the build's audio on." };
    return;
  }
  openRoute(bus ? { screen: "mixer", select: bus } : { screen: "mixer" });
}
