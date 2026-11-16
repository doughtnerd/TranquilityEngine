// Stories (ADR 0219) for the registered Profiler panel (Pf4) and opening a capture from a file (X2): the empty state, a
// capture dropped on the panel and one chosen through the bar's file input (both through `profilerSlots.onDropFile`,
// filled by `installOpenCapture` as `mix/index.ts` fills it), each banner on a real fixture capture read by the real
// capture Worker (viewing, truncated, project mismatch, another wire naming both ABI versions, a file cut short, a file
// that isn't a capture, a .mycap of other bytes), a refused file leaving the open capture open, a filled drop slot
// getting the file instead, and the tables and banners slots handed the controller's state. The panel is rendered with
// no props, as the shell renders it, over its real deps. The same cases run headless in ProfilerPanel.test.ts and
// openCapture.test.ts until the story tests have run green.
import type { Meta, StoryObj } from "@storybook/preact-vite";
import { expect, fireEvent, fn, userEvent, waitFor } from "storybook/test";
import { MemoryFileSystem } from "../../../../editor/memoryFs";
import { openFolderProject } from "../../../../editor/projects";
import { currentProject } from "../../../../editor/state";
import { CAPTURE_ABI_VERSION, assembleCapture } from "../../runtime/capture/format";
import { SAMPLE_HEADER, SAMPLE_META, sampleCapture } from "../../runtime/capture/testSupport";
import { ProfilerPanel, profilerSlots, type BannersSlotProps, type ProfilerSlots, type TablesSlotProps } from "./ProfilerPanel";
import { OPEN_REFUSALS, installOpenCapture } from "./openCapture";

// The banners' words.
const BANNER_TEXT = {
  viewing: "Viewing, not replaying",
  truncated: "Truncated: the ring wrapped. This capture starts at a later keyframe, not at Play.",
  projectMismatch: "This capture was recorded with a different audio section than the open project's. It is shown as recorded.",
} as const;

/** A capture file with the given header flags and META `audio`. */
const capture = (init: { truncated?: boolean } = {}, audio: unknown = SAMPLE_META.audio): Uint8Array =>
  assembleCapture({ ...SAMPLE_HEADER, ...init }, { ...SAMPLE_META, audio }, [], { index: true });

/** The sample with another wire hash (bytes 12..27) and another ABI word (bytes 28..31). */
function otherWire(abi: number): Uint8Array {
  const b = new Uint8Array(sampleCapture());
  for (let i = 12; i < 28; i++) b[i] = b[i]! ^ 0xff;
  new DataView(b.buffer).setUint32(28, abi, true);
  return b;
}

const fileOf = (name: string, bytes: Uint8Array): File => new File([bytes.slice()], name);

