// One effect in a chain (ADR 0349 `EffectCard`, ADR 0345): a collapsible card with a caret, the effect's name (and its
// summary while closed), Automate, On/Off (bypass), move up and down to reorder and Remove (icons, ADR 0361); open, its parameters as
// `ParameterRow`s from the catalogue (a menu for a `choices` parameter) and, for a sidechain compressor, its key bus. It
// reports intents; `EffectChain` turns them into edits of the list. A plugin effect (ADR 0352 §9) carries its plugin's
// chip; while its plugin is off or missing the card is greyed with the reason (`pluginEffectNote`); with a health row
// it shows a status line when the effect isn't healthy (faulted, off after faults, no free instance, loading) with
// Reset plugin, and the row (state, instructions per frame against the budget, memory, faults) when open.
import { useRef } from "preact/hooks";
import { clampEffectParam, effectSpec } from "../../engine/audio/effects/catalogue";
import type { Effect, EffectLevel, EffectParamSpec, EffectType } from "../../engine/audio/effects/types";
import type { AudioPluginDebug } from "../../plugins/audio/runtime/debugTypes";
import { effectSummary, levelWarning, pluginCardView, summaryFits } from "./effectChainModel";
import { useElementWidth } from "./useElementWidth";
import { formatParam } from "./parameterRowModel";
import { Icon } from "./Icon";
import { ParameterRow } from "./ParameterRow";
import "./audioParts.css";
import { EmptyState } from "../../editor/ui/EmptyState";

export interface EffectCardProps {
  readonly effect: Effect;
  readonly level: EffectLevel;
  /** Types the chain's owner runs here although the level doesn't list them (no level warning); absent: the level's. */
  readonly runs?: readonly EffectType[];
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
  /** A right-click (or the context-menu key) on Automate: the owner's curve menu at `at`. */
  onAutomateMenu?(at: { x: number; y: number }): void;
  /** ADR 0352 §9: a plugin effect's health row (`Audio.debug().plugins`), when the runtime has one. */
  readonly pluginHealth?: AudioPluginDebug | null;
  /** Reset plugin (a plugin effect that faulted): absent hides the button. */
  onResetPlugin?(): void;
}

function CurveIcon() {
  return (
    <Icon name="automate" size={14} />
  );
}

/** ADR 0352 §3: a `choices` parameter's menu (its value is the option's index). */
function ChoiceRow(props: { id: string; spec: EffectParamSpec; value: number; disabled: boolean; note?: string; title: string; onValue(v: number): void }) {
  const { spec } = props;
  const index = clampEffectParam(spec, props.value);
  return (
    <label class="studio-param studio-fx-choice" title={props.title}>
      <span>{spec.label}</span>
      <select id={props.id} aria-label={spec.label} value={String(index)} disabled={props.disabled} onChange={(e) => props.onValue(Number((e.currentTarget as HTMLSelectElement).value))}>
        {(spec.choices ?? []).map((label, i) => (
          <option key={label} value={String(i)}>
            {label}
          </option>
        ))}
      </select>
      {props.note && <span class="studio-param-note">{props.note}</span>}
    </label>
  );
}

