// Project Settings > Audio since the editor's audio panels moved to the Audio Studio (ADR 0327): the project's audio is
// `audio.json` (ADR 0330), which the Studio edits, so the category says so and opens the Studio on its Mixer screen.
import type { ProjectSettingsSectionProps } from "../../../editor/sdk";
import { openAudioStudio, studioRequest } from "../../../editor/studioLaunch";

export function AudioStudioPointer(props: ProjectSettingsSectionProps) {
  return (
    <div class="audio-studio-pointer">
      <p class="project-settings-hint">
        The project's audio (buses, returns, snapshots, ducking, parameters, voices and the spatial settings) is kept in audio.json and edited in the Audio Studio.
      </p>
      <button type="button" onClick={() => void openAudioStudio(studioRequest(props.project, { screen: "mixer" }))}>
        Open in Audio Studio
      </button>
    </div>
  );
}
