import { useEffect, useMemo, useState } from "preact/hooks";
import { Panel } from "./panel/Panel";
import { netWorldInfo } from "../../engine/editor";
import { CONDITION_LIMITS, MAX_CLIENTS, MAX_THIN_CLIENTS, NO_CONDITIONS, NetStatsSampler, TRAFFIC_CATEGORIES, clampConditions, clientLayout, formatBytes, ghostTypeLabel, hostLayout, type NetConditionValues, type PeerStats, type WorldStats } from "../netPlay";
import { netConditionsSetting, netPlaySetup } from "../preferences";
import { playing, togglePlaying } from "../session";
import { currentProject, openScene, playState } from "../state";
import "./network.css";

/** Stats refresh this often while playing (not every frame). */
const REFRESH_MS = 250;

/**
 * Multiplayer play mode and network tools (ADR 0033 §9): how Play runs a client/server project
 * (N clients plus thin clients), the simulated conditions on its loopback links, and while
 * playing, each networked World's connections with their RTT, traffic, snapshots, ghosts and input.
 */
export function NetworkPanel() {
  return (
    <Panel>
      <div class="network-panel">
        <PlaySetup />
        <Conditions />
        {playState.value === "playing" && playing.value ? <Stats /> : <NotPlaying />}
      </div>
    </Panel>
  );
}

