// The Offer a room dialog (ADR 0404, the reverse direction): a tool that can't listen (the browser Studio, the browser
// editor) opens a rendezvous room and shows its code; a browser game opened with `?debug-code=` joins it. The dialog
// starts the offer when it opens, shows the code (copyable), the state and the notice, and stops the offer on Stop or
// Escape. It closes itself shortly after a build joined (the pairing carries on; it isn't cut off).
import { useEffect, useRef, useState } from "preact/hooks";
import type { OfferedRoom } from "./editorLink";
import { JOINED_CLOSE_MS, offerInstruction, offerProblem, offerStateText, shownCode } from "./offerRoomLogic";
import "./debugLink.css";

export interface OfferRoomDialogProps {
  /** Opens the offer (`EditorDebugLink.offerRoom`); called once, when the dialog opens. */
  offer(): OfferedRoom;
  /** Closes the dialog. */
  onClose(): void;
}

/** The dialog. */
export function OfferRoomDialog({ offer, onClose }: OfferRoomDialogProps) {
  const room = useRef<OfferedRoom | null>(null);
  if (!room.current) room.current = offer();
  const current = room.current;
  const [copied, setCopied] = useState(false);
  const stopButton = useRef<HTMLButtonElement>(null);
  const state = current.state.value;
  const code = shownCode(current.code.value, state);
  const joined = state.kind === "joined";

  useEffect(() => {
    stopButton.current?.focus();
  }, []);
  useEffect(() => {
    if (!joined) return;
    const timer = setTimeout(onClose, JOINED_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [joined]);
  useEffect(
    () => () => {
      // Going away without a build having joined (Stop, Escape, the backdrop, the page changing) ends the offer.
      if (current.state.peek().kind !== "joined") current.stop();
    },
    [],
  );

  const stop = () => {
    current.stop();
    onClose();
  };
  const copy = () => {
    if (!code) return;
    void navigator.clipboard?.writeText(code).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && stop()}>
      <div
        class="dialog debug-link-offer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="debug-link-offer-title"
        aria-describedby="debug-link-offer-help"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            stop();
          }
        }}
      >
        <h2 id="debug-link-offer-title">Offer a room</h2>
        <p id="debug-link-offer-help">{offerInstruction(code)}</p>
        <div class="debug-link-offer-code-row">
          <output class="debug-link-offer-code" aria-label="Room code">
            {code ?? "–"}
          </output>
          <button type="button" disabled={!code} onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div class="debug-link-status">
          <p role="status" class={offerProblem(state) ? "debug-link-failure" : "debug-link-progress"}>
            {offerStateText(state)}
          </p>
          {current.notice && <p class="debug-link-offer-notice">{current.notice}</p>}
        </div>
        <div class="dialog-buttons">
          <button ref={stopButton} type="button" class="primary" onClick={stop}>
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}
