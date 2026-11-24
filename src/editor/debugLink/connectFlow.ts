// Connecting a tool (the editor, the Studio) to a listening build (ADR 0403 "Pairing code"): the person types the code
// the build shows (`3F9QK-7KD2X`) or a full address; this module turns it into attempts on the tool's `ToolConnector`.
// An address code's candidates (`pairing/address.ts`) are tried in turn until one pairs; a refusal (bad, used or expired
// token, locked) ends the flow with its message, since another candidate can't fix it.
//
// A room code (ADR 0404; plan task R5) names a rendezvous room the build waits in (a page can't listen). The flow
// checks the path first (`rooms.ts` `joinPath`, i.e. `choosePath`: a hosted code needs a hosted rendezvous in Settings,
// a page on https can't reach a LAN one), completes the rendezvous's address as an address code's is, and joins the
// room through each candidate on the link's room connector (the `webrtc` transport, signalled through the room). The
// rendezvous checks the token when it seats the tool, and the build's gate checks it again in `pair`: a wrong token or
// a locked room ends the flow at once; "no such room" (used or expired) is said once no candidate pairs.
//
// C7 (plan §8): the contract `EditorDebugLink.connect()` delegates to. U1 filled `connectToBuild`; R5 added rooms.
import type { ConnectAttempt, ToolConnector } from "../../engine/debugLink/client";
import { addressCandidates, type AddressContext, type NetworkInterfaceAddress } from "../../engine/debugLink/pairing/address";
import { decodePairCode } from "../../engine/debugLink/pairing/code";
import { pairRefusalMessage, type EndpointKind } from "../../engine/debugLink/protocol";
import { joinCandidates, joinPath, joinRefusalMessage, roomAddress, type RoomRefusal } from "../../engine/debugLink/rooms";

/** What the person typed in the Connect dialog. */
export type ConnectTarget = { readonly code: string; readonly address?: string } | { readonly address: string };

/** What the flow needs to join rooms (the link's room connector and settings). */
export interface ConnectRooms {
  /** The connector over the link's room transport (`RoomJoinTransport`), polled by the link. */
  readonly connector: ToolConnector;
  /** This tool's endpoint kind (a page on https reaches only a hosted rendezvous). */
  readonly kind: EndpointKind;
  /** The hosted rendezvous from Settings > Debug link, or null. */
  readonly hosted: string | null;
  /** Whether this tool has WebRTC. */
  readonly webrtc: boolean;
  /** Why the rendezvous ended the join to `address` (`RoomJoinTransport.refusal`). */
  refusal(address: string): RoomRefusal;
}

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
  /** Room codes' needs; absent: room codes are refused (`needs-rendezvous`). */
  readonly rooms?: ConnectRooms;
}

/** Why a connect failed, for the dialog's error line. */
export type ConnectFailure =
  | { readonly kind: "bad-code"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "unreachable"; readonly message: string }
  | { readonly kind: "needs-rendezvous"; readonly message: string };

/** How long one candidate gets to answer and pair before the next is tried (a person waits, so a few seconds). */
export const CANDIDATE_TIMEOUT_MS = 4000;
/** The same for a room's rendezvous: joining, signalling and connecting the peers take longer than a socket. */
export const ROOM_CANDIDATE_TIMEOUT_MS = 15_000;

/** The sentence for a room that isn't there any more. */
export const NO_ROOM_MESSAGE = "No room has that code any more: it was used, or it expired (a room lasts 5 minutes). Use the code shown now.";

function fail(failure: ConnectFailure): never {
  throw new Error(failure.message, { cause: failure });
}

/**
 * Connects to the build `target` names. Resolves once a build paired (the link's `builds` then holds it); rejects with
 * an `Error` whose `cause` is a `ConnectFailure`.
 *
 * A code is decoded: an address code's candidates are tried one after another with its token; a room code's
 * rendezvous candidates likewise, joining its room (above); a typed address is connected to directly, with no token. A
 * build's refusal (wrong, used or expired code, locked) ends the flow at once, since another candidate can't fix it.
 */