function PlaySetup() {
  const setup = netPlaySetup.value;
  const project = currentProject.value;
  const state = playState.value;
  const layout = project ? clientLayout(project.settings.bootstrap) : null;
  const host = project && !layout ? hostLayout(project.settings.bootstrap) : null;
  const clientScenes = setup.clientScenes ?? "server";
  const set = (patch: Partial<typeof setup>) => (netPlaySetup.value = { ...setup, ...patch });
  const locked = state !== "edit";
  return (
    <section class="network-section" aria-label="Multiplayer play">
      <div class="network-row">
        <label class="network-check" title="Play with the client and thin-client counts below instead of the project's own client Worlds (project.json isn't changed)">
          <input type="checkbox" checked={setup.enabled} disabled={locked} onChange={(e) => set({ enabled: e.currentTarget.checked })} />
          Multiplayer play
        </label>
        <button
          class={`network-play${state !== "edit" ? " active" : ""}`}
          disabled={state === "starting" || (state === "edit" && !openScene.value)}
          // Named apart from the toolbar's Play and Stop, which stay the ones to find by name.
          aria-label={state === "edit" ? "Start playing" : "End play"}
          title={state === "edit" ? "Play the open scene (Ctrl+P)" : "Stop playing (Ctrl+P)"}
          onClick={togglePlaying}
        >
          {state === "edit" ? "▶ Play" : state === "starting" ? "Starting…" : "■ Stop"}
        </button>
      </div>
      <div class="network-row">
        <label>
          Clients
          <select aria-label="Clients" value={setup.clients} disabled={locked || !setup.enabled} onChange={(e) => set({ clients: Number(e.currentTarget.value) })}>
            {Array.from({ length: MAX_CLIENTS }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
          </select>
        </label>
        <label title="Client Worlds that don't render or take input; they send synthetic input to load the server">
          Thin clients
          <select aria-label="Thin clients" value={setup.thin} disabled={locked || !setup.enabled} onChange={(e) => set({ thin: Number(e.currentTarget.value) })}>
            {Array.from({ length: MAX_THIN_CLIENTS + 1 }, (_, i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </label>
        <label title="What thin clients write to the game's input streams each frame">
          Thin input
          <select aria-label="Thin client input" value={setup.thinInput} disabled={locked || !setup.enabled} onChange={(e) => set({ thinInput: e.currentTarget.value as "random" | "zeros" })}>
            <option value="random">Random walk</option>
            <option value="zeros">Zeros</option>
          </select>
        </label>
        {host && (
          <label title="The server World comes from a template the game creates at runtime (a Host button). The client copies can load its scenes and join straight away, or start on their own scenes (a menu).">
            Clients load
            <select aria-label="Clients load" value={clientScenes} disabled={locked || !setup.enabled} onChange={(e) => set({ clientScenes: e.currentTarget.value as "server" | "own" })}>
              <option value="server">The server's scenes (join)</option>
              <option value="own">Their own scenes</option>
            </select>
          </label>
        )}
      </div>
      {setup.enabled && project && (
        <p class="network-note">
          {layout
            ? `Play copies the client World "${layout.template.name}" as ${names("Client", setup.clients)}${setup.thin ? ` and ${names("Thin", setup.thin)}` : ""}, with its links.`
            : host
              ? `Play creates the server World "${host.server.name}" from its template and copies the client World "${host.client.name}" as ${names("Client", setup.clients)}${setup.thin ? ` and ${names("Thin", setup.thin)}` : ""}, each connected to it over loopback. ${
                  clientScenes === "server" && host.server.scenes
                    ? `The clients load the server's scenes (${host.server.scenes.join(", ") || "none"}), so they join the game directly.`
                    : `The clients load their own scenes${host.client.scenes ? ` (${host.client.scenes.join(", ")})` : ""}; they're connected already, so the game's own Host or Join may try to connect again.`
                }`
              : "This project has no client World linked to a server World, nor a server template (Worlds panel), so Play runs it as it is."}
          {locked && " Changes apply the next time you play."}
        </p>
      )}
    </section>
  );
}

/** `Client 1`, or `Client 1–3`. */
const names = (base: string, n: number) => (n === 1 ? `${base} 1` : `${base} 1–${n}`);

const SLIDERS:{ key: keyof NetConditionValues; label: string; unit: string; step: number }[] = [
  { key: "latencyMs", label: "Latency", unit: "ms", step: 5 },
  { key: "jitterMs", label: "Jitter", unit: "ms", step: 1 },
  { key: "lossPercent", label: "Loss", unit: "%", step: 1 },
];

function Conditions() {
  const values = netConditionsSetting.value;
  const set = (next: NetConditionValues) => {
    const c = clampConditions(next);
    netConditionsSetting.value = c;
    playing.peek()?.setConditions(c); // live, both ways, on every loopback link
  };
  return (
    <section class="network-section" aria-label="Network conditions">
      <div class="network-row">
        <span class="network-heading">Conditions</span>
        <span class="network-hint">loopback links, both ways</span>
        <button class="network-off" title="Turn simulated latency, jitter and loss off" onClick={() => set({ ...NO_CONDITIONS })}>
          Off
        </button>
      </div>
      {SLIDERS.map((s) => (
        <label key={s.key} class="network-slider">
          <span class="network-slider-label">{s.label}</span>
          <input
            type="range"
            aria-label={s.label}
            min={0}
            max={CONDITION_LIMITS[s.key]}
            step={s.step}
            value={values[s.key]}
            onInput={(e) => set({ ...values, [s.key]: Number(e.currentTarget.value) })}
          />
          <span class="network-slider-value">
            {values[s.key]} {s.unit}
          </span>
        </label>
      ))}
    </section>
  );
}

function NotPlaying() {
  return (
    <p class="network-empty">
      Play to see each networked World's connections here: state, round-trip time, traffic per kind of message, snapshot sizes, ghosts and input. With
      Multiplayer play on, a project whose client World is linked to a server World plays with the clients and thin clients chosen above.
    </p>
  );
}

function Stats() {
  const session = playing.value!;
  const sampler = useMemo(() => new NetStatsSampler(), [session]);
  const [worlds, setWorlds] = useState<WorldStats[]>([]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const refresh = () => {
      try {
        setWorlds(sampler.sample(netWorldInfo(session.engine), performance.now()));
      } catch (err) {
        console.error("[myco] The Network panel couldn't read the stats:", err);
      }
    };
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [session, sampler]);
  const toggle = (key: string) => setOpen((s) => (s.has(key) ? new Set([...s].filter((k) => k !== key)) : new Set([...s, key])));

  if (worlds.length === 0) return <p class="network-empty">No World in this game is networked: none is linked to another, or connected at runtime.</p>;
  return (
    <div class="network-stats">
      {worlds.map((w) => (
        <section key={w.world} class="network-world" data-world={w.world} aria-label={`World ${w.world}`}>
          <div class="network-world-head">
            <span class="network-world-name">{w.world}</span>
            <span class={`network-role ${w.role}`}>{w.role}</span>
            <span class="network-world-facts">
              tick {w.tick}
              {w.role === "client" && ` · server tick ${w.serverTick} · ghosts ${w.ghosts ?? 0}`}
              {w.role === "server" && ` · ${w.peers.filter((p) => p.state === "open").length} connected`}
            </span>
          </div>
          {w.prediction && (
            <div class="network-prediction">
              prediction: {Object.entries(w.prediction).map(([k, v]) => `${k} ${typeof v === "number" ? Math.round(v * 100) / 100 : String(v)}`).join(" · ")}
            </div>
          )}
          {w.peers.length === 0 ? (
            <p class="network-none">{w.role === "server" ? "No clients connected." : "Not connected."}</p>
          ) : (
            <table class="network-table">
              <thead>
                <tr>
                  <th>Connection</th>
                  <th>State</th>
                  <th title="Smoothed round-trip time">RTT</th>
                  <th title="Bytes per second received">In</th>
                  <th title="Bytes per second sent">Out</th>
                  {w.role === "server" && <th title="Size of the last snapshot sent">Snapshot</th>}
                  {w.role === "server" && <th title="Ghosts this client has been told about">Ghosts</th>}
                  {w.role === "server" && <th title="Inputs received / repeated (missing) / late">Input</th>}
                </tr>
              </thead>
              <tbody>
                {w.peers.map((p) => (
                  <PeerRows key={p.key} world={w} peer={p} expanded={open.has(p.key)} onToggle={() => toggle(p.key)} />
                ))}
              </tbody>
            </table>
          )}
          {w.closed.length > 0 && (
            <details class="network-closed">
              <summary>{w.closed.length} closed</summary>
              <ul>
                {w.closed.map((c, i) => (
                  <li key={i}>
                    {c.id ? `Connection ${c.id}` : "A connection"}: {c.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      ))}
    </div>
  );
}

/** A server connection's snapshot bandwidth per ghost type (prefab, or scene ghost), highest first. */
function GhostTypes(props: { peer: PeerStats }) {
  const rates = props.peer.ghostTypeRates;
  if (rates.length === 0) return <p class="network-none">No ghosts sent on this connection yet.</p>;
  const total = rates.reduce((n, t) => n + t.bytesPerSecond, 0);
  return (
    <table class="network-ghost-types" aria-label="Bandwidth per ghost type">
      <thead>
        <tr>
          <th title="Prefab path, or a scene ghost's scene and node path">Ghost type</th>
          <th title="Bytes per second of snapshots spent on ghosts of this type (spawns and states)">Out</th>
          <th title="Share of the per-ghost snapshot bytes">Share</th>
          <th title="Bytes since the connection opened">Total</th>
        </tr>
      </thead>
      <tbody>
        {rates.map((t) => (
          <tr key={t.type} data-ghost-type={t.type}>
            <td title={t.type}>{ghostTypeLabel(t.type)}</td>
            <td>{formatBytes(t.bytesPerSecond)}/s</td>
            <td>{total > 0 ? `${Math.round((t.bytesPerSecond / total) * 100)}%` : "—"}</td>
            <td>{formatBytes(t.bytes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PeerRows(props: { world: WorldStats; peer: PeerStats; expanded: boolean; onToggle: () => void }) {
  const { world: w, peer: p, expanded } = props;
  const name = w.role === "client" ? "Server" : `Connection ${p.id || "…"}`;
  const inputs = p.inputs.reduce((s, i) => ({ received: s.received + i.received, repeated: s.repeated + i.repeated, late: s.late + i.late }), { received: 0, repeated: 0, late: 0 });
  const columns = w.role === "server" ? 8 : 5;
  return (
    <>
      <tr class={`network-peer ${p.state}`} data-connection={p.key}>
        <td>
          <button class="network-expand" aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} traffic by kind for ${w.world} ${name}`} onClick={props.onToggle}>
            {expanded ? "▾" : "▸"}
          </button>
          <span title={p.remote}>{name}</span>
        </td>
        <td>{p.state}</td>
        <td class="network-rtt">{Math.round(p.rtt)} ms</td>
        <td class="network-in">{formatBytes(p.in.bytesPerSecond)}/s</td>
        <td class="network-out">{formatBytes(p.out.bytesPerSecond)}/s</td>
        {w.role === "server" && <td>{formatBytes(p.snapshotBytes ?? 0)}</td>}
        {w.role === "server" && <td>{p.ghosts ?? 0}</td>}
        {w.role === "server" && <td title={p.inputs.map((i) => `${i.id}: ${i.received} / ${i.repeated} / ${i.late}`).join("\n") || "No input received"}>{p.inputs.length ? `${inputs.received} / ${inputs.repeated} / ${inputs.late}` : "—"}</td>}
      </tr>
      {expanded && (
        <tr class="network-kinds">
          <td colSpan={columns}>
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>In</th>
                  <th>Out</th>
                </tr>
              </thead>
              <tbody>
                {TRAFFIC_CATEGORIES.filter((c) => p.in.byCategory[c] > 0 || p.out.byCategory[c] > 0).map((c) => (
                  <tr key={c} data-kind={c}>
                    <td>{c}</td>
                    <td>{formatBytes(p.in.byCategory[c])}/s</td>
                    <td>{formatBytes(p.out.byCategory[c])}/s</td>
                  </tr>
                ))}
                <tr class="network-totals">
                  <td>total</td>
                  <td>{formatBytes(p.received.bytes)} · {p.received.messages} msgs</td>
                  <td>{formatBytes(p.sent.bytes)} · {p.sent.messages} msgs</td>
                </tr>
              </tbody>
            </table>
            {w.role === "server" && <GhostTypes peer={p} />}
          </td>
        </tr>
      )}
    </>
  );
}
