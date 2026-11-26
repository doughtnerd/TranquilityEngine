// An effect chain (ADR 0349 `EffectChain`, ADR 0345): the cards of one owner's effects (a sample, a clip, a playlist
// or track, a bus or return), top to bottom in the order they run, and Add effect listing the catalogue's types for
// the level, alphabetically. A new effect opens expanded. Every change is an edit from `effectChainModel.ts` handed to
// `onEdit(result, label, drag)`; the owner applies it as one undo step (`applyEdit`; a drag coalesces until `drag` is
// false) and removes a removed effect's automation, which it holds.
import { useRef, useState } from "preact/hooks";
import { allowedAt, effectSpec } from "../../engine/audio/effects/catalogue";
import type { Effect, EffectLevel, EffectType } from "../../engine/audio/effects/types";
import { ContextMenu } from "../../editor/ui/ContextMenu";
import { InfoTip } from "../../editor/ui/InfoTip";
import { SEPARATOR, type MenuEntry } from "../../editor/ui/contextMenuModel";
import type { AudioPluginDebug } from "../../plugins/audio/runtime/debugTypes";
import { addEffect, effectMenuGroups, moveEffect, nextEffectId, removeEffect, setEffectKey, setEffectOn, setEffectParam, type EditResult, type EffectMenuItem } from "./effectChainModel";
import { EffectCard } from "./EffectCard";
import { Icon } from "./Icon";
import { resetPluginEffect, usePluginHealth } from "./EffectChainHealth";
import "./audioParts.css";
import { EmptyState } from "../../editor/ui/EmptyState";

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
  /** The heading ("Bus effects"); its note says where the chain runs (an ⓘ tooltip beside it, spec §1.3). */
  readonly title?: string;
  readonly note?: string;
  onEdit(result: EditResult<Effect[]>, label: string, drag?: boolean): void;
  /** Automate ◆ on a card. */
  onAutomate?(effectId: string): void;
  /** A right-click (or the context-menu key) on a card's Automate button: the owner's curve menu at `at`. */
  onAutomateMenu?(effectId: string, at: { x: number; y: number }): void;
  /** Types the Add effect menu leaves out at this owner (a Clip's chain: no Delay or Reverb, decisions.md). */
  readonly exclude?: readonly string[];
  /**
   * ADR 0352 §9: plugin effect health rows (`Audio.debug().plugins`). Absent: the chain reads the runtime's own while it
   * holds a plugin effect (`EffectChainHealth.ts`).
   */
  readonly pluginHealth?: readonly AudioPluginDebug[];
  /** Reset plugin on a card (default: the running backend's `effectPlugins.reset`). */
  onResetPlugin?(type: string): void;
  /**
   * The Add effect list instead of the level's catalogue (a sequence clip: the instance level's types minus Delay and
   * Reverb, plus the Amp envelope, spec B.2). A listed type the level doesn't run is added at its own first level.
   */
  readonly types?: readonly EffectType[];
}

/** The Add effect menu's entries: the built-ins, then each plugin's effects under its title (ADR 0352 §9). */
function menuEntries(level: EffectLevel, add: (item: EffectMenuItem) => void, exclude: readonly string[] = []): MenuEntry[] {
  const groups = effectMenuGroups(level);
  // MX-31: the menu is captioned "Add effect", as the prototype's.
  const entries: MenuEntry[] = [{ kind: "group", label: "Add effect" }, ...groups.builtins.filter((item) => !exclude.includes(item.type)).map((item): MenuEntry => ({ id: item.type, label: item.label, run: () => add(item) }))];
  for (const g of groups.plugins) {
    entries.push(SEPARATOR, { id: `plugin:${g.plugin}`, label: g.title, disabled: true, title: `Effects of the plugin ${g.title} ${g.version}`.trim(), run: () => {} });
    for (const item of g.items) entries.push({ id: item.type, label: item.label, hint: g.title, title: `${item.label} (${g.title})`, run: () => add(item) });
  }
  return entries;
}

export function EffectChain(props: EffectChainProps) {
  const { effects, level, onEdit } = props;
  const hasPlugin = effects.some((e) => effectSpec(e.type).plugin !== undefined);
  const live = usePluginHealth(hasPlugin && props.pluginHealth === undefined);
  const health = props.pluginHealth ?? live;
  const resetPlugin = props.onResetPlugin ?? ((type: string) => void resetPluginEffect(type));
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
        <span class="studio-chain-title">
          {props.title ?? "Effects"}
          {props.limit !== undefined && <span class="studio-chain-count"> {effects.length} / {props.limit}</span>}
          {props.note && <InfoTip text={props.note} label={`About ${props.title ?? "Effects"}`} />}
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
          <Icon name="plus" size={14} /> Add effect
        </button>
      </header>
      {effects.length === 0 && <EmptyState compact title="No effects" body="Effects run top to bottom." />}
      {effects.map((effect, i) => {
        const label = effectSpec(effect.type).label;
        return (
          <EffectCard
            key={effect.id}
            effect={effect}
            level={level}
            runs={props.types}
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
            onAutomateMenu={props.onAutomateMenu ? (at) => props.onAutomateMenu!(effect.id, at) : undefined}
            pluginHealth={health.find((h) => h.type === effect.type) ?? null}
            onResetPlugin={() => resetPlugin(effect.type)}
          />
        );
      })}
      {menu && (
        <ContextMenu
          label="Add effect"
          at={addButton.current ?? { x: 0, y: 0 }}
          entries={(props.types
            ? [{ kind: "group", label: "Add effect" } as MenuEntry, ...props.types.map((type): MenuEntry => ({ id: type, label: effectSpec(type).label, run: () => {} }))]
            : menuEntries(level, () => {}, props.exclude)
          ).map((entry) => {
            if (entry.kind === "separator" || entry.kind === "group" || entry.disabled) return entry;
            const type = entry.id as EffectType;
            return {
              ...entry,
              run: () => {
                const id = nextEffectId(effects);
                const at = allowedAt(type, level) ? level : effectSpec(type).levels[0]!;
                onEdit(addEffect(effects, type, at, { limit: props.limit }), `Add ${effectSpec(type).label}`);
                toggle(id, true);
              },
            };
          })}
          onClose={() => setMenu(false)}
        />
      )}
    </section>
  );
}
