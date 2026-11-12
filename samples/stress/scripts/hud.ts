/**
 * The Stress sample's readout and soak recorder: a DOM overlay (`pre`) with the core's counters, a rolling record of
 * them, and the soak (a summary line every minute, then a report to copy). Plain DOM, not engine UI, because the report
 * has to be selectable text and the readout has to cost the audio nothing.
 */

/** One reading of `Audio.debug()` (the counters the soak watches). */
export interface Sample {
  status: string;
  underruns: number;
  lateCommands: number;
  logicalVoices: number;
  mixedVoices: number;
  mixedCap: number;
  workUnits: number;
  workUnitsMax: number;
  /** The core's voices rendered with HRTF this quantum: those flagged, plus any still crossfading out after a handover (45 ms). */
  hrtfVoices: number;
  /** Main's HRTF choice (`Audio.debug().core.hrtfFlagged`): at most `voices.hrtf` (ADR 0162). */
  hrtfFlagged: number;
  droppedPlays: number;
  minSlackFrames: number;
  streams: number;
  streamStarves: number;
  streamErrors: number;
  traps: number;
  rebuilds: number;
  sampleRate: number;
}

interface Info {
  phase: string;
  stormSeconds: number;
  started: number;
  startedPlaying: number;
  paused: boolean;
  rateScale: number;
  churning: boolean;
  clipMB: number;
  clipCount: number;
}

interface Plan {
  profile: string;
  logical: number;
  clipMB: number;
  totalRate: number;
  bedRate: number;
  hitRate: number;
}

/** What one soak minute looked like (counters are the minute's increments except the voice counts, which are its last reading). */
interface Row {
  minute: number;
  underruns: number;
  late: number;
  dropped: number;
  starves: number;
  logical: number;
  mixed: number;
  capMin: number;
  wuMax: number;
  stalls: number;
  maxGapMs: number;
  heapMB: number | null;
}

const SOAK_DEFAULT_MINUTES = 30;
const STALL_MS = 100;

const num = (n: number): string => n.toLocaleString("en-US");
const heapMB = (): number | null => {
  const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return m ? m.usedJSHeapSize / 1048576 : null;
};

export class Hud {
  private readonly el: HTMLPreElement | null;
  private readonly box: HTMLDivElement | null;
  private visible = true;
  private plan: Plan | null = null;
  private loading = 0;
  private cur: Sample | null = null;
  private base: Sample | null = null;
  private info: Info | null = null;

  // Everything since the storm started.
  private stormAt = 0;
  private capMin = Infinity;
  private capMax = 0;
  private logicalMax = 0;
  private mixedMax = 0;
  private hrtfMax = 0;
  private hrtfFlaggedMax = 0;
  private wuMax = 0;
  private stalls = 0;
  private maxGapMs = 0;
  readonly capHistory: number[] = [];

  // The soak.
  private soakMinutes = 0;
  private soakAt = 0;
  private soakWanted = false;
  private rows: Row[] = [];
  private rowBase: Sample | null = null;
  private rowCapMin = Infinity;
  private rowWuMax = 0;
  private rowStalls = 0;
  private rowMaxGap = 0;
  private report = "";

  constructor(flags: URLSearchParams) {
    const soak = flags.get("soak");
    if (soak !== null && soak !== "0") {
      this.soakWanted = true;
      this.soakMinutes = Number(soak) > 0 ? Number(soak) : SOAK_DEFAULT_MINUTES;
    }
    if (typeof document === "undefined") {
      this.el = null;
      this.box = null;
      return;
    }
    const style = "position:fixed;left:8px;top:8px;margin:0;padding:8px 10px;z-index:2147483000;font:12px/1.35 ui-monospace,Menlo,Consolas,monospace;color:#d8e0ea;background:rgba(10,14,20,.82);border:1px solid #2b3645;border-radius:4px;";
    this.el = document.createElement("pre");
    this.el.setAttribute("data-stress-hud", "");
    this.el.style.cssText = `${style}pointer-events:none;max-width:min(560px,60vw);overflow:hidden;white-space:pre`;
    document.body.appendChild(this.el);
    this.box = document.createElement("div");
    this.box.style.cssText = `${style}top:auto;bottom:8px;display:none;width:min(640px,90vw)`;
    document.body.appendChild(this.box);
    this.render();
  }

