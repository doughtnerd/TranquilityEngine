// Stories (ADR 0219, 0341 §7) for the Events tab's list and settings over the fixture file: add an event with a free
// name, rename it (a taken name is refused), change a setting, delete with a confirm.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { useState } from "preact/hooks";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { fixtureDialogue } from "../dialogueFixture";
import { addEvent, deleteEvent, duplicateEvent, eventList, renameEvent, setEventSettings, usedEventNames, type EventRef } from "./eventsModel";
import { EventsView } from "./EventsView";
import "../dialogue.css";

const FILE = "dialogue/barks.dialogue.json";

function Demo() {
  const [asset, setAsset] = useState(fixtureDialogue);
  const [selected, setSelected] = useState<string | null>("enemy_spotted");
  const [search, setSearch] = useState("");
  const [said, setSaid] = useState("");
  const docs = [{ path: FILE, asset }];
  const used = usedEventNames(docs);
  const events = eventList(docs, search);
  const apply = (r: { next: typeof asset } | { refused: string }, select?: (a: typeof asset) => string | null) => {
    if ("refused" in r) return setSaid(`Can't: ${r.refused}`);
    setAsset(r.next);
    if (select) setSelected(select(r.next));
  };
  const sel: EventRef | null = events.find((r) => r.event.name === selected) ?? null;
  return (
    <div style={{ width: "900px" }}>
      <EventsView
        events={events} files={[FILE]} selected={sel} search={search}
        onSearch={setSearch}
        onSelect={(r) => setSelected(r.event.name)}
        onAdd={() => apply(addEvent(asset, used), (a) => a.events.at(-1)!.name)}
        onDuplicate={(r) => apply(duplicateEvent(asset, r.event.name, used))}
        onRename={(r, to) => apply(renameEvent(asset, r.event.name, to, used), () => to)}
        onDelete={(r) => apply(deleteEvent(asset, r.event.name), () => null)}
        onSettings={(r, patch) => apply(setEventSettings(asset, r.event.name, patch))}
      >
        <p>Path table here</p>
      </EventsView>
      <p role="status">{said}</p>
    </div>
  );
}

const meta: Meta = { title: "Studio/Dialogue/Events/Events", component: EventsView };
export default meta;

export const Events: StoryObj = {
  render: () => <Demo />,
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    const list = c.getByRole("list", { name: "Events" });
    await expect(within(list).getByRole("button", { name: "enemy_spotted" })).toHaveAttribute("aria-current", "true");
    await userEvent.click(c.getByRole("button", { name: "Add event" }));
    await waitFor(() => expect(within(list).getByRole("button", { name: "new_event" })).toHaveAttribute("aria-current", "true"));
    const name = c.getByRole("textbox", { name: "Event name" });
    await userEvent.clear(name);
    await userEvent.type(name, "enemy_spotted{Enter}");
    await expect(c.getByRole("status")).toHaveTextContent('"enemy_spotted" is already an event');
    await userEvent.clear(name);
    await userEvent.type(name, "reload{Enter}");
    await waitFor(() => expect(within(list).getByRole("button", { name: "reload" })).toBeInTheDocument());
    await userEvent.click(c.getByText(/^Settings ·/));
    await userEvent.selectOptions(c.getByRole("combobox", { name: "When busy" }), "drop");
    await waitFor(() => expect(c.getByText(/^Settings ·/)).toHaveTextContent("drop"));
    await userEvent.click(c.getByRole("button", { name: "Delete" }));
    await userEvent.click(c.getByRole("button", { name: "Delete reload?" }));
    await waitFor(() => expect(within(list).queryByRole("button", { name: "reload" })).toBeNull());
    await userEvent.type(c.getByRole("searchbox", { name: "Search events" }), "zzz");
    await expect(list).toHaveTextContent("No event matches.");
  },
};
