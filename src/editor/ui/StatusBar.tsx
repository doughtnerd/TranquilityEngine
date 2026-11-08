import { useEffect, useRef, useState } from "preact/hooks";
import { LOG_KINDS, clearLog, kindShown, logOpen, logText, messageLog, shownEntries, toggleLogKind, unseenErrors, type LogEntry } from "../messages";
import { addToPreload, preloadSuggestion } from "../scenePreload";
import { docVersion, openScene, scriptProblems, status } from "../state";
import { menuOpen } from "./MenuBar";

/**
 * The status bar: the latest message, any action it offers, and markers for problems. Clicking it
 * opens the message log, where whole messages, stack traces and earlier messages can be read.
 */
export function StatusBar() {
  const s = status.value;
  const open = logOpen.value;
  const unseen = unseenErrors.value;
  const toggle = () => {
    logOpen.value = !open;
    if (!open) unseenErrors.value = 0;
  };
  return (
    <>
      {open && <MessageLog />}
      <footer
        class={`status-bar${s?.kind === "error" ? " error" : ""}${open ? " open" : ""}`}
        aria-live="polite"
        title={open ? "Close the message log" : "Open the message log: full messages, details and earlier messages"}
        onClick={toggle}
      >
        <span class="status-toggle" aria-hidden="true">
          {open ? "▾" : "▴"}
        </span>
        <span class="status-text">{s?.text ?? ""}</span>
        {s?.action && (
          <button
            class="status-action"
            onClick={(e) => {
              e.stopPropagation();
              s.action!.run();
              status.value = { kind: "info", text: s.action!.done ?? "Done." };
            }}
          >
            {s.action.label}
          </button>
        )}
        <ScriptProblems />
        {unseen > 0 && !open && (
          <span class="status-unseen" title={`${unseen} error${unseen === 1 ? "" : "s"} since the log was last opened`}>
            {unseen} error{unseen === 1 ? "" : "s"}
          </span>
        )}
        <button class="status-log-button" aria-expanded={open} aria-controls="message-log">
          Log
        </button>
      </footer>
    </>
  );
}

/**
 * Project scripts that didn't load (ADR 0030): a lasting marker, since other messages replace the
 * status text. Clicking it shows the list in the status bar and the log.
 */
function ScriptProblems() {
  const problems = scriptProblems.value;
  if (problems.length === 0) return null;
  const lines = problems.map((p) => `${p.path}: ${p.message}`);
  return (
    <button
      class="script-problems"
      title={lines.join("\n")}
      onClick={(e) => {
        e.stopPropagation();
        status.value = { kind: "error", text: `${problems.length === 1 ? "A script" : `${problems.length} scripts`} didn't load.`, detail: lines.join("\n") };
        logOpen.value = true;
        unseenErrors.value = 0;
      }}
    >
      ⚠ {problems.length === 1 ? "1 script didn't load" : `${problems.length} scripts didn't load`}
    </button>
  );
}

/** What each filter toggle is called. */
const KIND_LABELS: Record<LogEntry["kind"], string> = { info: "Info", warning: "Warnings", error: "Errors" };

/**
 * The message log: newest first, with times, full text and details; toggles that show or hide each
 * kind of entry; Copy (what's shown), Clear, Close; Escape closes.
 */
function MessageLog() {
  const all = messageLog.value;
  const entries = shownEntries(all);
  const filtered = entries.length !== all.length;
  const [copied, setCopied] = useState(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || menuOpen.peek()) return; // an open menu closes first
      e.stopPropagation();
      logOpen.value = false;
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <section id="message-log" class="message-log" ref={panel} tabIndex={-1} role="log" aria-label="Message log">
      <header class="message-log-bar">
        <span class="message-log-title">Messages</span>
        <span class="message-log-count">{all.length === 0 ? "none yet" : filtered ? `${entries.length} of ${all.length} shown` : `${all.length}`}</span>
        <span class="message-log-filters" role="group" aria-label="Show messages of these kinds">
          {LOG_KINDS.map((kind) => {
            const on = kindShown(kind);
            const count = all.reduce((n, e) => (e.kind === kind ? n + 1 : n), 0);
            return (
              <button
                key={kind}
                class={`message-log-filter ${kind}${on ? " on" : ""}`}
                aria-pressed={on}
                title={`${on ? "Hide" : "Show"} ${KIND_LABELS[kind].toLowerCase()}`}
                onClick={() => toggleLogKind(kind)}
              >
                {KIND_LABELS[kind]} <span class="message-log-filter-count">{count}</span>
              </button>
            );
          })}
        </span>
        <button
          disabled={entries.length === 0}
          title={filtered ? "Copy the messages shown" : "Copy every message"}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(logText(entries));
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              // Clipboard blocked: nothing to do; the text can still be selected by hand.
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button disabled={all.length === 0} onClick={clearLog}>
          Clear
        </button>
        <button aria-label="Close the message log" onClick={() => (logOpen.value = false)}>
          ×
        </button>
      </header>
      <ol class="message-log-list">
        {all.length === 0 && <li class="empty">Messages and errors show up here.</li>}
        {all.length > 0 && entries.length === 0 && <li class="empty">No messages of the kinds shown. Turn on a kind above to see its messages.</li>}
        {[...entries].reverse().map((e) => (
          <Entry key={e.id} entry={e} />
        ))}
      </ol>
    </section>
  );
}

/**
 * A warm-up warning (ADR 0080) names the file whose shaders weren't warmed: offer to put it on the
 * open scene's preload list (one undoable edit; saved with the scene).
 */
function PreloadOffer(props: { text: string }) {
  const path = preloadSuggestion(props.text);
  docVersion.value; // re-render when the list changes (an undo)
  const scene = openScene.value;
  if (!path || !scene) return null;
  const listed = scene.doc.preload.includes(path);
  const name = scene.path.split("/").pop();
  return (
    <button
      class="message-action"
      disabled={listed}
      title={listed ? `${path} is on ${name}'s preload list` : `Add ${path} to ${name}'s preload list (Scene settings in the Inspector)`}
      onClick={() => {
        if (addToPreload(scene, path)) status.value = { kind: "info", text: `Added ${path} to ${name}'s preload list.` };
      }}
    >
      {listed ? "On the preload list" : "Add to preload list"}
    </button>
  );
}

function Entry(props: { entry: LogEntry }) {
  const { entry } = props;
  // Errors show their details straight away; other entries on request.
  const [open, setOpen] = useState(entry.kind === "error");
  return (
    <li class={`message-entry ${entry.kind}`}>
      <div class="message-entry-head">
        <time>{entry.time.toLocaleTimeString()}</time>
        <span class="message-kind">{entry.kind}</span>
        <span class="message-text">{entry.text}</span>
        <PreloadOffer text={entry.text} />
        {entry.detail && (
          <button class="message-detail-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide details" : "Details"}
          </button>
        )}
      </div>
      {entry.detail && open && <pre class="message-detail">{entry.detail}</pre>}
    </li>
  );
}