/** The panel's own element, which takes drops. */
const chrome = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>("section.profiler")!;
/** Drop `file` on the panel as a file manager does. */
const drop = (root: HTMLElement, file: File): Promise<boolean> => fireEvent.drop(chrome(root), { dataTransfer: { files: [file], types: ["Files"] } });
const banner = (root: HTMLElement, id: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-banner="${id}"]`);
const bannerIds = (root: HTMLElement): string[] => [...root.querySelectorAll<HTMLElement>("[data-banner]")].map((b) => b.dataset.banner!);
const opened = (root: HTMLElement): Promise<void> => waitFor(() => expect(root.querySelector(".profiler-timeline")).not.toBeNull(), { timeout: 5000 });

/** Open the route as the registration does; undo it after the story. */
const withOpenRoute = () => installOpenCapture(profilerSlots);

const meta = {
  title: "Audio/Profiler/Panel",
  component: ProfilerPanel,
  beforeEach: withOpenRoute,
} satisfies Meta<typeof ProfilerPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  play: async ({ canvasElement }) => {
    expect(chrome(canvasElement)).toHaveAttribute("aria-label", "Audio Profiler");
    expect(canvasElement.querySelector(".profiler-empty")).toHaveTextContent("Not playing");
    expect(canvasElement.querySelector(".profiler-timeline")).toBeNull();
    expect(bannerIds(canvasElement)).toEqual([]);
  },
};

export const DropCapture: Story = {
  play: async ({ canvasElement }) => {
    const prevented = !(await drop(canvasElement, fileOf("d.mycap", capture())));
    expect(prevented).toBe(true); // the panel takes the drop (the browser doesn't navigate to the file)
    await opened(canvasElement);
    expect(canvasElement.querySelector(".profiler-empty")).toBeNull(); // the capture's timeline replaced the empty state
    expect(bannerIds(canvasElement)).toEqual(["viewing"]);
    expect(banner(canvasElement, "viewing")).toHaveTextContent(BANNER_TEXT.viewing);
    expect(canvasElement.querySelector(".profiler-status")).toHaveTextContent("d.mycap");
  },
};

export const OpenThroughTheBar: Story = {
  play: async ({ canvasElement }) => {
    const input = canvasElement.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, fileOf("p.mycap", capture()));
    await opened(canvasElement);
    expect(canvasElement.querySelector(".profiler-status")).toHaveTextContent("p.mycap");
    // A non-capture through Open gets the same refusal as through the drop.
    await userEvent.upload(input, fileOf("x.wav", new Uint8Array(0)));
    await waitFor(() => expect(banner(canvasElement, "error")).toHaveTextContent("notCapture"));
  },
};

export const Truncated: Story = {
  play: async ({ canvasElement }) => {
    await drop(canvasElement, fileOf("t.mycap", capture({ truncated: true })));
    await opened(canvasElement);
    expect(bannerIds(canvasElement)).toEqual(["truncated", "viewing"]);
    expect(banner(canvasElement, "truncated")).toHaveTextContent(BANNER_TEXT.truncated);
  },
};

export const ProjectMismatch: Story = {
  loaders: [
    async () => {
      const fs = new MemoryFileSystem();
      fs.files.set("C:\\Games\\other\\project.json", JSON.stringify({ name: "Other", audio: { buses: [{ name: "Other" }] } }));
      currentProject.value = await openFolderProject(fs, "C:\\Games\\other");
      return {};
    },
  ],
  beforeEach: () => () => void (currentProject.value = null),
  play: async ({ canvasElement }) => {
    await drop(canvasElement, fileOf("other.mycap", capture()));
    await opened(canvasElement); // still opens
    expect(bannerIds(canvasElement)).toEqual(["projectMismatch", "viewing"]);
    expect(banner(canvasElement, "projectMismatch")).toHaveTextContent(BANNER_TEXT.projectMismatch);
  },
};

export const OtherWire: Story = {
  play: async ({ canvasElement }) => {
    await drop(canvasElement, fileOf("old.mycap", otherWire(0x301)));
    await waitFor(() => expect(banner(canvasElement, "wireMismatch")).not.toBeNull(), { timeout: 5000 });
    expect(canvasElement.querySelector(".profiler-timeline")).toBeNull();
    const text = banner(canvasElement, "wireMismatch")!.textContent!;
    const mine = `${CAPTURE_ABI_VERSION >>> 8}.${CAPTURE_ABI_VERSION & 0xff}`;
    expect(text).toContain("Can't open old.mycap");
    expect(text).toContain("recorded with audio ABI 3.1");
    expect(text).toContain(`this build is ABI ${mine}`);
    expect(text).toMatch(/wire [0-9a-f]{32}\).*wire [0-9a-f]{32}\): re-record with this build$/);
  },
};

export const CutShort: Story = {
  play: async ({ canvasElement }) => {
    const whole = sampleCapture();
    await drop(canvasElement, fileOf("cut.mycap", whole.subarray(0, whole.byteLength - 7)));
    await waitFor(() => expect(banner(canvasElement, "error")).not.toBeNull(), { timeout: 5000 });
    // An error banner naming its code, never a partial profile.
    expect(bannerIds(canvasElement)).toEqual(["error"]);
    expect(banner(canvasElement, "error")!.textContent).toMatch(/^Can't open cut\.mycap: [a-zA-Z]+: /);
    expect(banner(canvasElement, "error")).toHaveAttribute("role", "alert");
    expect(canvasElement.querySelector(".profiler-timeline")).toBeNull();
  },
};

export const NotACapture: Story = {
  play: async ({ canvasElement, step }) => {
    await step("a wrong extension is refused unread", async () => {
      await drop(canvasElement, fileOf("notes.txt", capture()));
      await waitFor(() => expect(banner(canvasElement, "error")).toHaveTextContent(`Can't open notes.txt: notCapture: ${OPEN_REFUSALS.notCapture("notes.txt")}`));
    });
    await step("a .mycap of other bytes is badMagic", async () => {
      await drop(canvasElement, fileOf("fake.mycap", new TextEncoder().encode("this is not a capture file at all, just text".repeat(4))));
      await waitFor(() => expect(banner(canvasElement, "error")).toHaveTextContent("badMagic"), { timeout: 5000 });
      await drop(canvasElement, fileOf("empty.mycap", new Uint8Array(0)));
      await waitFor(() => expect(banner(canvasElement, "error")).toHaveTextContent("empty.mycap"), { timeout: 5000 });
      expect(banner(canvasElement, "error")).toHaveTextContent("badMagic");
    });
  },
};

