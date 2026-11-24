// The debug link's preferences (ADR 0376), in Settings > General: whether the editor listens for builds, whether builds
// on other machines may connect (the LAN toggle, off by default; the editor asks before accepting each), the port, and
// for networks beyond this one, a rendezvous URL and ICE servers (ADR 0403). `DebugLinkFields` is the view;
// `DebugLinkSettings` connects it to the stored preferences and the link's state.
import { useState } from "preact/hooks";
import { cleanIceServers, cleanPort, cleanPreferences, cleanRendezvous, connectAddress, type DebugLinkPreferences } from "./debugLinkLogic";
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
  // The two text fields keep what is typed until it is committed (on change); what isn't valid is dropped then, with a note.
  const [rendezvousText, setRendezvousText] = useState(value.rendezvous ?? "");
  const [iceText, setIceText] = useState((value.iceServers ?? []).join("\n"));
  const [rendezvousProblem, setRendezvousProblem] = useState<string | null>(null);
  const [iceProblem, setIceProblem] = useState<string | null>(null);
  const commitRendezvous = () => {
    const typed = rendezvousText.trim();
    const cleaned = cleanRendezvous(typed);
    setRendezvousText(cleaned);
    setRendezvousProblem(typed && !cleaned ? `"${typed}" isn't a ws:// or wss:// address, so it was dropped.` : null);
    onChange({ ...value, rendezvous: cleaned });
  };
  const commitIce = () => {
    const lines = iceText.split("\n").map((l) => l.trim()).filter((l) => l);
    const kept = cleanIceServers(lines);
    const dropped = lines.length - kept.length;
    setIceText(kept.join("\n"));
    setIceProblem(dropped > 0 ? `${dropped === 1 ? "One line isn't" : `${dropped} lines aren't`} a stun:, turn: or turns: address, so ${dropped === 1 ? "it was" : "they were"} dropped.` : null);
    onChange({ ...value, iceServers: kept });
  };
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
      <div class="debug-link-field">
        <label for="debug-link-rendezvous">Rendezvous URL</label>
        <input
          id="debug-link-rendezvous"
          type="text"
          placeholder="ws://"
          disabled={!value.listen}
          value={rendezvousText}
          onInput={(e) => setRendezvousText((e.currentTarget as HTMLInputElement).value)}
          onChange={commitRendezvous}
        />
        <span class="note">For room codes when no machine on your network hosts a rendezvous. Leave empty normally.</span>
        {rendezvousProblem && <p class="debug-link-failure">{rendezvousProblem}</p>}
      </div>
      <div class="debug-link-field">
        <label for="debug-link-ice">ICE servers</label>
        <textarea
          id="debug-link-ice"
          rows={3}
          placeholder={"stun:stun.example.org:3478"}
          disabled={!value.listen}
          value={iceText}
          onInput={(e) => setIceText((e.currentTarget as HTMLTextAreaElement).value)}
          onChange={commitIce}
        />
        <span class="note">One per line, for networks beyond this one (stun:, turn: or turns: addresses). Leave empty normally.</span>
        {iceProblem && <p class="debug-link-failure">{iceProblem}</p>}
      </div>
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
