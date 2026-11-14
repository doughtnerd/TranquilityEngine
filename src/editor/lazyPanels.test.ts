// Lazily loaded panels and dialogs (ADR 0083), and the panel registry built on them.
import type { VNode } from "preact";
import { describe, expect, it, vi } from "vitest";
import { defaultLayout, PANELS, typeOf, type Layout } from "./layout/model";
import { lazyComponent, lazyDialog, PanelLoading } from "./ui/lazy";
import { PANEL_VIEWS, visiblePanels } from "./ui/panels";

const Panel = () => null;
const vnode = (x: unknown) => x as VNode<{ error?: string }>;
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("lazyComponent", () => {
  it("shows the shared placeholder, loads once, then renders the component", async () => {
    const load = vi.fn(async () => Panel);
    const Lazy = lazyComponent(load);
    expect(vnode(Lazy()).type).toBe(PanelLoading);
    Lazy(); // a second render while loading doesn't load again
    expect(load).toHaveBeenCalledTimes(1);
    await settle();
    expect(Lazy.loaded).toBe(true);
    expect(vnode(Lazy()).type).toBe(Panel);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("loads ahead of the first render when preloaded", async () => {
    const load = vi.fn(async () => Panel);
    const Lazy = lazyComponent(load);
    await Lazy.preload();
    await Lazy.preload();
    expect(load).toHaveBeenCalledTimes(1);
    expect(vnode(Lazy()).type).toBe(Panel);
  });

  it("says why it didn't load, and loads again when asked", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const Lazy = lazyComponent(async () => {
      if (fail) throw new Error("offline");
      return Panel;
    });
    await Lazy.preload();
    const shown = vnode(Lazy());
    expect(shown.type).toBe(PanelLoading);
    expect(shown.props.error).toBe("offline");
    fail = false;
    await Lazy.preload();
    expect(vnode(Lazy()).type).toBe(Panel);
    error.mockRestore();
  });
});

describe("lazyDialog", () => {
  it("loads nothing and shows nothing until first opened, then stays mounted", async () => {
    let open = false;
    const load = vi.fn(async () => Panel);
    const Dialog = lazyDialog(() => open, load);
    expect(Dialog()).toBeNull();
    expect(load).not.toHaveBeenCalled();
    open = true;
    expect(Dialog()).toBeNull(); // loading: no placeholder over the editor
    await settle();
    expect(vnode(Dialog()).type).toBe(Panel);
    open = false;
    expect(vnode(Dialog()).type).toBe(Panel); // it hides itself when closed
  });
});

describe("the panel registry", () => {
  it("has a view for every panel", () => {
    expect(Object.keys(PANEL_VIEWS).sort()).toEqual([...PANELS].sort());
  });

  it("lists each expanded dock's front tabs as visible", () => {
    const layout = defaultLayout();
    const fronts = layout.docks.flatMap((d) => d.groups.map((g) => typeOf(layout, g.active)));
    expect(visiblePanels(layout)).toEqual(fronts);
    const collapsed: Layout = { ...layout, docks: layout.docks.map((d, i) => (i === 0 ? { ...d, collapsed: true } : d)) };
    expect(visiblePanels(collapsed)).toEqual(layout.docks.slice(1).flatMap((d) => d.groups.map((g) => typeOf(layout, g.active))));
  });
});
