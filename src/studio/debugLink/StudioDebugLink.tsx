// The Studio's debug link UI (ADR 0403, plan U4): the status bar's builds menu over the Studio's link, the Connect
// dialog it opens, the Debug link settings (the Studio has no settings page, so a small dialog), and the accept prompt
// for builds from other machines. The editor's own components, over `studioLink` instead of the editor's link.
import { signal } from "@preact/signals";
import { AcceptPrompt } from "../../editor/debugLink/AcceptPrompt";
import { BuildsMenu } from "../../editor/debugLink/BuildsMenu";
import { ConnectDialog } from "../../editor/debugLink/ConnectDialog";
import { OfferRoomDialog } from "../../editor/debugLink/OfferRoomDialog";
import { DebugLinkFields } from "../../editor/debugLink/DebugLinkSettings";
import { cleanPreferences } from "../../editor/debugLink/debugLinkLogic";
import { studioDebugLinkPreferences, studioLink } from "./studioLink";
import "../../editor/debugLink/debugLink.css";
import "./studioLink.css";

const connectOpen = signal(false);
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
        onConnect={() => (connectOpen.value = true)}
        onOfferRoom={() => (offerOpen.value = true)}
      />
      {connectOpen.value && <ConnectDialog onConnect={(target) => link.connect(target)} onClose={() => (connectOpen.value = false)} />}
      {offerOpen.value && <OfferRoomDialog offer={() => link.offerRoom()} onClose={() => (offerOpen.value = false)} />}
      {settingsOpen.value && (
        <div class="studio-link-settings" onPointerDown={(e) => e.target === e.currentTarget && (settingsOpen.value = false)}>
          <div class="dialog" role="dialog" aria-modal="true" aria-label="Debug link settings" onKeyDown={(e) => e.key === "Escape" && (settingsOpen.value = false)}>
            <DebugLinkFields value={cleanPreferences(studioDebugLinkPreferences.value)} listen={link.state.value} onChange={(next) => (studioDebugLinkPreferences.value = next)} />
            <div class="dialog-buttons">
              <button class="primary" onClick={() => (settingsOpen.value = false)}>
                Done
              </button>
            </div>
          </div>
        </div>
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
