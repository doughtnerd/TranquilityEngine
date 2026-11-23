// The debug link's accept prompt (ADR 0376: "a connecting build shows its name, and the tool asks before accepting a
// non-local connection"). `AcceptPrompt` is the view; `DebugLinkPrompt` shows it for the first build waiting.
import { useEffect, useRef } from "preact/hooks";
import { acceptMessage, type BuildEntry } from "./debugLinkLogic";
import { editorDebugLink } from "./link";
import "./debugLink.css";

export interface AcceptPromptProps {
  readonly build: BuildEntry;
  /** Builds waiting after this one. */
  readonly more: number;
  onAccept(): void;
  onRefuse(): void;
}

/** Asks whether a build from another machine may connect. Escape and clicking outside refuse; Allow is not the default. */
export function AcceptPrompt({ build, more, onAccept, onRefuse }: AcceptPromptProps) {
  const refuse = useRef<HTMLButtonElement>(null);
  useEffect(() => refuse.current?.focus(), [build.id]);
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onRefuse()}>
      <div
        class="dialog debug-link-prompt"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="debug-link-prompt-title"
        aria-describedby="debug-link-prompt-message"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          onRefuse();
        }}
      >
        <h2 id="debug-link-prompt-title">Allow {build.name} to connect?</h2>
        <p id="debug-link-prompt-message">{acceptMessage(build)}</p>
        {more > 0 && <p class="note">{more === 1 ? "One more build is waiting." : `${more} more builds are waiting.`}</p>}
        <div class="dialog-buttons">
          <button ref={refuse} onClick={onRefuse}>
            Don't allow
          </button>
          <button class="primary" onClick={onAccept}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

/** The prompt for the first build from another machine waiting to connect (nothing while none waits). */
export function DebugLinkPrompt() {
  const link = editorDebugLink();
  const pending = link.pending.value;
  const first = pending[0];
  if (!first) return null;
  return <AcceptPrompt build={first} more={pending.length - 1} onAccept={() => link.accept(first.id)} onRefuse={() => link.refuse(first.id)} />;
}
