// The Samples Inspector's Encoding section (ADR 0351 §6): a platform switch (Web · Desktop · Android), the profile the
// file uses, one row per key with its effective value, where it came from and an override control (for this platform
// or every platform) with Reset, the profile and folder-rule matches, and the readouts per platform: what it ships as,
// shipped size (exact once converted, else "≈"), the ratio to the source, runtime memory by load mode and the packages
// holding it. A view over props (`encodingModel.ts` shapes them); the Inspector feeds it the open sample.
import type { ImportPlatform } from "../../../engine/scene/importSettings";
import type { EncodingKey, EncodingSettings } from "../../../engine/audio/encoding/types";
import { Chip } from "../../../editor/ui/Chip";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { figureText, formatBytes } from "../../encoding/estimate";
import { keyChoices, parseChoice, PLATFORM_LABELS, PLATFORM_OPTIONS, type EncodingRow, type PlatformReadout, type ProfileMatch } from "./encodingModel";

/** Where an override goes: the chosen platform only, or every platform. */
export type OverrideScope = "platform" | "all";

export interface EncodingSectionProps {
  readonly platform: ImportPlatform;
  readonly scope: OverrideScope;
  readonly rows: readonly EncodingRow[];
  /** The project's profiles, and the one this file chooses (null: none of its own). */
  readonly profiles: readonly string[];
  readonly profile: string | null;
  readonly matches: readonly ProfileMatch[];
  readonly readouts: readonly PlatformReadout[];
  /** Exact sizes are being converted. */
  readonly converting: boolean;
  /** Why the settings can't be edited here (a derived sample's), or null. */
  readonly readOnly: string | null;
  readonly problems?: readonly string[];
  onPlatform(p: ImportPlatform): void;
  onScope(s: OverrideScope): void;
  onProfile(name: string | null): void;
  onOverride(key: EncodingKey, value: EncodingSettings[EncodingKey]): void;
  onReset(key: EncodingKey): void;
  /** Convert for every platform now, for exact sizes. */
  onConvert(): void;
}

function ValueControl(props: { row: EncodingRow; disabled: boolean; onOverride: EncodingSectionProps["onOverride"] }) {
  const { row } = props;
  const choices = keyChoices(row.key);
  const label = `${row.label} override`;
  if (choices) {
    return (
      <select class="enc-control" aria-label={label} value={String(row.value)} disabled={props.disabled}
        onChange={(e) => {
          const v = parseChoice(row.key, (e.currentTarget as HTMLSelectElement).value);
          if (v !== undefined) props.onOverride(row.key, v);
        }}>
        {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
      </select>
    );
  }
  const quality = row.key === "quality";
  return (
    <input class="enc-control" type="number" aria-label={label} disabled={props.disabled}
      min={0} max={quality ? 1 : 2000} step={quality ? 0.05 : 50} value={String(row.value)}
      onChange={(e) => {
        const n = Number((e.currentTarget as HTMLInputElement).value);
        if (Number.isFinite(n)) props.onOverride(row.key, n);
      }} />
  );
}

export function EncodingSection(props: EncodingSectionProps) {
  const ro = props.readOnly !== null;
  const shown = props.readouts.find((r) => r.platform === props.platform);
  return (
    <section class="enc-section" aria-label="Encoding">
      <h4 class="smp-insp-section">Encoding</h4>
      <div class="enc-head">
        <SegmentedControl size="small" label="Platform" value={props.platform} options={PLATFORM_OPTIONS} onChange={props.onPlatform} />
      </div>
      {props.readOnly && <p class="smp-muted">{props.readOnly}</p>}
      <label class="fld">
        <span>Profile</span>
        <select aria-label="Profile" value={props.profile ?? ""} disabled={ro} onChange={(e) => {
          const v = (e.currentTarget as HTMLSelectElement).value;
          props.onProfile(v === "" ? null : v);
        }}>
          <option value="" title="The project's encoding rules and its default profile decide">Rules and default</option>
          {props.profiles.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <div class="fld">
        <span>Overrides</span>
        <SegmentedControl size="small" label="Override for" value={props.scope}
          options={[{ value: "platform", label: PLATFORM_LABELS[props.platform] }, { value: "all", label: "All platforms" }]} onChange={props.onScope} />
      </div>
      <div class="enc-rows" role="table" aria-label={`Encoding for ${PLATFORM_LABELS[props.platform]}`}>
        {props.rows.map((row) => (
          <div key={row.key} class={`enc-row${row.overridden ? " overridden" : ""}`} role="row" data-key={row.key}>
            <span class="enc-key" role="rowheader">{row.label}</span>
            <span role="cell"><ValueControl row={row} disabled={ro} onOverride={props.onOverride} /></span>
            <span class="enc-from smp-muted" role="cell" title={`From ${row.from}`}>{row.from}</span>
            <span role="cell">
              {row.overridden && (
                <button class="smp-link" disabled={ro} aria-label={`Reset ${row.label}`} title="Take this file's override away and inherit" onClick={() => props.onReset(row.key)}>Reset</button>
              )}
            </span>
          </div>
        ))}
      </div>
      {props.matches.length > 0 && (
        <ul class="enc-matches" aria-label="Profile and rule matches">
          {props.matches.map((m, i) => <li key={i} class={`enc-match ${m.kind}`}>{m.text}</li>)}
        </ul>
      )}
      {props.problems?.map((p, i) => <p key={i} class="smp-warning">{p}</p>)}
      {shown?.notes.map((n, i) => <p key={`n${i}`} class="smp-muted enc-note">{n}</p>)}
      <table class="enc-readouts" aria-label="Size and memory per platform">
        <thead>
          <tr><th scope="col">Platform</th><th scope="col">Ships as</th><th scope="col">Size</th><th scope="col">Ratio</th><th scope="col">Memory</th></tr>
        </thead>
        <tbody>
          {props.readouts.map((r) => (
            <tr key={r.platform} class={r.platform === props.platform ? "current" : undefined} title={r.figures ? `${PLATFORM_LABELS[r.platform]}: ${figureText(r.figures.bytes, r.figures.exact)} shipped, ${figureText(r.figures.memoryBytes, r.figures.exact)} in memory` : undefined}>
              <th scope="row">{PLATFORM_LABELS[r.platform]}</th>
              <td>{r.figures ? `${r.figures.codec === "source" ? "source" : r.figures.codec}${r.figures.rate ? ` · ${r.figures.rate / 1000} kHz` : ""}${r.figures.channels ? ` · ${r.figures.channels === 1 ? "mono" : `${r.figures.channels} ch`}` : ""}` : "…"}</td>
              <td>{r.figures ? figureText(r.figures.bytes, r.figures.exact) : "…"}</td>
              <td>{r.ratio !== null ? `${Math.round(r.ratio * 100)}%` : "…"}</td>
              <td>{r.figures ? figureText(r.figures.memoryBytes, r.figures.exact) : "…"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="enc-foot">
        <span class="smp-muted">Source {shown ? formatBytes(shown.sourceBytes) : "…"}{shown && shown.packages.length > 0 ? ` · in ${shown.packages.join(", ")}` : " · loose (no package)"}</span>
        {props.converting ? <Chip tone="warning">Converting…</Chip> : (
          <button class="smp-link" disabled={props.readouts.every((r) => r.figures?.exact)} title="Encode for every platform now (cached), for exact sizes" onClick={props.onConvert}>Exact sizes</button>
        )}
      </div>
    </section>
  );
}
