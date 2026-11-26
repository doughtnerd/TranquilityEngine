// The Connect dialog (ADR 0403): connect a tool (the editor, the Studio) to a listening build by the code it shows
// (`3F9QK-7KD2X`), by a typed address, or (M3, D2) by picking one the network lists. It shows the attempt's progress and
// why it failed (a bad or expired code, a locked build, nothing answering, a room code that needs a rendezvous).
//
// C7 (plan §8): the props are the contract the editor (U1) and the Studio (U4) mount it with.
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ConnectFailure, ConnectTarget } from "./connectFlow";
import { buildLabel, chosenAddress, createDiscovery, type DiscoveredBuild, type DiscoveryModel } from "./discovery";
import "./debugLink.css";

export interface ConnectDialogProps {
  /** Starts a connect; the promise settles when it paired or failed (`EditorDebugLink.connect`). */
  onConnect(target: ConnectTarget): Promise<void>;
  /** Closes the dialog. */
  onClose(): void;
  /** The network discovery the dialog lists builds from; default: browse the LAN (native tools only; none in a page). */
  readonly discovery?: DiscoveryModel;
  /** A failure to show when the dialog opens (rarely needed; the dialog shows its own attempts' failures). */
  readonly failure?: ConnectFailure | null;
  /** A tool's own connection options, under the ways to connect (the Audio Studio's build audio download, ADR 0410). */
  readonly children?: ComponentChildren;
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
export function ConnectDialog({ onConnect, onClose, discovery: given, failure: initialFailure, children }: ConnectDialogProps) {
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ConnectFailure | null>(initialFailure ?? null);
  const [chosen, setChosen] = useState<DiscoveredBuild | null>(null);
  const [active, setActive] = useState(0);
  const codeField = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const discovery = useMemo(() => given ?? createDiscovery(), [given]);
  useEffect(() => {
    discovery.start();
    return () => discovery.stop();
  }, [discovery]);
  useEffect(() => {
    alive.current = true;
    codeField.current?.focus();
    return () => void (alive.current = false);
  }, []);
  // A picked build's address goes with the code (the code gives its token); a code alone completes its own address.
  const target: ConnectTarget | null = code.trim() ? (chosen ? { code, address: chosen.address } : { code }) : address.trim() ? { address: address.trim() } : null;
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
  const found = discovery.builds.value;
  const showNearby = discovery.available.value === true;
  const choose = (b: DiscoveredBuild) => {
    setChosen(b);
    setAddress(chosenAddress(b));
    setFailure(null);
    codeField.current?.focus();
  };
  const activeIndex = Math.min(active, found.length - 1);
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
          <input
            type="text"
            value={address}
            placeholder="192.168.1.20:7790"
            autocomplete="off"
            spellcheck={false}
            disabled={busy}
            onInput={(e) => {
              setChosen(null); // typing an address replaces a picked build
              typed(setAddress)(e);
            }}
          />
        </label>
        {showNearby && (
          <div class="debug-link-discovered">
            <div class="debug-link-discovered-title" id="debug-link-nearby-title">
              Nearby builds
            </div>
            {found.length === 0 ? (
              <p class="debug-link-discovered-empty" role="status">
                Looking for builds…
              </p>
            ) : (
              <ul
                class="debug-link-discovered-list"
                role="listbox"
                aria-labelledby="debug-link-nearby-title"
                aria-disabled={busy ? true : undefined}
                aria-activedescendant={`debug-link-nearby-${activeIndex}`}
                tabIndex={busy ? -1 : 0}
                onKeyDown={(e) => {
                  if (busy) return;
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    setActive(Math.max(0, Math.min(found.length - 1, activeIndex + (e.key === "ArrowDown" ? 1 : -1))));
                  } else if (e.key === "Home" || e.key === "End") {
                    e.preventDefault();
                    setActive(e.key === "Home" ? 0 : found.length - 1);
                  } else if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    choose(found[activeIndex]!);
                  }
                }}
              >
                {found.map((b, i) => (
                  <li
                    key={b.id}
                    id={`debug-link-nearby-${i}`}
                    role="option"
                    class={`debug-link-discovered-item${i === activeIndex ? " active" : ""}`}
                    aria-selected={chosen?.id === b.id}
                    onClick={() => {
                      if (busy) return;
                      setActive(i);
                      choose(b);
                    }}
                  >
                    {buildLabel(b)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div class="debug-link-status">
          {children}
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