  dispose(): void {
    this.el?.remove();
    this.box?.remove();
  }

  toggle(): void {
    this.visible = !this.visible;
    if (this.el) this.el.style.display = this.visible ? "" : "none";
  }

  setPlan(p: Plan): void {
    this.plan = p;
  }

  setLoading(fraction: number): void {
    this.loading = fraction;
  }

  /** The storm just began: the counters so far (warm-up) are not the soak's. */
  stormStarted(s: Sample): void {
    this.base = s;
    this.stormAt = performance.now();
    if (this.soakWanted) this.beginSoak(s);
  }

  /** Called every frame with the main thread's frame time (ms): a long one is a main-thread stall the core has to ride out. */
  frame(ms: number): void {
    if (!this.base || ms <= 0) return;
    this.maxGapMs = Math.max(this.maxGapMs, ms);
    this.rowMaxGap = Math.max(this.rowMaxGap, ms);
    if (ms > STALL_MS) {
      this.stalls++;
      this.rowStalls++;
    }
  }

  toggleSoak(): void {
    if (this.soakMinutes === 0) this.soakMinutes = SOAK_DEFAULT_MINUTES;
    if (this.soakAt > 0 && !this.report) this.finishSoak("stopped");
    else if (this.base && this.cur) {
      this.report = "";
      this.rows = [];
      this.beginSoak(this.cur);
      this.hideReport();
    } else this.soakWanted = !this.soakWanted;
  }

  /** A reading (twice a second). */
  sample(s: Sample, info: Info): void {
    this.cur = s;
    this.info = info;
    if (this.base) {
      this.capMin = Math.min(this.capMin, s.mixedCap);
      this.capMax = Math.max(this.capMax, s.mixedCap);
      this.logicalMax = Math.max(this.logicalMax, s.logicalVoices);
      this.mixedMax = Math.max(this.mixedMax, s.mixedVoices);
      this.hrtfMax = Math.max(this.hrtfMax, s.hrtfVoices);
      this.hrtfFlaggedMax = Math.max(this.hrtfFlaggedMax, s.hrtfFlagged);
      this.wuMax = Math.max(this.wuMax, s.workUnitsMax);
      this.rowCapMin = Math.min(this.rowCapMin, s.mixedCap);
      this.rowWuMax = Math.max(this.rowWuMax, s.workUnitsMax);
      this.capHistory.push(s.mixedCap);
      if (this.soakAt > 0 && !this.report) this.soakTick(s);
    }
    this.render();
  }

  /** The handle the page and the e2e spec read: `globalThis.__stress`. */
  api(extra: () => Info) {
    return {
      stats: () => {
        const s = this.cur;
        const b = this.base;
        return {
          ...extra(),
          sample: s,
          underrunsSinceStart: s && b ? s.underruns - b.underruns : 0,
          lateSinceStart: s && b ? s.lateCommands - b.lateCommands : 0,
          starvesSinceStart: s && b ? s.streamStarves - b.streamStarves : 0,
          capMin: this.capMin,
          capMax: this.capMax,
          logicalMax: this.logicalMax,
          mixedMax: this.mixedMax,
          hrtfMax: this.hrtfMax,
          hrtfFlaggedMax: this.hrtfFlaggedMax,
          wuMax: this.wuMax,
          stalls: this.stalls,
          maxGapMs: this.maxGapMs,
          capHistory: this.capHistory.slice(),
          plan: this.plan,
        };
      },
      report: () => this.report,
      rows: () => this.rows.slice(),
    };
  }

  // --- Soak ----------------------------------------------------------------------------------------------------------

  private beginSoak(s: Sample): void {
    this.soakAt = performance.now();
    this.rowBase = s;
    this.rowCapMin = Infinity;
    this.rowWuMax = 0;
    this.rowStalls = 0;
    this.rowMaxGap = 0;
    console.log(`[soak] started: ${this.soakMinutes} min, ${this.planText()}`);
  }

