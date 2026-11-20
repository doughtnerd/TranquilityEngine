// The Edit toggle a viewport tool's `editsComponents` brings (ADR 0266), as the Inspector gets it: a component header
// action registered with the tool through the plugin context. It owns the "editing this card" rule (node, type and
// index), the single-selection guard and the removal rule; entering and leaving go through `editor.viewport`.
import type { VNode } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { componentHeaderActions, type ComponentEditMode, type ComponentHeaderActionContribution, type ComponentHeaderActionProps } from "./sdk/contributions";
import { activatePlugins, deactivatePlugin, type EditorPlugin } from "./sdk/plugins";
import { viewport } from "./sdk/viewport";
import { playState } from "./state";

const TOOL = "t.handles";
const plugin: EditorPlugin = {
  manifest: { name: "t.handles", version: "1" },
  activate(context) {
    context.registerViewportTool({
      id: TOOL,
      editsComponents: { types: ["t.Box", "t.Ring"], label: "Edit Shape", hint: (type) => `Handles for ${type}`, stopHint: "Stop editing" },
      install: () => {},
    });
  },
};

/** The header actions the Inspector shows on a card of `type`. */
const actionsFor = (type: string): ComponentHeaderActionContribution[] =>
  componentHeaderActions.list().filter((a) => (a.types instanceof Set ? a.types.has(type) : (a.types as readonly string[]).includes(type)));
/** A card of `type`#`index` on the nodes `keys` (the active node last). */
const card = (type: string, index: number, ...keys: string[]): ComponentHeaderActionProps =>
  ({ scene: null!, paths: keys.map((k) => [k]), info: { type, index } }) as unknown as ComponentHeaderActionProps;
/** What the toggle renders on `props`'s card: its button, or null. */
const button = (props: ComponentHeaderActionProps) => {
  const [action] = actionsFor(props.info.type);
  return action!.view(props) as VNode<{ class: string; "aria-pressed": boolean; title: string; onClick: () => void; children: string }> | null;
};
const mode = () => viewport.mode<ComponentEditMode>(TOOL).peek();

afterEach(() => {
  viewport.leave(TOOL);
  playState.value = "edit";
  deactivatePlugin("t.handles");
});

describe("a viewport tool's Edit toggle", () => {
  it("comes and goes with the tool, on the types it edits only", () => {
    activatePlugins([plugin]);
    expect(actionsFor("t.Box").map((a) => a.id)).toEqual([`${TOOL}:edit`]);
    expect(actionsFor("t.Ring")).toHaveLength(1);
    expect(actionsFor("t.Other")).toEqual([]);
    deactivatePlugin("t.handles");
    expect(actionsFor("t.Box")).toEqual([]);
  });

  it("enters the tool with its card's component and leaves it again", () => {
    activatePlugins([plugin]);
    const box = card("t.Box", 1, "a");
    const off = button(box)!;
    expect(off.props.class).toBe("edit-handles");
    expect(off.props["aria-pressed"]).toBe(false);
    expect(off.props.children).toBe("Edit Shape");
    expect(off.props.title).toBe("Handles for t.Box");
    off.props.onClick();
    expect(viewport.activeTool).toBe(TOOL);
    expect(mode()).toEqual({ key: "a", type: "t.Box", index: 1 });
    const on = button(box)!;
    expect(on.props.class).toBe("edit-handles active");
    expect(on.props["aria-pressed"]).toBe(true);
    expect(on.props.title).toBe("Stop editing");
    on.props.onClick();
    expect(viewport.activeTool).toBeNull();
  });

  it("is on only for the card whose node, type and index the mode names", () => {
    activatePlugins([plugin]);
    button(card("t.Box", 0, "a"))!.props.onClick();
    expect(button(card("t.Box", 0, "a"))!.props["aria-pressed"]).toBe(true);
    expect(button(card("t.Ring", 0, "a"))!.props["aria-pressed"]).toBe(false); // same node and index, another type
    expect(button(card("t.Box", 1, "a"))!.props["aria-pressed"]).toBe(false);
    expect(button(card("t.Box", 0, "b"))!.props["aria-pressed"]).toBe(false);
    button(card("t.Ring", 0, "a"))!.props.onClick(); // another card's toggle moves the handles there
    expect(mode()).toEqual({ key: "a", type: "t.Ring", index: 0 });
  });

  it("shows nothing while several nodes are selected", () => {
    activatePlugins([plugin]);
    expect(button(card("t.Box", 0, "a", "b"))).toBeNull();
  });

  it("is ignored while playing", () => {
    activatePlugins([plugin]);
    playState.value = "playing";
    button(card("t.Box", 0, "a"))!.props.onClick();
    expect(viewport.activeTool).toBeNull();
  });

  it("ends editing when the edited card's component is removed, and only then", () => {
    activatePlugins([plugin]);
    button(card("t.Box", 0, "a"))!.props.onClick();
    const [action] = actionsFor("t.Box");
    action!.onRemove!(card("t.Box", 1, "a")); // another index
    action!.onRemove!(card("t.Ring", 0, "a")); // another type
    expect(mode()).toEqual({ key: "a", type: "t.Box", index: 0 });
    action!.onRemove!(card("t.Box", 0, "a"));
    expect(mode()).toBeNull();
  });
});
