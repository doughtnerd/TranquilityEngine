/**
 * The subtitle board (ADR 0357 §5): what the built-in `SubtitleDisplay` shows, driven by the public audio events and the
 * heard clock. Pure: no World, no UI view, no `Audio`; the display feeds it events and asks for rows each frame.
 *
 * - **Rows.** A line's `start` (with text) or a caption's `start` adds a row; a new line from a speaker replaces that
 *   speaker's row; rows stack oldest first, at most `maxStack`, and when full a caption is dropped before speech
 *   (`pushRow`). Rows of a kind that is off (speech subtitles or captions) aren't added and leave at once.
 * - **Pages.** Text that doesn't fit splits into pages at sentence ends, then clause marks (`splitPages`, with the
 *   display's fit). `sub` Cue markers time the page changes as their events arrive (the public events carry no marker
 *   list in advance); otherwise pages share the line's duration by characters, each at least its reading time
 *   (`pageTimes`).
 * - **Timing** is in heard seconds (`Audio.time`'s base, the events' `time`), never wall clock: a row shows from its
 *   start until the later of the audio's end and its reading time; an `interrupted` or `stopped` end fades it out at
 *   once. A caption without a duration shows until its `end`, at least its reading time.
 * - **Fades:** opacity rises over `fadeIn` from the start and falls over `fadeOut` after the end.
 * - **Language change:** `refreshText()` re-resolves every row through its string key and pages it again.
 *
 * Also here: the size presets (% of the canvas reference height) and the speaker-name rule.
 */
import { fitsLines, pageTimes, pushRow, splitPages, type PageFits, type PageTime, type ReadingRule, type SubtitleRow } from "../../../engine/localisation/subtitles";
import type { SubtitleSize } from "../../../engine/localisation/subtitleSettings";

/** The subset of `AudioLineEvent` the board reads. */
export interface BoardLineEvent {
  phase: "start" | "end" | "marker";
  key: string;
  speaker: string | null;
  text: string | null;
  textKey: string | null;
  duration: number;
  time: number;
  marker?: { type: string; name: string; time: number };
  reason?: "ended" | "stopped" | "interrupted";
}

/** The subset of `AudioCaptionEvent` the board reads. */
export interface BoardCaptionEvent {
  phase: "start" | "end";
  playlist: string;
  key: string;
  text: string | null;
  time: number;
  duration: number | null;
}

/** What the board needs from its display. */
export interface BoardEnvironment {
  /** The text of a string key in the subtitle language now; null keeps the row's text (no message for it). */
  resolve(key: string): string | null;
  /** The reading rule (characters per second, minimum display) of the subtitle language now. */
  rule(): ReadingRule;
  /** Whether a page fits the display now (its width, size and `maxLines`). */
  fits(): PageFits;
}

export interface BoardOptions {
  /** Rows on screen at once. */
  maxStack: number;
  /** Seconds. */
  fadeIn: number;
  /** Seconds. */
  fadeOut: number;
  /** Speech rows are shown (the player's `enabled`). */
  speech: boolean;
  /** Caption rows are shown (the player's `captions` and the display's `captions`). */
  captions: boolean;
}

/** One row as the display draws it this frame. */
export interface BoardRow {
  readonly id: number;
  readonly kind: "speech" | "caption";
  /** The speaker id (speech), else null. */
  readonly speaker: string | null;
  /** The page showing now. */
  readonly text: string;
  /** 0-based page index, and how many pages. */
  readonly page: number;
  readonly pages: number;
  /** 0..1 (fades). */
  readonly opacity: number;
}

interface Row extends SubtitleRow {
  /** The line key (speech) or the caption's playlist, to match its later events. */
  readonly source: string;
  /** The string key text re-resolves through (a line's `textKey`, a caption's key). */
  readonly textKey: string | null;
  text: string;
  readonly start: number;
  /** Seconds of audio; null (captions) when open-ended; ≤ 0 when unknown. */
  readonly duration: number | null;
  /** Heard time the audio ended naturally. */
  ended: number | null;
  /** Heard time an `interrupted`/`stopped` end cut it. */
  cut: number | null;
  /** `sub` markers heard so far, seconds from the start. */
  readonly markers: number[];
  pages: PageTime[];
}

/** The size presets (ADR 0357 §5), % of the canvas reference height. */
export const SIZE_PRESETS: Readonly<Record<SubtitleSize, number>> = Object.freeze({ small: 3.2, medium: 4, large: 5, extraLarge: 6.4 });

/** The font size in UI pixels of a size setting on a canvas `referenceHeight` UI pixels high, times `sizeScale`. */
export function fontSizeFor(size: SubtitleSize, referenceHeight: number, sizeScale = 1): number {
  const scale = Number.isFinite(sizeScale) && sizeScale > 0 ? sizeScale : 1;
  return ((SIZE_PRESETS[size] ?? SIZE_PRESETS.medium) / 100) * referenceHeight * scale;
}

/** Average glyph width in ems: Latin-like text, and Chinese, Japanese and Korean (full-width) text. */
const EM_NARROW = 0.55;
const EM_WIDE = 1;
const WIDE_LANGUAGES = /^(ja|zh|ko)(-|$)/i;

/**
 * The page fit of a display `width` UI pixels wide at `fontSize` with `maxLines` lines in `language`: a character
 * estimate (`fitsLines`) at the language's average glyph width, at least 8 characters a line.
 */
