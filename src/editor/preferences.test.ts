// Persisted preferences follow another window's writes to the same key (the desktop editor's Projects window and
// editor window share one storage, ADR 0059), so a theme chosen in one shows in the other.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persisted } from "./preferences";

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem = (key: string) => this.items.get(key) ?? null;
  setItem = (key: string, value: string) => void this.items.set(key, value);
  removeItem = (key: string) => void this.items.delete(key);
}

let storage: MemoryStorage;
let page: EventTarget;

/** What the browser raises in this window when another window writes `key` (null: storage cleared). */
const otherWindowWrote = (key: string | null, newValue: string | null, area: unknown = storage) =>
  page.dispatchEvent(Object.assign(new Event("storage"), { key, newValue, storageArea: area }));

beforeEach(() => {
  storage = new MemoryStorage();
  page = new EventTarget();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("addEventListener", page.addEventListener.bind(page));
});

afterEach(() => vi.unstubAllGlobals());

describe("persisted preferences", () => {
  it("start from storage and write their changes back", () => {
    storage.setItem("myco.test.size", "14");
    const size = persisted("myco.test.size", 12);
    expect(size.value).toBe(14);
    size.value = 16;
    expect(storage.getItem("myco.test.size")).toBe("16");
  });

  it("follow another window's write to their own key, and only theirs", () => {
    const theme = persisted("myco.test.theme", "dark");
    const font = persisted("myco.test.font", "Inter");
    otherWindowWrote("myco.test.theme", JSON.stringify("light"));
    expect(theme.value).toBe("light");
    expect(font.value).toBe("Inter");
    otherWindowWrote("myco.test.themeOverrides", JSON.stringify("solarized")); // a key that merely starts the same
    expect(theme.value).toBe("light");
  });

  it("ignore session storage, fall back on a removed or unreadable value", () => {
    const theme = persisted("myco.test.theme", "dark");
    otherWindowWrote("myco.test.theme", JSON.stringify("light"), { other: "sessionStorage" });
    expect(theme.value).toBe("dark");
    otherWindowWrote("myco.test.theme", "{not json");
    expect(theme.value).toBe("dark");
    otherWindowWrote("myco.test.theme", JSON.stringify("light"));
    otherWindowWrote(null, null); // the storage was cleared
    expect(theme.value).toBe("dark");
  });
});