  private soakTick(s: Sample): void {
    const minutes = (performance.now() - this.soakAt) / 60_000;
    if (Math.floor(minutes) > this.rows.length) this.closeRow(s);
    if (minutes >= this.soakMinutes) this.finishSoak("complete");
  }

  private closeRow(s: Sample): void {
    const b = this.rowBase!;
    const row: Row = {
      minute: this.rows.length + 1,
      underruns: s.underruns - b.underruns,
      late: s.lateCommands - b.lateCommands,
      dropped: s.droppedPlays - b.droppedPlays,
      starves: s.streamStarves - b.streamStarves,
      logical: s.logicalVoices,
      mixed: s.mixedVoices,
      capMin: this.rowCapMin === Infinity ? s.mixedCap : this.rowCapMin,
      wuMax: this.rowWuMax,
      stalls: this.rowStalls,
      maxGapMs: Math.round(this.rowMaxGap),
      heapMB: heapMB(),
    };
    this.rows.push(row);
    this.rowBase = s;
    this.rowCapMin = Infinity;
    this.rowWuMax = 0;
    this.rowStalls = 0;
    this.rowMaxGap = 0;
    console.log(`[soak] ${this.rowText(row)}`);
  }

  private finishSoak(how: string): void {
    const s = this.cur!;
    const b = this.base!;
    if ((performance.now() - this.soakAt) / 60_000 - this.rows.length > 0.05) this.closeRow(s);
    const minutes = (performance.now() - this.soakAt) / 60_000;
    const underruns = s.underruns - b.underruns;
    const starves = s.streamStarves - b.streamStarves;
    const pass = underruns === 0 && starves === 0 && s.traps === 0 && s.rebuilds === 0;
    const lines = [
      `Myco audio stress soak: ${how}, ${minutes.toFixed(1)} of ${this.soakMinutes} min`,
      `date ${new Date().toISOString()}`,
      `agent ${typeof navigator === "undefined" ? "?" : navigator.userAgent}`,
      `cores ${typeof navigator === "undefined" ? "?" : navigator.hardwareConcurrency}, rate ${s.sampleRate} Hz`,
      `plan ${this.planText()}`,
      "",
      "min  underruns late dropped starves logical mixed capMin wuMax stalls maxGapMs heapMB",
      ...this.rows.map((r) => this.rowText(r)),
      "",
      `total since the storm started: underruns ${underruns}, late commands ${s.lateCommands - b.lateCommands}, dropped plays ${s.droppedPlays - b.droppedPlays}, stream starves ${starves}, stream errors ${s.streamErrors - b.streamErrors}, traps ${s.traps}, rebuilds ${s.rebuilds}`,
      `peaks: logical ${num(this.logicalMax)}, mixed ${this.mixedMax}, hrtf ${this.hrtfFlaggedMax} flagged (${this.hrtfMax} rendering, handovers included), cap ${this.capMin} to ${this.capMax}, work units max ${num(this.wuMax)}, main-thread stalls over ${STALL_MS} ms: ${this.stalls} (longest ${Math.round(this.maxGapMs)} ms)`,
      `gate (0 underruns, 0 starves, no trap or rebuild): ${pass ? "PASS" : "FAIL"}`,
    ];
    this.report = lines.join("\n");
    console.log(`[soak] report\n${this.report}`);
    this.showReport();
  }

  private rowText(r: Row): string {
    const p = (n: number | string, w: number) => String(n).padStart(w);
    return `${p(r.minute, 3)}  ${p(r.underruns, 9)} ${p(r.late, 4)} ${p(r.dropped, 7)} ${p(r.starves, 7)} ${p(r.logical, 7)} ${p(r.mixed, 5)} ${p(r.capMin, 6)} ${p(num(r.wuMax), 6)} ${p(r.stalls, 6)} ${p(r.maxGapMs, 8)} ${p(r.heapMB === null ? "-" : r.heapMB.toFixed(0), 6)}`;
  }

