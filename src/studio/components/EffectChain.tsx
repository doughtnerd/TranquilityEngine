// An effect chain (ADR 0335 `EffectChain`, ADR 0331): the cards of one owner's effects (a sample, a clip, a playlist
// or track, a bus or return), top to bottom in the order they run, and "+ Add effect" listing the catalogue's types for
// the level, alphabetically. A new effect opens expanded. Every change is an edit from `effectChainModel.ts` handed to
// `onEdit(result, label, drag)`; the owner applies it as one undo step (`applyEdit`; a drag coalesces until `drag` is
// false) and removes a removed effect's automation, which it holds.
import { useRef, useState } from "preact/hooks";
import { effectSpec } from "../../engine/audio/effects/catalogue";
import type { Effect, EffectLevel } from "../../engine/audio/effects/types";
import { ContextMenu } from "../../editor/ui/ContextMenu";
import { addEffect, effectMenu, moveEffect, nextEffectId, removeEffect, setEffectKey, setEffectOn, setEffectParam, type EditResult } from "./effectChainModel";
import { EffectCard } from "./EffectCard";
import "./audioParts.css";

export interface EffectChainProps {
  readonly effects: readonly Effect[];
  readonly level: EffectLevel;
  /** At most this many (a bus's cap). */
  readonly limit?: number;
  /** The bus the chain is on (a sidechain can't key on it). */
  readonly ownBus?: string;
  /** Buses a sidechain may key on. */
  readonly keyBuses?: readonly string[];
  /** Automated parameters: effect id → parameter → current value text. */
  readonly automated?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly readOnly?: boolean;
  /** The heading ("Bus effects"); its note says where the chain runs. */
  readonly title?: string;
  readonly note?: string;
  onEdit(result: EditResult<Effect[]>, label: string, drag?: boolean): void;
  /** Automate ◆ on a card. */
  onAutomate?(effectId: string): void;
}

export function EffectChain(props: EffectChainProps) {
  const { effects, level, onEdit } = props;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const full = props.limit !== undefined && effects.length >= props.limit;
  const toggle = (id: string, on: boolean) => {
    const next = new Set(open);
    if (on) next.add(id);
    else next.delete(id);
    setOpen(next);
  };
  return (
    <section class="studio-chain" aria-label={props.title ?? "Effects"}>
      <header class="studio-chain-head">
        <span class="studio-chain-title" title={props.note}>
          {props.title ?? "Effects"}
          {props.limit !== undefined && <span class="studio-chain-count"> {effects.length} / {props.limit}</span>}
        </span>
        <button
          ref={addButton}
          type="button"
          class="studio-chain-add"
          aria-haspopup="menu"
          aria-expanded={menu}
          disabled={props.readOnly || full}
          title={full ? `At most ${props.limit} effects here` : "Add an effect"}
          onClick={() => setMenu(!menu)}
        >
          + Add effect
        </button>
      </header>
      {props.note && <p class="studio-chain-note">{props.note}</p>}
      {effects.length === 0 && <p class="studio-row-empty">No effects. Effects run top to bottom.</p>}
      {effects.map((effect, i) => {
        const label = effectSpec(effect.type).label;
        return (
          <EffectCard
            key={effect.id}
            effect={effect}
            level={level}
            open={open.has(effect.id)}
            first={i === 0}
            last={i === effects.length - 1}
            keyBuses={props.keyBuses}
            automated={props.automated?.[effect.id]}
            readOnly={props.readOnly}
            onOpen={(on) => toggle(effect.id, on)}
            onParam={(name, value, drag) => onEdit(setEffectParam(effects, effect.id, name, value), `Set ${label} ${effectSpec(effect.type).params.find((q) => q.name === name)?.label.toLowerCase() ?? name}`, drag)}
            onOn={(on) => onEdit(setEffectOn(effects, effect.id, on), on ? `Turn on ${label}` : `Bypass ${label}`)}
            onMove={(delta) => onEdit(moveEffect(effects, effect.id, delta), `Move ${label} ${delta < 0 ? "up" : "down"}`)}
            onRemove={() => onEdit(removeEffect(effects, effect.id), `Remove ${label}`)}
            onKey={(bus) => onEdit(setEffectKey(effects, effect.id, bus, props.ownBus), `Set ${label} key`)}
            onAutomate={props.onAutomate ? () => props.onAutomate!(effect.id) : undefined}
          />
        );
      })}
      {menu && (
        <ContextMenu
          label="Add effect"
          at={addButton.current ?? { x: 0, y: 0 }}
          entries={effectMenu(level).map((item) => ({
            id: item.type,
            label: item.label,
            run: () => {
              const id = nextEffectId(effects);
              onEdit(addEffect(effects, item.type, level, { limit: props.limit }), `Add ${item.label}`);
              toggle(id, true);
            },
          }))}
          onClose={() => setMenu(false)}
        />
      )}
    </section>
  );
}
