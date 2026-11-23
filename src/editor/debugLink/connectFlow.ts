// Connecting a tool (the editor, the Studio) to a listening build (ADR 0380 "Pairing code"): the person types the code
// the build shows (`3F9QK-7KD2X`) or a full address; this module turns it into attempts on the tool's `ToolConnector`.
// An address code's candidates (`pairing/address.ts`) are tried in turn until one pairs; a refusal (bad, used or expired
// token, locked) ends the flow with its message, since another candidate can't fix it. A room code needs the rendezvous
// (wave 4, R5); until then it is refused with a message saying so.
//
// C7 (plan §8): the contract `EditorDebugLink.connect()` delegates to. U1 fills `connectToBuild`.
import type { ToolConnector } from "../../engine/debugLink/client";
import type { NetworkInterfaceAddress } from "../../engine/debugLink/pairing/address";

/** What the person typed in the Connect dialog. */
export type ConnectTarget = { readonly code: string } | { readonly address: string };

/** What the flow needs from the link that runs it. */
export interface ConnectHost {
  /** The link's connector (polled by the link; its peers join the link's builds when they pair). */
  readonly connector: ToolConnector;
  /** This machine's network addresses where the host can read them (native shells), else empty. */
  interfaces(): readonly NetworkInterfaceAddress[];
  /** The page's own host name (`location.hostname`), for address completion on an http page; null under a native shell. */
  readonly pageHost: string | null;
  /** Calls `poll` on the link's clock until `done` says stop; resolves then (the flow waits on attempts through it). */
  waitFor(done: () => boolean, timeoutMs: number): Promise<boolean>;
}

/** Why a connect failed, for the dialog's error line. */
export type ConnectFailure =
  | { readonly kind: "bad-code"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "unreachable"; readonly message: string }
  | { readonly kind: "needs-rendezvous"; readonly message: string };

/**
 * Connects to the build `target` names. Resolves once a build paired (the link's `builds` then holds it); rejects with
 * an `Error` whose `cause` is a `ConnectFailure`.
 */
export async function connectToBuild(target: ConnectTarget, host: ConnectHost): Promise<void> {
  void target;
  void host;
  throw new Error("U1: not implemented");
}