export function characterFit(width: number, fontSize: number, maxLines: number, language: string): PageFits {
  const em = WIDE_LANGUAGES.test(language) ? EM_WIDE : EM_NARROW;
  const chars = Math.max(8, Math.floor(width / Math.max(1, fontSize * em)));
  return fitsLines(chars, Math.max(1, Math.floor(maxLines) || 1));
}

export type SpeakerNameMode = "always" | "whenSeveral" | "never";

/**
 * Whether speech rows show their speaker's name (ADR 0357 §5): never while the player turned names off or the display
 * says `never`; with `whenSeveral` only while two or more different speakers are shown.
 */
export function showSpeakerNames(rows: readonly Pick<BoardRow, "kind" | "speaker">[], mode: SpeakerNameMode, playerSetting: boolean): boolean {
  if (!playerSetting || mode === "never") return false;
  if (mode === "always") return true;
  return new Set(rows.filter((r) => r.kind === "speech" && r.speaker !== null).map((r) => r.speaker)).size >= 2;
}

export class SubtitleBoard {
  private list: Row[] = [];
  private nextId = 1;

  constructor(private readonly env: BoardEnvironment, public options: BoardOptions) {}

  /** An `Audio.onLine` event. */
  line(e: BoardLineEvent): void {
    if (e.phase === "start") {
      if (!this.options.speech || e.text === null || e.text.trim() === "") return;
      this.add({ kind: "speech", speaker: e.speaker, source: e.key, textKey: e.textKey, text: e.text, start: e.time, duration: e.duration });
      return;
    }
    const row = this.open("speech", e.key);
    if (!row) return;
    if (e.phase === "marker") {
      const m = e.marker;
      if (!m || m.type !== "cue" || m.name !== "sub") return;
      const at = m.time - row.start;
      if (at > 0 && !row.markers.includes(at)) {
        row.markers.push(at);
        this.page(row);
      }
      return;
    }
    if (e.reason === "interrupted" || e.reason === "stopped") row.cut = e.time;
    else this.ended(row, e.time);
  }

  /** An `Audio.onCaption` event. */
  caption(e: BoardCaptionEvent): void {
    if (e.phase === "start") {
      if (!this.options.captions || e.text === null || e.text.trim() === "") return;
      this.add({ kind: "caption", speaker: null, source: e.playlist, textKey: e.key, text: e.text, start: e.time, duration: e.duration });
      return;
    }
    const row = this.list.find((r) => r.kind === "caption" && r.source === e.playlist && r.textKey === e.key && r.ended === null && r.cut === null);
    if (row) this.ended(row, e.time);
  }

  /** The audio ended naturally at `time`; a row that didn't know its length pages over the real one. */
  private ended(row: Row, time: number): void {
    row.ended = time;
    if (row.duration === null || row.duration <= 0) this.page(row);
  }

  /** The language (or the strings) changed: every row's text again, paged again. */
  refreshText(): void {
    for (const r of this.list) {
      const text = r.textKey !== null ? this.env.resolve(r.textKey) : null;
      if (text !== null && text.trim() !== "") r.text = text;
      this.page(r);
    }
  }

  /** The fit changed (size, width, `maxLines`): every row paged again. */
  repage(): void {
    for (const r of this.list) this.page(r);
  }

  /** Drops every row. */
  clear(): void {
    this.list = [];
  }

  /** The rows to draw at heard time `now`, oldest first; rows that have faded out (or whose kind is off) leave. */
  rows(now: number): BoardRow[] {
    const { fadeIn, fadeOut } = this.options;
    this.list = this.list.filter((r) => (r.kind === "speech" ? this.options.speech : this.options.captions) && now < this.end(r) + Math.max(0, fadeOut));
    return this.list.map((r) => {
      const t = now - r.start;
      let page = 0;
      for (let i = 1; i < r.pages.length; i++) if (r.pages[i]!.start <= t) page = i;
      const end = this.end(r);
      const rise = fadeIn > 0 ? Math.min(1, Math.max(0, t / fadeIn)) : 1;
      const fall = now <= end ? 1 : fadeOut > 0 ? Math.max(0, 1 - (now - end) / fadeOut) : 0;
      return { id: r.id, kind: r.kind, speaker: r.speaker, text: r.pages[page]?.text ?? r.text, page, pages: r.pages.length, opacity: rise * fall };
    });
  }

  private add(r: Omit<Row, "id" | "ended" | "cut" | "markers" | "pages">): void {
    const row: Row = { ...r, id: this.nextId++, ended: null, cut: null, markers: [], pages: [] };
    this.page(row);
    this.list = pushRow(this.list, row, this.options.maxStack);
  }

  /** The newest row of `kind` from `source` still playing. */
  private open(kind: Row["kind"], source: string): Row | undefined {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const r = this.list[i]!;
      if (r.kind === kind && r.source === source && r.ended === null && r.cut === null) return r;
    }
    return undefined;
  }

  private page(r: Row): void {
    const pages = splitPages(r.text, this.env.fits());
    const rule = this.env.rule();
    // Open-ended (a looping caption) or unknown length: the pages share their reading time until the end arrives.
    const known = r.duration !== null && r.duration > 0 ? r.duration : r.ended !== null ? r.ended - r.start : 0;
    r.pages = pageTimes(pages.length ? pages : [r.text], known, rule, r.markers);
  }

  /** Heard time the row's last page ends (Infinity while an open-ended one waits for its end). */
  private end(r: Row): number {
    if (r.cut !== null) return r.cut;
    const last = r.pages.at(-1);
    const read = r.start + (last?.end ?? 0);
    const open = r.duration === null || r.duration <= 0;
    if (r.ended !== null) return Math.max(read, r.ended);
    return open ? Infinity : read;
  }
}
