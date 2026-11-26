// The Studio's debug link UI (ADR 0403, plan U4): the status bar's builds menu over the Studio's link, the Connect
// dialog it opens, the Debug link settings (the Studio has no settings page, so a small dialog), and the accept prompt
// for builds from other machines. The editor's own components, over `studioLink` instead of the editor's link. The
// Connect dialog also opens from the start screen's Connect to Game… (ADR 0380), so it's mounted apart from the menu.
import { signal } from "@preact/signals";
import { AcceptPrompt } from "../../editor/debugLink/AcceptPrompt";
import { BuildsMenu } from "../../editor/debugLink/BuildsMenu";
import { ConnectDialog } from "../../editor/debugLink/ConnectDialog";
import { OfferRoomDialog } from "../../editor/debugLink/OfferRoomDialog";
import { DebugLinkFields } from "../../editor/debugLink/DebugLinkSettings";
import { cleanPreferences } from "../../editor/debugLink/debugLinkLogic";
import { studioDebugLinkPreferences, studioLink } from "./studioLink";
import { changeTakesFolder, goLiveOnConnect } from "../shell/liveConnect";
import { chooseTakesFolder, resetTakesFolder, takesFolder, takesFolderIsDefault } from "../takesFolder";
import { projectFileSystem } from "../../editor/projectFs";
import { KitDialog } from "../../editor/ui/KitDialog";
import { Chip } from "../../editor/ui/Chip";
import { Checkbox } from "../components/Checkbox";
import { isTakesFolder } from "../../editor/projects";
import { currentProject } from "../../editor/state";
import { downloadBuildAudio } from "../runtime/buildAudioSets";
import { TAKE_PICTURE_WIDTHS, takePictureWidth, takePictureWidthOf } from "../runtime/takePictures";
import "../../editor/debugLink/debugLink.css";
import "./studioLink.css";

const connectOpen = signal(false);

/** Opens the Connect dialog (the builds menu's Connect…, the start screen's Connect to Game…, the launcher's hand-off). */
export function openStudioConnect(): void {
  goLiveOnConnect(); // ADR 0408: the build connected from here opens the Studio live on the Profiler
  connectOpen.value = true;
}

/** The Connect dialog over the Studio's link, while it's open (mounted once, at the page's root). */
export function StudioConnectDialog() {
  const link = studioLink.value;
  if (!link || !connectOpen.value) return null;
  return (
    <ConnectDialog onConnect={(target) => link.connect(target)} onClose={() => (connectOpen.value = false)}>
      {/* ADR 0408: with no project open, recordings from the build go to the takes folder (a project keeps its own). */}
      {(!currentProject.value || isTakesFolder(currentProject.value)) && <RecordingsFolderField />}
      <BuildAudioOption />
      <PictureWidthField />
    </ConnectDialog>
  );
}

/** Where the build's recordings save (the takes folder), with Change… and Use default: the dialog's own field rows. */
function RecordingsFolderField() {
  const folder = takesFolder.value;
  if (folder === null) return null;
  const change = () =>
    void projectFileSystem()
      .then((fs): Promise<unknown> | null => (fs ? (isTakesFolder(currentProject.peek()) ? changeTakesFolder(fs) : chooseTakesFolder(fs)) : null))
      .catch((err) => console.warn("[studio] couldn't choose the takes folder:", err));
  return (
    <>
      <label class="debug-link-field">
        <span>Recordings save to</span>
        <input type="text" value={folder} title={folder} readOnly spellcheck={false} />
      </label>
      <div class="dialog-option">
        <button type="button" onClick={change}>
          Change…
        </button>
        {!takesFolderIsDefault.value && (
          <button type="button" onClick={resetTakesFolder}>
            Use default
          </button>
        )}
      </div>
    </>
  );
}

/** ADR 0408: how wide the take's pictures of the game view are (sent to the build; the next take uses it). */
function PictureWidthField() {
  const width = takePictureWidthOf(takePictureWidth.value);
  return (
    <label class="debug-link-field">
      <span>Take pictures</span>
      <select value={String(width)} onChange={(e) => (takePictureWidth.value = Number(e.currentTarget.value))}>
        {TAKE_PICTURE_WIDTHS.map((w) => (
          <option key={w} value={String(w)}>
            {w} px wide
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * ADR 0410: Download the build's audio for replays (on by default). Off, it says what that costs: replays of the build's
 * takes are silent unless the take is moved into the project and opened there.
 */
function BuildAudioOption() {
  const on = downloadBuildAudio.value;
  return (
    <>
      <Checkbox checked={on} label="Download the build's audio for replays" onChange={(next) => (downloadBuildAudio.value = next)} />
      {on ? (
        <p>Takes from this build replay with its sounds, even without the project. The first connect downloads all of its audio.</p>
      ) : (
        <p role="alert">
          <Chip tone="warning">Silent replays</Chip> Replays will be silent unless the take is moved into the project and opened there.
        </p>
      )}
    </>
  );
}
const offerOpen = signal(false);
const settingsOpen = signal(false);

/** The status bar's button and menu (nothing until the link has started). */
export function StudioBuildsMenu() {
  const link = studioLink.value;
  if (!link) return null;
  return (
    <>
      <BuildsMenu
        builds={link.builds.value}
        active={link.active.value?.id ?? null}
        listen={link.state.value}
        onChoose={(id) => link.choose(id)}
        onDisconnect={(id) => link.disconnect(id)}
        onSettings={() => (settingsOpen.value = true)}
        onConnect={openStudioConnect}
        onOfferRoom={() => (offerOpen.value = true)}
      />
      {offerOpen.value && <OfferRoomDialog offer={() => link.offerRoom()} onClose={() => (offerOpen.value = false)} />}
      {settingsOpen.value && (
        <KitDialog
          title="Debug link settings"
          class="settings-dialog"
          width={520}
          onClose={() => (settingsOpen.value = false)}
          buttons={
            <button type="button" class="primary" onClick={() => (settingsOpen.value = false)}>
              Done
            </button>
          }
        >
          <DebugLinkFields value={cleanPreferences(studioDebugLinkPreferences.value)} listen={link.state.value} onChange={(next) => (studioDebugLinkPreferences.value = next)} />
        </KitDialog>
      )}
    </>
  );
}

/** The accept prompt for the first build from another machine waiting to connect. */
export function StudioDebugLinkPrompt() {
  const link = studioLink.value;
  const first = link?.pending.value[0];
  if (!link || !first) return null;
  return <AcceptPrompt build={first} more={link.pending.value.length - 1} onAccept={() => link.accept(first.id)} onRefuse={() => link.refuse(first.id)} />;
}
