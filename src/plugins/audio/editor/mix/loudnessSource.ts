// ADR 0171 amended by 0172 (M5b, task Pf6; api-and-models §5.5, §7; architecture §7.3): the client of the capture Worker's
// loudness requests (`runtime/capture/worker.ts`: `loudnessInfo`, `loudnessSeries`, `loudnessAt`, `loudnessMarks`). The Worker
// builds the series from the capture's STATUS records with the shared `LoudnessStats` (`loudnessTrackModel.ts`), so a 10-minute
// capture never blocks the editor; this class only sends requests and puts the answers on the viewport's axis (seconds from the
// capture's first record, `ProfileSource.startSeconds` subtracted from the Worker's axis seconds), as `statusColumns` does.
// Series arrays are transferred, so the caller owns them.
import type {
  CaptureLoudnessColumns, CaptureLoudnessGap, CaptureLoudnessMark, CaptureLoudnessTarget, CaptureLoudnessValues,
} from "../../runtime/capture/format";
import type { CaptureRequest, CaptureResponse } from "../../runtime/capture/worker";
import type { DistributiveOmit } from "./profilerSource";

/** What the client needs of a source: a `CaptureSource` (its Worker and its origin). */
export interface LoudnessCaller {
  readonly startSeconds: number;
  call(req: DistributiveOmit<CaptureRequest, "id">, transfer?: Transferable[]): Promise<CaptureResponse>;
}

/** A source that can be asked for loudness (a `CaptureSource` can; a test's fake source may not). */
export function canAskLoudness(source: unknown): source is LoudnessCaller {
  return typeof source === "object" && source !== null && typeof (source as { call?: unknown }).call === "function";
}

export interface LoudnessInfo {
  /** `"replay"`: the whole capture was fed, so I, LRA and the peak are the live meter's; `"seek"`: a truncated capture, I and LRA held at the keyframes' readings. */
  mode: "replay" | "seek";
  buses: readonly { slot: number; samples: number }[];
}

export interface LoudnessSeriesData {
  slot: number;
  columns: CaptureLoudnessColumns;
  gaps: CaptureLoudnessGap[];
}

export class LoudnessSource {
  constructor(private readonly source: LoudnessCaller) {}

  private async ask<T extends CaptureResponse["type"]>(req: DistributiveOmit<CaptureRequest, "id">, type: T): Promise<Extract<CaptureResponse, { type: T }>> {
    const r = await this.source.call(req);
    if (r.type !== type) throw new Error(`capture worker: unexpected ${r.type}`);
    return r as Extract<CaptureResponse, { type: T }>;
  }

  /** The buses with loudness samples and how the series was built. */
  async info(): Promise<LoudnessInfo> {
    const r = await this.ask({ type: "loudnessInfo" }, "loudnessInfo");
    return { mode: r.mode, buses: r.buses };
  }

  /** One bus's series over viewport time [from, to] (the whole capture by default). */
  async series(slot: number, from?: number, to?: number): Promise<LoudnessSeriesData> {
    const o = this.source.startSeconds;
    const r = await this.ask(
      { type: "loudnessSeries", slot, ...(from === undefined ? {} : { t0: o + from }), ...(to === undefined ? {} : { t1: o + to }) },
      "loudnessSeries",
    );
    if (o !== 0) {
      const t = r.columns.time;
      for (let i = 0; i < t.length; i++) t[i] = t[i]! - o;
    }
    return { slot: r.slot, columns: r.columns, gaps: r.gaps.map((g) => ({ ...g, from: g.from - o, to: g.to - o })) };
  }

  /** The values at viewport time `t` for one bus (every bus without `slot`): the newest sample at or before `t`, null before the first. */
  async valuesAt(t: number, slot?: number): Promise<{ slot: number; values: CaptureLoudnessValues | null }[]> {
    const o = this.source.startSeconds;
    const r = await this.ask({ type: "loudnessAt", t: o + t, ...(slot === undefined ? {} : { slot }) }, "loudnessAt");
    return r.buses.map((b) => ({ slot: b.slot, values: b.values && { ...b.values, time: b.values.time - o } }));
  }

  /** The spans outside `target`, on the viewport axis. Warn only: nothing here sends the Worker anything that changes a bus or the target. */
  async marks(target: CaptureLoudnessTarget, options: { metrics?: readonly ("integrated" | "shortTerm" | "momentary")[]; truePeak?: boolean } = {}): Promise<CaptureLoudnessMark[]> {
    const o = this.source.startSeconds;
    const r = await this.ask(
      { type: "loudnessMarks", target: { ...(target.name === undefined ? {} : { name: target.name }), integrated: target.integrated, tolerance: target.tolerance, truePeak: target.truePeak },
        ...(options.metrics ? { metrics: options.metrics } : {}), ...(options.truePeak === undefined ? {} : { truePeak: options.truePeak }) },
      "loudnessMarks",
    );
    return r.marks.map((m) => ({ ...m, from: m.from - o, to: m.to - o }));
  }
}
