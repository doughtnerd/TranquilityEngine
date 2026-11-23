// Connecting a tool (the editor, the Studio) to a listening build (ADR 0380 "Pairing code"): the person types the code
// the build shows (`3F9QK-7KD2X`) or a full address; this module turns it into attempts on the tool's `ToolConnector`.
// An address code's candidates (`pairing/address.ts`) are tried in turn until one pairs; a refusal (bad, used or expired
// token, locked) ends the flow with its message, since another candidate can't fix it. A room code needs the rendezvous
// (wave 4, R5); until then it is refused with a message saying so.
//
// C7 (plan §8): the contract `EditorDebugLink.connect()` delegates to. U1 fills `connectToBuild`.
import type { ConnectAttempt, ToolConnector } from "../../engine/debugLink/client";
import { addressCandidates, type AddressContext, type NetworkInterfaceAddress } from "../../engine/debugLink/pairing/address";
import { decodePairCode } from "../../engine/debugLink/pairing/code";
import { pairRefusalMessage } from "../../engine/debugLink/protocol";

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

/** How long one candidate gets to answer and pair before the next is tried (a person waits, so a few seconds). */
export const CANDIDATE_TIMEOUT_MS = 4000;

function fail(failure: ConnectFailure): never {
  throw new Error(failure.message, { cause: failure });
}

/**
 * Connects to the build `target` names. Resolves once a build paired (the link's `builds` then holds it); rejects with
 * an `Error` whose `cause` is a `ConnectFailure`.
 *
 * A code is decoded: an address code's candidates are tried one after another with its token; a typed address is
 * connected to directly, with no token; a room code needs the rendezvous (later) and is refused. A build's refusal
 * (wrong, used or expired code, locked) ends the flow at once, since another candidate can't fix it.
 */
export async function connectToBuild(target: ConnectTarget, host: ConnectHost): Promise<void> {
  let token: number | undefined;
  let urls: string[];
  const context = (): AddressContext => {
    const interfaces = host.interfaces();
    if (interfaces.length === 0 && host.pageHost !== null) return { kind: "page", host: host.pageHost };
    return { kind: "native", interfaces };
  };
  if ("address" in target) {
    const text = target.address.trim();
    if (!text) fail({ kind: "bad-code", message: "Type the code the build shows, or an address." });
    urls = addressCandidates({ address: text }, context()).map((c) => c.url);
    if (urls.length === 0) fail({ kind: "bad-code", message: `"${text}" isn't an address I can read. Try ws://192.168.1.20:7790 or 192.168.1.20:7790.` });
  } else {
    if (!target.code.trim()) fail({ kind: "bad-code", message: "Type the code the build shows, or an address." });
    const read = decodePairCode(target.code);
    if ("refused" in read) fail({ kind: "bad-code", message: `That isn't a pairing code: ${read.refused}.` });
    if (read.code.kind === "room") fail({ kind: "needs-rendezvous", message: "Room codes connect through a rendezvous, coming in a later update. Use the build's address code or type its address." });
    token = read.code.token;
    urls = addressCandidates({ octets: read.code.octets, portOffset: read.code.portOffset }, context()).map((c) => c.url);
  }

  const why: string[] = [];
  for (const url of urls) {
    let attempt: ConnectAttempt;
    try {
      attempt = host.connector.connect(url, token);
    } catch (err) {
      why.push(`${url}: ${(err as Error)?.message ?? err}`);
      continue;
    }
    const finished = () => attempt.state === "paired" || attempt.state === "refused" || attempt.state === "failed";
    await host.waitFor(finished, CANDIDATE_TIMEOUT_MS);
    if (attempt.state === "paired") return;
    if (attempt.state === "refused") {
      const message = attempt.refusal?.message ?? pairRefusalMessage("declined");
      attempt.cancel();
      fail({ kind: "refused", message });
    }
    if (attempt.state === "failed") why.push(attempt.reason || `${url}: couldn't connect`);
    else why.push(`${url}: no answer`);
    attempt.cancel();
  }
  const tried = urls.length === 1 ? urls[0]! : `${urls.length} addresses`;
  fail({ kind: "unreachable", message: `Nothing answered at ${tried}. Check that the build is running with debugging on, on the same network. (${why.join("; ")})` });
}