  private planText(): string {
    const p = this.plan;
    return p ? `${p.profile} preset, ${num(p.logical)} logical target, ${p.clipMB} MB clips, ${p.totalRate} starts/s (${p.hitRate.toFixed(0)} hits + ${p.bedRate.toFixed(0)} beds)` : "(not planned yet)";
  }

  private showReport(): void {
    const box = this.box;
    if (!box) return;
    box.style.display = "";
    box.textContent = "";
    const title = document.createElement("div");
    title.textContent = "Soak report (select all and copy, or press Copy)";
    const area = document.createElement("textarea");
    area.value = this.report;
    area.readOnly = true;
    area.style.cssText = "display:block;width:100%;height:240px;margin:6px 0;font:inherit;color:inherit;background:#0a0e14;border:1px solid #2b3645;box-sizing:border-box";
    const copy = document.createElement("button");
    copy.textContent = "Copy";
    copy.onclick = () => {
      area.select();
      void navigator.clipboard?.writeText(this.report).catch(() => document.execCommand?.("copy"));
    };
    const close = document.createElement("button");
    close.textContent = "Close";
    close.style.marginLeft = "6px";
    close.onclick = () => this.hideReport();
    box.append(title, area, copy, close);
  }

  private hideReport(): void {
    if (this.box) this.box.style.display = "none";
  }

  // --- Readout -------------------------------------------------------------------------------------------------------

  private render(): void {
    if (!this.el || !this.visible) return;
    const s = this.cur;
    const i = this.info;
    const out: string[] = ["AUDIO STRESS  (H hides, K soak, 1 pause, 2 rate, 3 churn, 4 snapshot)"];
    if (!s || !i || i.phase !== "running") {
      out.push(i ? { locked: "click the game view to unlock the audio", generating: "generating clips", warming: `loading clips ${(this.loading * 100).toFixed(0)}%` }[i.phase] ?? i.phase : "starting");
      if (this.plan) out.push(this.planText());
    } else {
      const b = this.base!;
      const sec = i.stormSeconds;
      out.push(
        `${this.planText()}`,
        `storm ${sec.toFixed(0)} s${i.paused ? " PAUSED" : ""}  rate x${i.rateScale}  churn ${i.churning ? "on" : "off"}  started ${num(i.started)} (${num(i.startedPlaying)} playing)`,
        `status ${s.status}   clips ${i.clipCount} (${i.clipMB.toFixed(0)} MB)   streams ${s.streams}`,
        `underruns      ${s.underruns - b.underruns}   (since storm start; total ${s.underruns})`,
        `lateCommands   ${s.lateCommands - b.lateCommands}`,
        `logicalVoices  ${num(s.logicalVoices)}   (peak ${num(this.logicalMax)})`,
        `mixedVoices    ${s.mixedVoices} / mixedCap ${s.mixedCap}   (cap ${this.capMin}..${this.capMax})`,
        `hrtfVoices     ${s.hrtfVoices}   (peak ${this.hrtfMax})`,
        `workUnits      ${num(s.workUnits)}   (max ${num(s.workUnitsMax)})`,
        `streamStarves  ${s.streamStarves - b.streamStarves}   errors ${s.streamErrors - b.streamErrors}`,
        `droppedPlays   ${s.droppedPlays - b.droppedPlays}   minSlack ${s.minSlackFrames}`,
        `main stalls >${STALL_MS} ms: ${this.stalls}  (longest ${Math.round(this.maxGapMs)} ms)`,
      );
      if (this.soakAt > 0) {
        const m = (performance.now() - this.soakAt) / 60_000;
        out.push(this.report ? `SOAK done: ${this.report.split("\n").at(-1)}` : `SOAK ${m.toFixed(1)} / ${this.soakMinutes} min, ${this.rows.length} summaries logged`);
      } else out.push(this.soakWanted ? "soak armed" : "soak off (K or ?soak=30)");
    }
    this.el.textContent = out.join("\n");
  }
}
