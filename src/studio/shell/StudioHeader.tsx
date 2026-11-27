// The Studio's header (ADR 0341 "The shell"): the app's name and project (or takes folder, ADR 0408, whose header
// offers only Take and Profiler), the screens in their groups (Author, Mix,
// Run, Ship; Ctrl/⌘+1…8), the preview-language chip (ADR 0354 §1), Undo, Redo and History over the active history, the
// shortcut list, and the output-device menu.
import { art } from "../../editor/brand";
import { HistoryPopover } from "../../editor/ui/HistoryPopover";
import { formatKeys, isMacPlatform } from "../../editor/ui/keyCombo";
import { AudioDeviceMenu } from "../components/AudioDeviceMenu";
import { Icon } from "../components/Icon";
import { ProjectPreviewChip } from "../screens/dialogue/PreviewLanguageChip";
import { isCalibrated, offsetsFor, withOffset } from "../components/deviceOffsets";
import { outputDevice, outputDevices } from "./outputDevice";
import { screenGroups, type ScreenId } from "./screens";
import { audioHost, deviceOffsets, shortcutsOpen } from "./studioServices";

export interface StudioHeaderProps {
  readonly screen: ScreenId;
  readonly projectName: string;
  readonly readOnly?: boolean;
  /** ADR 0408: the only screens on offer (a takes folder workspace); the others show disabled. Absent: all. */
  readonly onlyScreens?: ReadonlySet<ScreenId>;
  /** What the project button closes ("the project", "the takes folder"). */
  readonly closeNoun?: string;
  onScreen(screen: ScreenId): void;
  onCloseProject(): void;
}

export function StudioHeader(props: StudioHeaderProps) {
  const mac = isMacPlatform();
  const device = outputDevice().value;
  const host = audioHost();
  const stats = host.stats.value; // re-render as the runtime's figures change
  const live = host.playable.value;
  const store = deviceOffsets.value;
  let stale = false;
  try {
    stale = live && host.audio.calibrationStale;
  } catch {
    stale = false;
  }
  return (
    <header class="studio-header">
      <div class="studio-brand">
        <img class="studio-logo" src={art.biosonicIcon} alt="" aria-hidden="true" />
        <span class="studio-app-name">Audio Studio</span>
        <button class="studio-project" aria-label={`${props.projectName}${props.readOnly ? ", read-only" : ""}: close ${props.closeNoun ?? "the project"}`} title={`${props.projectName}${props.readOnly ? " (read-only)" : ""} · Close ${props.closeNoun ?? "the project"}`} onClick={props.onCloseProject}>
          <span class="studio-project-name">{props.projectName}</span>
          {props.readOnly && (
            <span class="studio-readonly">
              <Icon name="lock" size={12} />
              <span class="studio-readonly-text">read-only</span>
            </span>
          )}
        </button>
      </div>
      <nav class="studio-nav" aria-label="Studio screens">
        {screenGroups().map((g) => (
          <div key={g.group} class="studio-nav-group" role="group" aria-label={g.title} title={g.title}>
            <span class="studio-nav-sep" aria-hidden="true" />
            {g.screens.map((s) => props.onlyScreens && !props.onlyScreens.has(s.id) ? (
              <span key={s.id} class="studio-tab off" role="link" aria-disabled="true" title={`Open a project to use ${s.title}`}>
                <Icon name={s.icon} />
                <span class="studio-tab-label">{s.title}</span>
              </span>
            ) : (
              <a
                key={s.id}
                href={`#/${s.id}`}
                class={`studio-tab${s.id === props.screen ? " on" : ""}`}
                aria-current={s.id === props.screen ? "page" : undefined}
                title={`${s.title} (${formatKeys(`Mod+${s.digit}`, mac)})`}
                aria-keyshortcuts={`${mac ? "Meta" : "Control"}+${s.digit}`}
                onClick={(e) => {
                  e.preventDefault();
                  props.onScreen(s.id);
                }}
              >
                <Icon name={s.icon} />
                <span class="studio-tab-label">{s.title}</span>
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div class="studio-header-tools">
        <ProjectPreviewChip />
        <HistoryPopover none="Click into a document to undo its edits" />
        <button class="kit-icon-button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" aria-keyshortcuts="?" onClick={() => (shortcutsOpen.value = true)}>
          <Icon name="keyboard" />
        </button>
        <AudioDeviceMenu
          deviceName={device.name}
          devices={outputDevices().value}
          bufferMs={stats?.bufferMs ?? null}
          sampleRate={stats?.sampleRate ?? null}
          offsets={offsetsFor(store, device.id)}
          calibrated={isCalibrated(store, device.id)}
          stale={stale}
          latencyMs={stats?.latencyMs ?? null}
          onOffset={(kind, ms) => (deviceOffsets.value = withOffset(deviceOffsets.peek(), device.id, kind, ms))}
        />
      </div>
    </header>
  );
}