export function EffectCard(props: EffectCardProps) {
  const { effect, open, readOnly } = props;
  const spec = effectSpec(effect.type);
  const automated = props.automated ?? {};
  const anyAuto = Object.keys(automated).length > 0;
  const warning = levelWarning(effect, props.level, props.runs);
  const bodyId = `studio-fx-${effect.id}-body`;
  const plugin = pluginCardView(effect, props.pluginHealth);
  const summary = effectSummary(effect);
  const summaryRef = useRef<HTMLSpanElement>(null);
  const summaryRoom = useElementWidth(summaryRef);
  return (
    <div class={`studio-row studio-fx${effect.on ? "" : " off"}${warning ? " warn" : ""}${plugin?.greyed ? " greyed" : ""}`} data-effect={effect.id} aria-disabled={plugin?.greyed ? true : undefined}>
      <div class="studio-row-head">
        <button type="button" class="studio-row-caret" aria-expanded={open} aria-controls={bodyId} aria-label={`${open ? "Collapse" : "Expand"} ${spec.label}`} onClick={() => props.onOpen(!open)}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        </button>
        <span class="studio-row-name" title={warning ?? (open ? spec.label : `${spec.label} · ${summary}`)}>
          {warning && <Icon name="warning" size={12} label="Warning" class="studio-row-warn" />}
          {spec.label}
        </span>
        {plugin && (
          <span class="studio-fx-chip" title={`A plugin effect: ${plugin.chip}`}>
            {plugin.chip}
          </span>
        )}
        {!open && <span ref={summaryRef} class={`studio-row-summary${summaryRoom > 0 && !summaryFits(summaryRoom) ? " cramped" : ""}`} title={summary}>{summary}</span>}
        <span class="studio-row-tools">
          {props.onAutomate && (
            <button
              type="button"
              class={`studio-icon-button${anyAuto ? " set" : ""}`}
              aria-label={`Automate ${spec.label}`}
              title={`Automate ${spec.label}: ${spec.params.map((q) => q.label.toLowerCase()).join(", ")}, driven by a game parameter${anyAuto ? ` · ${Object.keys(automated).join(", ")} automated` : ""}`}
              disabled={readOnly || spec.params.length === 0}
              onClick={props.onAutomate}
              onContextMenu={props.onAutomateMenu ? (e) => { e.preventDefault(); props.onAutomateMenu!({ x: e.clientX, y: e.clientY }); } : undefined}
              onKeyDown={props.onAutomateMenu ? (e) => { if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return; e.preventDefault(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); props.onAutomateMenu!({ x: r.left, y: r.bottom }); } : undefined}
            >
              <CurveIcon />
            </button>
          )}
          <button type="button" class={`studio-onoff${effect.on ? "" : " off"}`} aria-pressed={effect.on} title={effect.on ? "On: click to bypass" : "Bypassed: click to turn on"} disabled={readOnly} onClick={() => props.onOn(!effect.on)}>
            {effect.on ? "On" : "Off"}
          </button>
          <button type="button" class="studio-icon-button" aria-label={`Move ${spec.label} up`} title="Move up (runs earlier)" disabled={readOnly || props.first} onClick={() => props.onMove(-1)}>
            <Icon name="chevronUp" size={14} />
          </button>
          <button type="button" class="studio-icon-button" aria-label={`Move ${spec.label} down`} title="Move down (runs later)" disabled={readOnly || props.last} onClick={() => props.onMove(1)}>
            <Icon name="chevronDown" size={14} />
          </button>
          <button type="button" class="studio-icon-button" aria-label={`Remove ${spec.label}`} title={`Remove ${spec.label}`} disabled={readOnly} onClick={props.onRemove}>
            <Icon name="close" size={14} />
          </button>
        </span>
      </div>
      {plugin && (plugin.status || plugin.canReset) && (
        <div class="studio-fx-status" role="status">
          {plugin.status && <span>{plugin.status}</span>}
          {plugin.canReset && props.onResetPlugin && (
            <button type="button" class="studio-fx-reset" disabled={readOnly} title="Clear the faults and turn the effect back on, with fresh instances" onClick={props.onResetPlugin}>
              Reset plugin
            </button>
          )}
        </div>
      )}
      {open && (
        <div class="studio-row-body" id={bodyId}>
          {plugin?.health && (
            <p class={`studio-fx-health${plugin.health.load !== null && plugin.health.load > 1 ? " over" : ""}`} aria-label={`${spec.label} health`}>
              {plugin.health.text}
            </p>
          )}
          {spec.params.length === 0 && <EmptyState compact title="No settings" />}
          {spec.params.map((q) => {
            const value = effect.params[q.name] ?? q.default;
            const auto = automated[q.name];
            if (q.choices)
              return (
                <ChoiceRow
                  key={q.name}
                  id={`studio-fx-${effect.id}-${q.name}`}
                  spec={q}
                  value={value}
                  disabled={!!readOnly || auto !== undefined}
                  note={auto !== undefined ? `auto · ${auto}` : undefined}
                  title={auto !== undefined ? `${q.label} is automated (now ${auto}); edit it in the curve window` : `${q.label}: ${formatParam(q, value)}`}
                  onValue={(v) => props.onParam(q.name, v, false)}
                />
              );
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
