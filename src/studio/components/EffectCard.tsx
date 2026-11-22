// One effect in a chain (ADR 0335 `EffectCard`, ADR 0331): a collapsible card with a caret, the effect's name (and its
// summary while closed), Automate ◆, On/Off (bypass), ↑ ↓ to reorder and × to remove; open, its parameters as
// `ParameterRow`s from the catalogue and, for a sidechain compressor, its key bus. It reports intents; `EffectChain`
// turns them into edits of the list.
import { effectSpec } from "../../engine/audio/effects/catalogue";
import type { Effect, EffectLevel } from "../../engine/audio/effects/types";
import { effectSummary, levelWarning } from "./effectChainModel";
import { formatParam } from "./parameterRowModel";
import { ParameterRow } from "./ParameterRow";
import "./audioParts.css";

export interface EffectCardProps {
  readonly effect: Effect;
  readonly level: EffectLevel;
  readonly open: boolean;
  readonly first: boolean;
  readonly last: boolean;
  /** Buses the key may name (sidechain). */
  readonly keyBuses?: readonly string[];
  /** Parameters driven by automation, with their current value text, by name. Their rows are disabled. */
  readonly automated?: Readonly<Record<string, string>>;
  readonly readOnly?: boolean;
  onOpen(open: boolean): void;
  onParam(name: string, value: number, drag: boolean): void;
  onOn(on: boolean): void;
  onMove(delta: -1 | 1): void;
  onRemove(): void;
  onKey?(bus: string): void;
  /** Automate ◆: absent hides the button. */
  onAutomate?(): void;
}

function CurveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 19C8 19 9 5 14 5S19 12 21 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
  );
}

export function EffectCard(props: EffectCardProps) {
  const { effect, open, readOnly } = props;
  const spec = effectSpec(effect.type);
  const automated = props.automated ?? {};
  const anyAuto = Object.keys(automated).length > 0;
  const warning = levelWarning(effect, props.level);
  const bodyId = `studio-fx-${effect.id}-body`;
  return (
    <div class={`studio-row studio-fx${effect.on ? "" : " off"}${warning ? " warn" : ""}`} data-effect={effect.id}>
      <div class="studio-row-head">
        <button type="button" class="studio-row-caret" aria-expanded={open} aria-controls={bodyId} aria-label={`${open ? "Collapse" : "Expand"} ${spec.label}`} onClick={() => props.onOpen(!open)}>
          {open ? "▾" : "▸"}
        </button>
        <span class="studio-row-name" title={warning ?? spec.label}>
          {warning && <span class="studio-row-warn" aria-label="Warning">⚠ </span>}
          {spec.label}
        </span>
        {!open && <span class="studio-row-summary">{effectSummary(effect)}</span>}
        <span class="studio-row-tools">
          {props.onAutomate && (
            <button
              type="button"
              class={`studio-icon${anyAuto ? " set" : ""}`}
              aria-label={`Automate ${spec.label}`}
              title={`Automate ${spec.label}: ${spec.params.map((q) => q.label.toLowerCase()).join(", ")}, driven by a game parameter${anyAuto ? ` · ${Object.keys(automated).join(", ")} automated` : ""}`}
              disabled={readOnly || spec.params.length === 0}
              onClick={props.onAutomate}
            >
              <CurveIcon />
            </button>
          )}
          <button type="button" class={`studio-onoff${effect.on ? "" : " off"}`} aria-pressed={effect.on} title={effect.on ? "On: click to bypass" : "Bypassed: click to turn on"} disabled={readOnly} onClick={() => props.onOn(!effect.on)}>
            {effect.on ? "On" : "Off"}
          </button>
          <button type="button" class="studio-icon" aria-label={`Move ${spec.label} up`} title="Move up (runs earlier)" disabled={readOnly || props.first} onClick={() => props.onMove(-1)}>
            ↑
          </button>
          <button type="button" class="studio-icon" aria-label={`Move ${spec.label} down`} title="Move down (runs later)" disabled={readOnly || props.last} onClick={() => props.onMove(1)}>
            ↓
          </button>
          <button type="button" class="studio-icon" aria-label={`Remove ${spec.label}`} title="Remove" disabled={readOnly} onClick={props.onRemove}>
            ×
          </button>
        </span>
      </div>
      {open && (
        <div class="studio-row-body" id={bodyId}>
          {spec.params.length === 0 && <p class="studio-row-empty">No settings.</p>}
          {spec.params.map((q) => {
            const value = effect.params[q.name] ?? q.default;
            const auto = automated[q.name];
            return (
              <ParameterRow
                key={q.name}
                id={`studio-fx-${effect.id}-${q.name}`}
                spec={q}
                value={value}
                disabled={readOnly || auto !== undefined}
                note={auto !== undefined ? `auto · ${auto}` : undefined}
                title={auto !== undefined ? `${q.label} is automated (now ${auto}); edit it in the curve window` : `${q.label}: ${formatParam(q, value)}`}
                onValue={(v, drag) => props.onParam(q.name, v, drag)}
              />
            );
          })}
          {spec.key === "bus" && (
            <label class="studio-param studio-fx-key">
              <span>Key bus</span>
              <select value={effect.key ?? ""} disabled={readOnly || !props.onKey} onChange={(e) => props.onKey?.((e.currentTarget as HTMLSelectElement).value)}>
                <option value="">None</option>
                {(props.keyBuses ?? []).map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
                {effect.key && !(props.keyBuses ?? []).includes(effect.key) && <option value={effect.key}>{effect.key} (missing)</option>}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