export async function connectToBuild(target: ConnectTarget, host: ConnectHost): Promise<void> {
  let token: number | undefined;
  /** What each attempt connects to, and how it is named in messages (a room address holds the token: never shown). */
  let tries: { address: string; shown: string }[];
  let connector = host.connector;
  let timeoutMs = CANDIDATE_TIMEOUT_MS;
  let rooms: ConnectRooms | null = null;
  const context = (): AddressContext => {
    const interfaces = host.interfaces();
    if (interfaces.length === 0 && host.pageHost !== null) return { kind: "page", host: host.pageHost };
    return { kind: "native", interfaces };
  };
  if (!("code" in target)) {
    const text = target.address.trim();
    if (!text) fail({ kind: "bad-code", message: "Type the code the build shows, or an address." });
    tries = addressCandidates({ address: text }, context()).map((c) => ({ address: c.url, shown: c.url }));
    if (tries.length === 0) fail({ kind: "bad-code", message: `"${text}" isn't an address I can read. Try ws://192.168.1.20:7790 or 192.168.1.20:7790.` });
  } else {
    if (!target.code.trim()) fail({ kind: "bad-code", message: "Type the code the build shows, or an address." });
    const read = decodePairCode(target.code);
    if ("refused" in read) fail({ kind: "bad-code", message: `That isn't a pairing code: ${read.refused}.` });
    const code = read.code;
    token = code.token;
    const chosen = target.address?.trim();
    if (chosen) {
      // A build picked from the network: connect to its address, and the code supplies the token. A room code names a room
      // instead of an address, so it can't be combined with one.
      if (code.kind === "room") fail({ kind: "bad-code", message: "That code is for a room, not for the build you picked. Use an address code, or clear the picked build." });
      tries = addressCandidates({ address: chosen }, context()).map((c) => ({ address: c.url, shown: c.url }));
      if (tries.length === 0) fail({ kind: "bad-code", message: `"${chosen}" isn't an address I can read. Try ws://192.168.1.20:7790 or 192.168.1.20:7790.` });
    } else if (code.kind === "room") {
      rooms = host.rooms ?? null;
      if (!rooms) fail({ kind: "needs-rendezvous", message: "This tool can't reach a rendezvous to join a room here. Use the build's address code or type its address." });
      const path = joinPath(rooms.kind, code, rooms.hosted, rooms.webrtc);
      if (path.path !== "webrtc") fail({ kind: "needs-rendezvous", message: joinRefusalMessage(path.path === "unreachable" ? path.reason : "needs-rendezvous", code, "tool") });
      tries = joinCandidates(code, context(), rooms.hosted).map((url) => ({ address: roomAddress(url, code.room, code.token), shown: url }));
      connector = rooms.connector;
      timeoutMs = ROOM_CANDIDATE_TIMEOUT_MS;
    } else {
      tries = addressCandidates({ octets: code.octets, portOffset: code.portOffset }, context()).map((c) => ({ address: c.url, shown: c.url }));
    }
  }

  const why: string[] = [];
  let noRoom = false;
  for (const { address, shown } of tries) {
    let attempt: ConnectAttempt;
    try {
      attempt = connector.connect(address, token);
    } catch (err) {
      why.push(`${shown}: ${(err as Error)?.message ?? err}`);
      continue;
    }
    const finished = () => attempt.state === "paired" || attempt.state === "refused" || attempt.state === "failed";
    await host.waitFor(finished, timeoutMs);
    if (attempt.state === "paired") return;
    if (attempt.state === "refused") {
      const message = attempt.refusal?.message ?? pairRefusalMessage("declined");
      attempt.cancel();
      fail({ kind: "refused", message });
    }
    const refusal = rooms?.refusal(address) ?? null;
    const ended = attempt.state === "failed" ? attempt.reason : null;
    attempt.cancel();
    if (refusal === "bad-token" || refusal === "locked") fail({ kind: "refused", message: pairRefusalMessage(refusal) });
    if (refusal === "no-room" || refusal === "expired") {
      noRoom = true;
      why.push(`${shown}: no such room`);
    } else if (ended !== null) why.push(rooms ? `${shown}: ${ended || "couldn't connect"}` : ended || `${shown}: couldn't connect`);
    else why.push(`${shown}: no answer`);
  }
  if (noRoom) fail({ kind: "refused", message: NO_ROOM_MESSAGE });
  const tried = tries.length === 1 ? tries[0]!.shown : `${tries.length} addresses`;
  const check = rooms ? "the build is still showing that code, on the same network" : "the build is running with debugging on, on the same network";
  fail({ kind: "unreachable", message: `Nothing answered at ${tried}. Check that ${check}. (${why.join("; ")})` });
}
