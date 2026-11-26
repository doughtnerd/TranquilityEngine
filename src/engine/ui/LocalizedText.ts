/**
 * `LocalizedText` (ADR 0356 §4, Unity's `LocalizeStringEvent`): localised text for hand-built scene UI. It writes the
 * message of `key` in the current language into a text field of its node, when it starts, on every language change
 * (`Locale.epoch`) and when `key`, `field` or `args` change: a new `args` object, or one of its own values changed in place
 * (`loc.args.count++`; compared one level deep, so a value's own insides aren't watched). Literal text fields keep working unchanged; add this
 * component to the ones that should follow the language.
 */
import { Component } from "../core/Component";
import { component, field, getComponentId, getFields } from "../core/registry";
import { defineBuiltinSystem } from "../core/systems";
import type { World } from "../core/World";
import { Locale, type MessageArgs } from "../localisation/Locale";
import { Text } from "../render/components";
import { UIInputField, UIText } from "./components";

/** Live components, for the frame system. */
const live = new Set<LocalizedText>();

/**
 * Writes a string key's message into a text field of its node: `field` empty is the node's `UIText.text`, else its
 * `Text.text`, else its `UIInputField.placeholder`; otherwise it names a string field of a component on the node
 * (`"subtitle"`, or `"engine.UIText.text"` / `"UIText.text"` to say whose).
 */
@component("engine.LocalizedText")
export class LocalizedText extends Component {
  /** The string key (`menu.start`). */
  @field(String) key = "";
  /** The field it writes; empty: the node's text (see the class). */
  @field(String) field = "";
  /** The message's arguments, set by scripts at runtime (not saved): `loc.args = { count: 3 }`, or `loc.args.count++`. */
  args: MessageArgs | null = null;

  /** What was last written from: `values` is a copy of the arguments' own values then, to see changes made in place. */
  private written: { epoch: number; key: string; field: string; args: MessageArgs | null; values: Record<string, unknown> | null; count: number } | null = null;

  /** @internal */
  override _onActivate(): void {
    live.add(this);
    this.written = null;
    this._sync();
  }

  /** @internal */
  override _onDeactivate(): void {
    live.delete(this);
  }

  /** @internal */
  override _onDetach(): void {
    live.delete(this);
  }

  /** @internal The frame system: write the message again if the language, the key, the field or the arguments changed. */
  _sync(): void {
    const w = this.written;
    const epoch = Locale.epoch;
    if (w && w.epoch === epoch && w.key === this.key && w.field === this.field && w.args === this.args && sameValues(this.args, w.values, w.count)) return;
    const values = this.args ? { ...this.args } : null;
    this.written = { epoch, key: this.key, field: this.field, args: this.args, values, count: values ? Object.keys(values).length : 0 };
    if (this.key === "") return;
    const target = this.target();
    if (!target) {
      console.warn(`[myco] LocalizedText on "${this.owner.name}": ${this.field ? `no component has a text field "${this.field}"` : "the node has no UIText, Text or UIInputField"}; nothing to write "${this.key}" into.`);
      return;
    }
    target.comp[target.field] = Locale.t(this.key, this.args ?? undefined);
  }

  /** The component and field it writes into, or null when the node has none. */
  private target(): { comp: Record<string, unknown>; field: string } | null {
    const node = this.owner;
    const as = (c: Component | null, f: string) => (c ? { comp: c as unknown as Record<string, unknown>, field: f } : null);
    if (this.field === "") return as(node.getBehavior(UIText), "text") ?? as(node.getBehavior(Text), "text") ?? as(node.getBehavior(UIInputField), "placeholder");
    const dot = this.field.lastIndexOf(".");
    const owner = dot >= 0 ? this.field.slice(0, dot) : null;
    const name = dot >= 0 ? this.field.slice(dot + 1) : this.field;
    for (const c of node.getBehaviors(Component)) {
      if (c === this) continue;
      const type = c.constructor as new () => Component;
      if (owner !== null && getComponentId(type) !== owner && type.name !== owner) continue;
      if (getFields(type).some((f) => f.name === name && f.type === String)) return as(c, name);
    }
    return null;
  }
}

/** `args`' own values are those of `values` (both null, or the same `count` names with identical values); allocates nothing while they are. */
function sameValues(args: MessageArgs | null, values: Record<string, unknown> | null, count: number): boolean {
  if (args === null || values === null) return args === values;
  let n = 0;
  for (const name in args) {
    if (!Object.hasOwn(args, name)) continue;
    if (!Object.hasOwn(values, name) || !Object.is(args[name], values[name])) return false;
    n++;
  }
  return n === count; // fewer names than the copy: one was deleted
}

function inWorld(world: World): LocalizedText[] {
  return [...live].filter((c) => c.node.isValid && c._world === world);
}

// After behaviors' lateUpdate (args set in update show this frame), before render sync.
defineBuiltinSystem({ name: "engine.LocalizedText", phase: "lateUpdate", after: ["engine.LateUpdateScripts"], before: ["engine.UIDocumentSync"], run: (w) => inWorld(w).forEach((c) => c._sync()) });
