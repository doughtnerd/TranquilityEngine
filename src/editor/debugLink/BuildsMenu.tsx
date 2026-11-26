// The connected-builds menu (ADR 0376): a status bar button that counts the builds connected through the debug link,
// opening a menu to pick the build the live debuggers read, disconnect one, or open the link's settings. `BuildsMenu`
// is the view; `DebugLinkBuilds` connects it to the editor's link.
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { usePopover } from "../ui/popover";
import { buildLabel, buildsButtonText, type BuildEntry } from "./debugLinkLogic";
import type { ListenState } from "./editorLink";
import { ConnectDialog } from "./ConnectDialog";
import { OfferRoomDialog } from "./OfferRoomDialog";
import { editorDebugLink } from "./link";
import { PlayBuildSlot } from "./playBuild";
import "./debugLink.css";
import { EmptyState } from "../ui/EmptyState";

export interface BuildsMenuProps {
  readonly builds: readonly BuildEntry[];
  /** The build the debuggers read. */
  readonly active: number | null;
  readonly listen: ListenState;
  onChoose(id: number | null): void;
  onDisconnect(id: number): void;
  onSettings(): void;
  /**
   * Opens the Connect dialog (ADR 0403: connect to a listening build by its code or address). C7: U1 adds the menu item
   * and the dialog; absent, no item.
   */
  onConnect?(): void;
  /**
   * Opens the Offer a room dialog (ADR 0404: a tool that can't listen shows a room code a browser game joins with
   * `?debug-code=`); absent, no item.
   */
  onOfferRoom?(): void;
  /**
   * Drawn at the top of the open menu: the editor's Play as a build (its code and paired tools, `playBuild.ts`). C7: U1
   * renders it; U3 fills it.
   */
  playSlot?: ComponentChildren;
}

/** The status bar button and its menu. */
export function BuildsMenu(props: BuildsMenuProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  usePopover(menu, open, { anchor: button.current ?? undefined, focusFirst: true, inside: button.current ? [button.current] : undefined, onDismiss: () => setOpen(false) });
  const listening = props.listen.kind === "listening";
  const pick = (run: () => void) => {
    run();
    setOpen(false);
  };
  return (
    <>
      <button
        ref={button}
        class={`debug-link-button${props.builds.length > 0 ? " connected" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Builds connected through the debug link"
        onClick={(e) => {
          e.stopPropagation(); // not the status bar's own click (the message log)
          setOpen(!open);
        }}
      >
        {buildsButtonText(props.builds.length, listening)}
      </button>
      {open && (
        <div ref={menu} class="debug-link-menu" role="menu" aria-label="Connected builds" onClick={(e) => e.stopPropagation()}>
          {props.playSlot && (
            <>
              <div class="debug-link-slot">{props.playSlot}</div>
              <div class="debug-link-separator" role="separator" />
            </>
          )}
          {props.builds.length === 0 && <EmptyState compact title={emptyText(props.listen)} />}
          {props.builds.map((b) => (
            <div key={b.id} class="debug-link-row">
              <button role="menuitemradio" aria-checked={props.active === b.id} class="debug-link-pick" onClick={() => pick(() => props.onChoose(b.id))}>
                <span class="debug-link-check" aria-hidden="true">
                  {props.active === b.id ? "●" : ""}
                </span>
                {buildLabel(b)}
              </button>
              <button role="menuitem" class="debug-link-disconnect" aria-label={`Disconnect ${b.name}`} onClick={() => pick(() => props.onDisconnect(b.id))}>
                Disconnect
              </button>
            </div>
          ))}
          {props.builds.length > 0 && (
            <button role="menuitemradio" aria-checked={props.active === null} class="debug-link-pick" onClick={() => pick(() => props.onChoose(null))}>
              <span class="debug-link-check" aria-hidden="true">
                {props.active === null ? "●" : ""}
              </span>
              None (debug Play mode)
            </button>
          )}
          <div class="debug-link-separator" role="separator" />
          {props.onConnect && (
            <button role="menuitem" onClick={() => pick(props.onConnect!)}>
              Connect to a build…
            </button>
          )}
          {props.onOfferRoom && (
            <button role="menuitem" onClick={() => pick(props.onOfferRoom!)}>
              Offer a room…
            </button>
          )}
          <button role="menuitem" onClick={() => pick(props.onSettings)}>
            Debug link settings…
          </button>
        </div>
      )}
    </>
  );
}

function emptyText(listen: ListenState): string {
  if (listen.kind === "listening") return `No builds connected. Export with “Debugging on” and run the build; it connects to ${listen.address.replace("127.0.0.1", "localhost").replace("0.0.0.0", "this machine")}.`;
  if (listen.kind === "unavailable") return listen.why;
  return "The debug link is off. Turn it on in Settings.";
}

/** The menu over the editor's link. */
export function DebugLinkBuilds({ onSettings }: { onSettings(): void }) {
  const link = editorDebugLink();
  const builds = link.builds.value;
  const [connecting, setConnecting] = useState(false);
  const [offering, setOffering] = useState(false);
  return (
    <>
      <BuildsMenu
        builds={builds}
        active={link.active.value?.id ?? null}
        listen={link.state.value}
        onChoose={(id) => link.choose(id)}
        onDisconnect={(id) => link.disconnect(id)}
        onSettings={onSettings}
        onConnect={() => setConnecting(true)}
        onOfferRoom={() => setOffering(true)}
        playSlot={link.play.value ? <PlayBuildSlot build={link.play.value} /> : undefined}
      />
      {connecting && <ConnectDialog onConnect={(target) => link.connect(target)} onClose={() => setConnecting(false)} />}
      {offering && <OfferRoomDialog offer={() => link.offerRoom()} onClose={() => setOffering(false)} />}
    </>
  );
}