export const StorageExtension: Story = {
  play: async ({ canvasElement }) => {
    // A capture saved on desktop or Android (Tauri Storage adds .bin) opens; other .bin files are refused.
    await drop(canvasElement, fileOf("TAKE.MYCAP.BIN", capture()));
    await opened(canvasElement);
    await drop(canvasElement, fileOf("level.bin", capture()));
    await waitFor(() => expect(banner(canvasElement, "error")).toHaveTextContent("notCapture"));
  },
};

export const RefusedFileKeepsTheOpenCapture: Story = {
  play: async ({ canvasElement }) => {
    await drop(canvasElement, fileOf("a.mycap", capture()));
    await opened(canvasElement);
    await drop(canvasElement, fileOf("b.txt", new Uint8Array(0)));
    await waitFor(() => expect(bannerIds(canvasElement)).toContain("error"));
    expect(canvasElement.querySelector(".profiler-timeline")).not.toBeNull();
    expect(canvasElement.querySelector(".profiler-status")).toHaveTextContent("a.mycap");
  },
};

export const FilledDropSlot: StoryObj<{ onDropFile: ProfilerSlots["onDropFile"] }> = {
  args: { onDropFile: fn() },
  beforeEach: ({ args }) => {
    const original = profilerSlots.onDropFile;
    profilerSlots.onDropFile = args.onDropFile;
    return () => void (profilerSlots.onDropFile = original);
  },
  play: async ({ canvasElement, args }) => {
    // A filled slot gets the file instead (X2's route), and nothing is opened.
    await drop(canvasElement, fileOf("d.mycap", capture()));
    expect(args.onDropFile).toHaveBeenCalledTimes(1);
    expect((args.onDropFile as ReturnType<typeof fn>).mock.calls[0]![1].name).toBe("d.mycap");
    expect(canvasElement.querySelector(".profiler-empty")).toHaveTextContent("Not playing");
  },
};

interface SlotArgs {
  banners: ReturnType<typeof fn<(p: BannersSlotProps) => void>>;
  tables: ReturnType<typeof fn<(p: TablesSlotProps) => void>>;
}

export const SlotsAsComponents: StoryObj<SlotArgs> = {
  args: { banners: fn(), tables: fn() },
  beforeEach: ({ args }) => {
    const original = { banners: profilerSlots.banners, tables: profilerSlots.tables };
    profilerSlots.banners = (b) => (args.banners(b), <div class="fake-banners">{b.banners.map((x) => x.id).join(",")}</div>);
    profilerSlots.tables = (t) => (args.tables(t), <div class="fake-tables" />);
    return () => void Object.assign(profilerSlots, original);
  },
  play: async ({ canvasElement, args }) => {
    expect(canvasElement.querySelector(".fake-tables")).toBeNull(); // no capture: no tables
    expect(canvasElement.querySelector(".profiler-empty")).toHaveTextContent("Not playing");
    await drop(canvasElement, fileOf("a.mycap", capture({ truncated: true })));
    await waitFor(() => expect(canvasElement.querySelector(".fake-tables")).not.toBeNull(), { timeout: 5000 });
    // Each slot is a component prop rendered in its region with the controller's state.
    expect(canvasElement.querySelector(".fake-banners")!.textContent).toContain("truncated");
    const tables = args.tables.mock.calls.at(-1)![0];
    expect(tables.source).not.toBeNull();
    expect(tables.cursor).toBeDefined();
    expect(args.banners.mock.calls.at(-1)![0].banners.map((b) => b.id)).toContain("truncated");
    expect(canvasElement.querySelectorAll(".profiler-bar")).toHaveLength(1); // the default bar, handed the same controller
  },
};
