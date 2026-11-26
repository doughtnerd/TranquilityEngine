// A native Myco app's listener also hosts the rendezvous (ADR 0403 "Rendezvous", plan task R4). The desktop shell's
// listening transport (`tauriListener.ts`) serves `/myco-rendezvous` beside the debug path on one port; `listeningTransport`
// is how the editor, the Studio and a game's player turn it on for the transport they are about to listen on.
//
// It is a function of its own (not part of `tauriListener.ts`) so a caller that holds a plain `Transport` doesn't need
// to know which transport it is: anywhere but the desktop shell it does nothing.
import type { Transport } from "../../net/Transport";
import { hostRendezvous } from "../tauriListener";

/** `transport`, with the rendezvous mounted on it when it is the desktop shell's native listener (call before it listens). */
export function listeningTransport(transport: Transport): Transport {
  hostRendezvous(transport);
  return transport;
}
