// ADR 0357 §5: the subtitle board the built-in display draws, driven through its interface with scripted `onLine` and
// `onCaption` events on the heard clock: paging, `sub` marker timing, stacking and the drop order, speaker-name modes,
// size presets, fades and a live language change.
import { describe, expect, it } from "vitest";
import { fitsLines, type PageFits } from "../../../engine/localisation/subtitles";
import { characterFit, fontSizeFor, showSpeakerNames, SIZE_PRESETS, SubtitleBoard, type BoardCaptionEvent, type BoardLineEvent, type BoardOptions } from "./board";

const RULE = { speed: 15, minDisplay: 1.5 };

function makeBoard(options: Partial<BoardOptions> = {}, strings: Record<string, string> = {}, fits: PageFits = fitsLines(42, 2)) {
  const env = { strings, fits, resolve: (key: string) => env.strings[key] ?? null, rule: () => RULE };
  const board = new SubtitleBoard({ resolve: (k) => env.resolve(k), rule: env.rule, fits: () => env.fits }, { maxStack: 3, fadeIn: 0.1, fadeOut: 0.2, speech: true, captions: true, ...options });
  return { board, env };
}

const start = (key: string, text: string, time: number, duration: number, speaker: string | null = "Ava"): BoardLineEvent => ({ phase: "start", key, speaker, text, textKey: key, duration, time });
const end = (key: string, time: number, reason: "ended" | "stopped" | "interrupted" = "ended"): BoardLineEvent => ({ phase: "end", key, speaker: null, text: null, textKey: key, duration: 0, time, reason });
const marker = (key: string, time: number, name = "sub"): BoardLineEvent => ({ phase: "marker", key, speaker: null, text: null, textKey: key, duration: 0, time, marker: { type: "cue", name, time } });
const caption = (phase: "start" | "end", key: string, time: number, duration: number | null = 1): BoardCaptionEvent => ({ phase, playlist: `${key}.playlist.json`, key, text: `[${key}]`, time, duration });
const texts = (board: SubtitleBoard, now: number) => board.rows(now).map((r) => r.text);

// 90 characters: two sentences of 44 and 45, too long for one 50-character page.
const TWO_SENTENCES = "We have to leave before the guards come back. The gate at the north wall is still open.";

describe("paging", () => {
  it("splits long text at a sentence end and shares the line's duration by characters", () => {
    const { board } = makeBoard({}, {}, fitsLines(50, 1));
    board.line(start("l1", TWO_SENTENCES, 10, 8));
    expect(board.rows(10)[0]).toMatchObject({ text: "We have to leave before the guards come back.", page: 0, pages: 2 });
    // 45 of 86 characters: the second page starts 45/86 × 8 ≈ 4.19 s in.
    expect(texts(board, 14.1)).toEqual(["We have to leave before the guards come back."]);
    expect(texts(board, 14.2)).toEqual(["The gate at the north wall is still open."]);
  });

  it("falls back to clause marks, and a blank line forces a page break", () => {
    const { board } = makeBoard({}, {}, fitsLines(30, 1));
    board.line(start("l1", "If the bridge is down, we take the river road instead", 0, 6));
    expect(texts(board, 0)).toEqual(["If the bridge is down,"]);
    board.line(start("l2", "Short.\n\nAlso short.", 0, 4, "Ben"));
    expect(board.rows(0).find((r) => r.speaker === "Ben")).toMatchObject({ text: "Short.", pages: 2 });
  });

  it("each page shows at least its reading time; the last lingers past the audio", () => {
    const { board } = makeBoard({}, {}, fitsLines(50, 1));
    board.line(start("l1", TWO_SENTENCES, 0, 2)); // 2 s of audio for 86 characters at 15/s
    expect(texts(board, 2.9)).toEqual(["We have to leave before the guards come back."]); // page 1 needs 45/15 = 3 s
    expect(texts(board, 3.1)).toEqual(["The gate at the north wall is still open."]);
    board.line(end("l1", 2));
    expect(board.rows(5.8)).toHaveLength(1); // 3 + 41/15 ≈ 5.73, then the fade
    expect(board.rows(6)).toHaveLength(0);
  });
});

describe("sub markers", () => {
  it("time the page changes as they arrive, instead of the share by characters", () => {
    const { board } = makeBoard({}, {}, fitsLines(50, 1));
    board.line(start("l1", TWO_SENTENCES, 10, 8));
    board.line(marker("l1", 13.5)); // the page change moves from ≈ 14.19 to 13.5 (still ≥ page 1's 3 s)
    expect(texts(board, 13.4)).toEqual(["We have to leave before the guards come back."]);
    expect(texts(board, 13.5)).toEqual(["The gate at the north wall is still open."]);
  });

  it("ignore other Cue markers", () => {
    const { board } = makeBoard({}, {}, fitsLines(50, 1));
    board.line(start("l1", TWO_SENTENCES, 0, 8));
    board.line(marker("l1", 3.5, "beat"));
    expect(texts(board, 3.6)).toEqual(["We have to leave before the guards come back."]);
  });
});

