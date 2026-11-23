// The Connect dialog (ADR 0380): connect a tool (the editor, the Studio) to a listening build by the code it shows
// (`3F9QK-7KD2X`), by a typed address, or (M3, D2) by picking one the network lists. It shows the attempt's progress and
// why it failed (a bad or expired code, a locked build, nothing answering, a room code that needs a rendezvous).
//
// C7 (plan §8): the props are the contract the editor (U1) and the Studio (U4) mount it with. U1 fills the view.
import type { ConnectFailure, ConnectTarget } from "./connectFlow";

/** A build found on the network (M3, D2); empty until discovery lands. */
export interface DiscoveredBuild {
  readonly name: string;
  readonly platform: string;
  /** The address to connect to; the person still types the code's token. */
  readonly address: string;
}

export interface ConnectDialogProps {
  /** Starts a connect; the promise settles when it paired or failed (`EditorDebugLink.connect`). */
  onConnect(target: ConnectTarget): Promise<void>;
  /** Closes the dialog. */
  onClose(): void;
  /** Builds the network lists (D2 fills it; empty before). */
  readonly discovered?: readonly DiscoveredBuild[];
  /** A failure to show when the dialog opens (rarely needed; the dialog shows its own attempts' failures). */
  readonly failure?: ConnectFailure | null;
}

/** The dialog. C7 stub: U1 draws it. */
export function ConnectDialog(props: ConnectDialogProps) {
  void props;
  return null;
}
