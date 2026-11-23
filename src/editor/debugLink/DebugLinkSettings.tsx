// The debug link's preferences (ADR 0376), in Settings > General: whether the editor listens for builds, whether builds
// on other machines may connect (the LAN toggle, off by default; the editor asks before accepting each), and the port.
// `DebugLinkFields` is the view; `DebugLinkSettings` connects it to the stored preferences and the link's state.
import { cleanPort, cleanPreferences, connectAddress, type DebugLinkPreferences } from "./debugLinkLogic";
import type { ListenState } from "./editorLink";
import { debugLinkPreferences, editorDebugLink } from "./link";
import "./debugLink.css";

export interface DebugLinkFieldsProps {
  readonly value: DebugLinkPreferences;
  readonly listen: ListenState;
  onChange(next: DebugLinkPreferences): void;
}

/** The fieldset. */
export function DebugLinkFields({ value, listen, onChange }: DebugLinkFieldsProps) {
  return (
    <fieldset class="debug-link-settings">
      <legend>Debug link</legend>
      <label>
        <input type="checkbox" checked={value.listen} onChange={(e) => onChange({ ...value, listen: (e.currentTarget as HTMLInputElement).checked })} />
        Listen for builds exported with debugging on
      </label>
      <label>
        <input type="checkbox" checked={value.lan} disabled={!value.listen} onChange={(e) => onChange({ ...value, lan: (e.currentTarget as HTMLInputElement).checked })} />
        Let builds on the local network connect (asks before accepting each)
      </label>
      <label class="settings-row">
        <span class="settings-label">Port</span>
        <input
          type="number"
          class="settings-size"
          min={1024}
          max={65535}
          step={1}
          aria-label="Debug link port"
          disabled={!value.listen}
          value={value.port}
          onChange={(e) => onChange({ ...value, port: cleanPort((e.currentTarget as HTMLInputElement).value) })}
        />
      </label>
      <p class="note" role="status">
        {statusText(value, listen)}
      </p>
    </fieldset>
  );
}

function statusText(value: DebugLinkPreferences, listen: ListenState): string {
  if (!value.listen || listen.kind === "off") return "Off: builds can't connect to this editor.";
  if (listen.kind === "unavailable") return listen.why;
  return value.lan
    ? `Listening on every network interface, port ${value.port}. Builds on this machine connect to ${connectAddress(value)}; builds elsewhere use this machine's address.`
    : `Listening on this machine only: builds connect to ${connectAddress(value)}.`;
}

/** The fieldset over the stored preferences. */
export function DebugLinkSettings() {
  return <DebugLinkFields value={cleanPreferences(debugLinkPreferences.value)} listen={editorDebugLink().state.value} onChange={(next) => (debugLinkPreferences.value = next)} />;
}