describe("rows", () => {
  it("show from the start until the later of the audio's end and the reading time, on the heard clock", () => {
    const { board } = makeBoard();
    board.line(start("l1", "Run.", 5, 0.4));
    expect(texts(board, 5)).toEqual(["Run."]);
    board.line(end("l1", 5.4));
    expect(texts(board, 6.4)).toEqual(["Run."]); // minDisplay 1.5
    expect(board.rows(6.55)[0].opacity).toBeCloseTo(0.75, 5); // fading out from 6.5
    expect(board.rows(6.7)).toEqual([]);
  });

  it("fade in, and an interrupted or stopped line fades out at once", () => {
    const { board } = makeBoard();
    board.line(start("l1", "This line is cut off halfway through.", 0, 4));
    expect(board.rows(0.05)[0].opacity).toBeCloseTo(0.5, 5);
    expect(board.rows(1)[0].opacity).toBe(1);
    board.line(end("l1", 1.2, "interrupted"));
    expect(board.rows(1.3)[0].opacity).toBeCloseTo(0.5, 5);
    expect(board.rows(1.4)).toEqual([]);
  });

  it("a new line from a speaker replaces that speaker's row; rows stack oldest first", () => {
    const { board } = makeBoard();
    board.line(start("a1", "One.", 0, 3, "Ava"));
    board.line(start("b1", "Two.", 0.5, 3, "Ben"));
    board.line(start("a2", "Three.", 1, 3, "Ava"));
    expect(texts(board, 1)).toEqual(["Two.", "Three."]);
  });

  it("when full, drop a caption before speech, then the oldest row", () => {
    const { board } = makeBoard();
    board.line(start("a1", "Ava speaks.", 0, 5, "Ava"));
    board.caption(caption("start", "door", 0.1));
    board.line(start("b1", "Ben speaks.", 0.2, 5, "Ben"));
    board.line(start("c1", "Cal speaks.", 0.3, 5, "Cal"));
    expect(texts(board, 0.3)).toEqual(["Ava speaks.", "Ben speaks.", "Cal speaks."]);
    board.line(start("d1", "Dee speaks.", 0.4, 5, "Dee"));
    expect(texts(board, 0.4)).toEqual(["Ben speaks.", "Cal speaks.", "Dee speaks."]);
  });

  it("a caption without a duration shows until its end, at least its reading time", () => {
    const { board } = makeBoard();
    board.caption(caption("start", "rain", 0, null));
    expect(texts(board, 30)).toEqual(["[rain]"]);
    board.caption(caption("end", "rain", 31));
    expect(texts(board, 31)).toEqual(["[rain]"]);
    expect(board.rows(31.3)).toEqual([]);
  });

  it("kinds that are off add no rows, and their rows leave at once", () => {
    const { board } = makeBoard({ captions: false });
    board.caption(caption("start", "door", 0));
    board.line(start("a1", "Hello.", 0, 2));
    expect(board.rows(0).map((r) => r.kind)).toEqual(["speech"]);
    board.options = { ...board.options, speech: false };
    expect(board.rows(0.1)).toEqual([]);
    board.line(start("a2", "Again.", 0.2, 2));
    expect(board.rows(0.2)).toEqual([]);
  });
});

describe("language change", () => {
  it("re-resolves every row through its string key and pages it again", () => {
    const { board, env } = makeBoard({}, { l1: "We're late." });
    board.line(start("l1", "We're late.", 0, 2));
    board.caption(caption("start", "door", 0));
    env.strings = { l1: "On est en retard.", door: "[la porte claque]" };
    board.refreshText();
    expect(texts(board, 0.5)).toEqual(["On est en retard.", "[la porte claque]"]);
  });

  it("keeps a row's text when its key has no message", () => {
    const { board, env } = makeBoard({}, { l1: "We're late." });
    board.line(start("l1", "We're late.", 0, 2));
    env.strings = {};
    board.refreshText();
    expect(texts(board, 0.5)).toEqual(["We're late."]);
  });
});

describe("speaker names and sizes", () => {
  const rows = [{ kind: "speech" as const, speaker: "Ava" }, { kind: "caption" as const, speaker: null }];
  it("always, when several are speaking, or never; the player's setting turns them off", () => {
    expect(showSpeakerNames(rows, "always", true)).toBe(true);
    expect(showSpeakerNames(rows, "never", true)).toBe(false);
    expect(showSpeakerNames(rows, "always", false)).toBe(false);
    expect(showSpeakerNames(rows, "whenSeveral", true)).toBe(false);
    expect(showSpeakerNames([...rows, { kind: "speech", speaker: "Ava" }], "whenSeveral", true)).toBe(false);
    expect(showSpeakerNames([...rows, { kind: "speech", speaker: "Ben" }], "whenSeveral", true)).toBe(true);
  });

  it("size presets are 3.2, 4, 5 and 6.4% of the canvas reference height, times sizeScale", () => {
    expect(SIZE_PRESETS).toEqual({ small: 3.2, medium: 4, large: 5, extraLarge: 6.4 });
    expect([fontSizeFor("small", 1080), fontSizeFor("medium", 1080), fontSizeFor("large", 1080), fontSizeFor("extraLarge", 1080)].map(Math.round)).toEqual([35, 43, 54, 69]);
    expect(fontSizeFor("medium", 720, 1.5)).toBeCloseTo(43.2, 5);
    expect(fontSizeFor("medium", 720, -1)).toBeCloseTo(28.8, 5);
  });

  it("estimates a page fit from the width, the font size and the language's glyph width", () => {
    const latin = characterFit(1344, 43.2, 1, "en"); // ≈ 56 characters a line
    expect(latin("x".repeat(56))).toBe(true);
    expect(latin("x".repeat(57))).toBe(false);
    const japanese = characterFit(1344, 43.2, 1, "ja"); // ≈ 31 full-width characters
    expect(japanese("あ".repeat(31))).toBe(true);
    expect(japanese("あ".repeat(32))).toBe(false);
  });
});
