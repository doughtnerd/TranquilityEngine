// The Connect dialog (ADR 0380): connect a tool (the editor, the Studio) to a listening build by the code it shows
// (`3F9QK-7KD2X`), by a typed address, or (M3, D2) by picking one the network lists. It shows the attempt's progress and
// why it failed (a bad or expired code, a locked build, nothing answering, a room code that needs a rendezvous).
//
// C7 (plan §8): the props are the contract the editor (U1) and the Studio (U4) mount it with.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ConnectFailure, ConnectTarget } from "./connectFlow";
import "./debugLink.css";

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

/** A thrown error as the failure line shows it: the flow's `ConnectFailure` (the `cause`), else the error's own message. */
function failureOf(err: unknown): ConnectFailure {
  const cause = (err as { cause?: unknown } | null)?.cause as Partial<ConnectFailure> | undefined;
  if (cause && typeof cause.kind === "string" && typeof cause.message === "string") return cause as ConnectFailure;
  return { kind: "unreachable", message: err instanceof Error && err.message ? err.message : "The connection failed." };
}

/**
 * The dialog: a code field and an address field, Connect, the attempt's progress, and the failure line. Enter connects,
 * Escape closes; it closes itself when the build paired. The code is read forgivingly (lower case, spaces and a dash
 * or none are fine), so the field keeps what was typed.
 */
export function ConnectDialog({ onConnect, onClose, discovered, failure: initialFailure }: ConnectDialogProps) {
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ConnectFailure | null>(initialFailure ?? null);
  const codeField = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    codeField.current?.focus();
    return () => void (alive.current = false);
  }, []);
  const target: ConnectTarget | null = code.trim() ? { code } : address.trim() ? { address: address.trim() } : null;
  const connect = () => {
    if (busy || !target) return;
    setBusy(true);
    setFailure(null);
    onConnect(target).then(
      () => {
        if (alive.current) onClose();
      },
      (err: unknown) => {
        if (!alive.current) return;
        setBusy(false);
        setFailure(failureOf(err));
        codeField.current?.focus();
      },
    );
  };
  const typed = (set: (v: string) => void) => (e: Event) => {
    set((e.currentTarget as HTMLInputElement).value);
    setFailure(null);
  };
  const found = discovered ?? [];
  const codeProblem = failure?.kind === "bad-code" || failure?.kind === "refused";
  return (
    <div class="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        class="dialog debug-link-connect"
        role="dialog"
        aria-modal="true"
        aria-labelledby="debug-link-connect-title"
        aria-describedby="debug-link-connect-help"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          } else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
            e.preventDefault();
            connect();
          }
        }}
      >
        <h2 id="debug-link-connect-title">Connect to a build</h2>
        <p id="debug-link-connect-help">Type the code the build shows. The build must be running with debugging on, on the same network.</p>
        <label class="debug-link-field">
          <span>Code</span>
          <input
            ref={codeField}
            class="debug-link-code"
            type="text"
            value={code}
            placeholder="3F9QK-7KD2X"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck={false}
            disabled={busy}
            aria-invalid={codeProblem ? true : undefined}
            onInput={typed(setCode)}
          />
        </label>
        <label class="debug-link-field">
          <span>Or an address</span>
          <input type="text" value={address} placeholder="192.168.1.20:7790" autocomplete="off" spellcheck={false} disabled={busy} onInput={typed(setAddress)} />
        </label>
        {found.length > 0 && (
          <div class="debug-link-discovered" role="group" aria-label="Builds on the network">
            <div class="debug-link-discovered-title">On the network</div>
            {found.map((b) => (
              <button
                key={`${b.address}/${b.name}`}
                type="button"
                class="debug-link-discovered-item"
                disabled={busy}
                onClick={() => {
                  setAddress(b.address);
                  setFailure(null);
                  codeField.current?.focus();
                }}
              >
                <span>{b.name}</span>
                <span class="debug-link-discovered-detail">
                  {b.platform}, {b.address}
                </span>
              </button>
            ))}
          </div>
        )}
        <div class="debug-link-status">
          {busy && (
            <p role="status" class="debug-link-progress">
              Connecting…
            </p>
          )}
          {failure && !busy && (
            <p role="alert" class="debug-link-failure" data-kind={failure.kind}>
              {failure.message}
            </p>
          )}
        </div>
        <div class="dialog-buttons">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" class="primary" disabled={busy || !target} onClick={connect}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
