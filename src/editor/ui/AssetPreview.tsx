// Asset previews (ADR 0061): rendered thumbnails in the Assets panel's tiles, icons for kinds
// without one, hover animation, audio waveforms with a shared clip player, and the Inspector's
// larger previews. Thumbnails come from `../thumbnails` (rendered once, cached by content).
import { effect, signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AssetKind } from "../assetBrowser";
import { autoPlayAudio } from "../preferences";
import { animateThumbnail, audioSummaryFor, canAnimate, contentKeyFor, previewAsset, previewKind, thumbnailFor, type AssetPreviewHandle, type AudioSummary } from "../thumbnails";
import { currentProject, docVersion } from "../state";

// --- tiles ----------------------------------------------------------------------------------------

/** True once `ref` has been on screen (and while it is); tiles out of view never ask for a thumbnail. */
function useVisible(ref: { current: Element | null }): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return setVisible(true);
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { rootMargin: "64px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return visible;
}

/**
 * A rendered thumbnail's URL for `path` while `active`. The request is dropped only when the tile
 * goes away, leaves view or shows another asset; when files change it's asked again under the same
 * signal (cheap while the asset's key is unchanged), so edits elsewhere never restart a render.
 */
function useThumbnail(path: string, active: boolean): string | null {
  const version = docVersion.value;
  const [shown, setShown] = useState<{ path: string; url: string | null }>({ path, url: null });
  const request = useRef<{ path: string; abort: AbortController; seq: number } | null>(null);
  const wanted = active && !!previewKind(path) && previewKind(path) !== "audio";
  // One signal per asset and visibility: aborted on unmount, on leaving view, or for another asset.
  useEffect(() => {
    if (!wanted) return;
    const r = { path, abort: new AbortController(), seq: 0 };
    request.current = r;
    return () => {
      r.abort.abort();
      if (request.current === r) request.current = null;
    };
  }, [path, wanted]);
  useEffect(() => {
    const r = request.current;
    if (!wanted || !r || r.path !== path) return;
    const seq = ++r.seq;
    thumbnailFor(path, r.abort.signal).then(
      (t) => !r.abort.signal.aborted && seq === r.seq && setShown({ path, url: t?.url ?? null }),
      () => undefined,
    );
  }, [path, wanted, version]);
  return shown.path === path ? shown.url : null; // never another asset's picture
}

/** Animate `path` into a canvas while the pointer is over `host` (particle effects, shader graphs using Time). */
function useHoverAnimation(path: string, host: { current: HTMLElement | null }, canvas: { current: HTMLCanvasElement | null }): boolean {
  const [animating, setAnimating] = useState(false);
  useEffect(() => {
    const el = host.current;
    if (!el || !previewKind(path)) return;
    let stop: (() => void) | null = null;
    let over = false;
    const enter = () => {
      over = true;
      void canAnimate(path).then((ok) => {
        if (!ok || !over || !canvas.current) return;
        // Shown once a frame is drawn: while the Inspector's live preview has the renderer, the still stays.
        stop = animateThumbnail(path, canvas.current, () => over && setAnimating(true));
      });
    };
    const leave = () => {
      over = false;
      stop?.();
      stop = null;
      setAnimating(false);
    };
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      leave();
    };
  }, [path]);
  return animating;
}

/**
 * A tile's picture: the rendered thumbnail (models, materials, graphs, environments, particle
 * effects, prefabs), a waveform (audio), or an icon for the kind. The kind's label stays on it as a
 * small badge.
 */
export function TileThumbnail(props: { path: string; kind: AssetKind | "folder"; label: string; name: string }) {
  const { path, kind, label } = props;
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const visible = useVisible(host);
  const url = useThumbnail(path, visible);
  const animating = useHoverAnimation(path, host, canvas);
  const audio = kind === "audio";
  return (
    <div ref={host} class={`asset-preview${url || audio ? " has-preview" : ""}`}>
      {url ? <img class="asset-rendered" src={url} alt="" draggable={false} /> : audio ? <TileWaveform path={path} active={visible} /> : <KindIcon kind={kind} />}
      <canvas ref={canvas} class="asset-animation" width={256} height={256} hidden={!animating} aria-hidden="true" />
      {audio && <PlayButton path={path} name={props.name} />}
      <span class="asset-kind">{label}</span>
    </div>
  );
}

/** An icon for kinds without a rendered preview (or while one loads). */
export function KindIcon(props: { kind: AssetKind | "folder" }) {
  const d = ICONS[props.kind] ?? ICONS.other;
  return (
    <svg class="asset-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const ICONS: Partial<Record<AssetKind | "folder", string>> & { other: string } = {
  folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
  scene: "M4 5h16v14H4zM4 15l4.5-4.5 3.5 3.5 2.5-2.5L20 17M15.5 8.5h.01",
  prefab: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  script: "M9 8l-4 4 4 4M15 8l4 4-4 4M13 6l-2 12",
  javascript: "M9 8l-4 4 4 4M15 8l4 4-4 4M13 6l-2 12",
  typescript: "M9 8l-4 4 4 4M15 8l4 4-4 4M13 6l-2 12",
  text: "M7 3h7l5 5v13H7zM14 3v5h5M10 12h6M10 15h6M10 18h4",
  json: "M9 4H8a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1M15 4h1a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-1",
  audio: "M9 17V6l10-2v11M9 17a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 15a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
  model: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  material: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM6 9a7 7 0 0 1 6-4",
  formation: "M5 5h3v3H5zM10.5 5h3v3h-3zM16 5h3v3h-3zM8 11h3v3H8zM13 11h3v3h-3zM10.5 17h3v3h-3z",
  environment: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
  other: "M7 3h7l5 5v13H7zM14 3v5h5",
};

// --- audio ----------------------------------------------------------------------------------------

/**
 * The one clip playing in the editor (from a tile or the Inspector). Its position is in `clipTime`,
 * which changes several times a second, so only the playing clip's tile and player read it.
 */
export const playingClip = signal<{ path: string; paused: boolean; duration: number; loop: boolean; volume: number } | null>(null);
/** The playing clip's position in seconds. */
export const clipTime = signal(0);

let audio: HTMLAudioElement | null = null;
/** The URL `audio` plays: a rewritten clip gets a new one, and then a new element. */
let audioUrl: string | null = null;

/** Play `path` (stopping any other clip), from `from` seconds when given. */
export function playClip(path: string, from?: number): void {
  const url = currentProject.peek()?.assets.get(path);
  if (typeof url !== "string") return;
  const prev = playingClip.peek();
  if (!audio || prev?.path !== path || audioUrl !== url) {
    stopClip();
    audio = new Audio(url);
    audioUrl = url;
    audio.loop = prev?.loop ?? false;
    audio.volume = prev?.volume ?? 1;
    const el = audio;
    const sync = () => {
      if (audio !== el) return;
      const cur = playingClip.peek();
      const next = { path, paused: el.paused, duration: Number.isFinite(el.duration) ? el.duration : cur?.duration ?? 0, loop: el.loop, volume: el.volume };
      if (!cur || cur.path !== next.path || cur.paused !== next.paused || cur.duration !== next.duration || cur.loop !== next.loop || cur.volume !== next.volume) playingClip.value = next;
    };
    for (const ev of ["play", "pause", "loadedmetadata", "volumechange"]) el.addEventListener(ev, sync);
    el.addEventListener("timeupdate", () => audio === el && (clipTime.value = el.currentTime));
    el.addEventListener("ended", () => {
      if (audio !== el || el.loop) return;
      playingClip.value = { ...playingClip.peek()!, paused: true };
      clipTime.value = 0;
    });
    playingClip.value = { path, paused: true, duration: 0, loop: el.loop, volume: el.volume };
    clipTime.value = 0;
  }
  if (from !== undefined) audio.currentTime = from;
  void audio.play().catch(() => undefined);
}

export function pauseClip(): void {
  audio?.pause();
}

/** Stop and forget the playing clip. */
export function stopClip(): void {
  if (audio) {
    audio.pause();
    audio.src = "";
  }
  audio = null;
  audioUrl = null;
  playingClip.value = null;
  clipTime.value = 0;
}

function setClip(patch: { loop?: boolean; volume?: number }): void {
  if (audio) {
    if (patch.loop !== undefined) audio.loop = patch.loop;
    if (patch.volume !== undefined) audio.volume = patch.volume;
  }
  const cur = playingClip.peek();
  if (cur) playingClip.value = { ...cur, ...patch };
}

// Another project: its clips aren't these. A deleted (or moved) clip stops too.
let lastProject: unknown = null;
effect(() => {
  const project = currentProject.value;
  docVersion.value; // files come and go
  const clip = playingClip.peek();
  if (project !== lastProject || (clip && !project?.files.includes(clip.path))) stopClip();
  lastProject = project;
});

/** The playing clip with its position (the end-to-end test hook). */
const clipState = () => {
  const clip = playingClip.peek();
  return clip ? { ...clip, time: clipTime.peek() } : null;
};
if (typeof window !== "undefined") Object.assign(window, { assetAudio: { state: clipState } });

/** A clip's summary (waveform peaks, length…), loaded while `active`. */
function useAudioSummary(path: string, active: boolean): AudioSummary | null {
  const version = docVersion.value;
  const [summary, setSummary] = useState<AudioSummary | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    audioSummaryFor(path).then(
      (s) => live && setSummary(s),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [path, active, version]);
  return summary;
}

/** A waveform as bars (the theme's colours), with the played part highlighted. */
function Waveform(props: { peaks: readonly number[]; progress?: number; bars?: number }) {
  const bars = Math.max(1, Math.min(props.bars ?? 48, props.peaks.length));
  const step = props.peaks.length / bars;
  const values: number[] = [];
  for (let i = 0; i < bars; i++) {
    let m = 0;
    for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) m = Math.max(m, props.peaks[j] ?? 0);
    values.push(m);
  }
  const played = props.progress ?? 0;
  return (
    <svg class="asset-waveform" viewBox={`0 0 ${bars} 20`} preserveAspectRatio="none" aria-hidden="true">
      {values.map((v, i) => {
        const h = Math.max(0.6, v * 18);
        return <rect key={i} class={i / bars < played ? "played" : ""} x={i + 0.15} y={10 - h / 2} width={0.7} height={h} />;
      })}
    </svg>
  );
}

function TileWaveform(props: { path: string; active: boolean }) {
  const summary = useAudioSummary(props.path, props.active);
  const clip = playingClip.value;
  // Only the playing clip's tile reads the position, so the others don't redraw while it plays.
  const progress = clip?.path === props.path && clip.duration > 0 ? clipTime.value / clip.duration : 0;
  return summary ? <Waveform peaks={summary.peaks} progress={progress} /> : <KindIcon kind="audio" />;
}

/** The ▶/⏸ button a tile shows on hover. */
function PlayButton(props: { path: string; name: string }) {
  const clip = playingClip.value;
  const playing = clip?.path === props.path && !clip.paused;
  return (
    <button
      class={`asset-play${playing ? " playing" : ""}`}
      aria-label={`${playing ? "Pause" : "Play"} ${props.name}`}
      title={playing ? "Pause" : "Play"}
      onPointerDown={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (playing) pauseClip();
        else playClip(props.path);
      }}
    >
      {playing ? "⏸" : "▶"}
    </button>
  );
}

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/**
 * The Inspector's clip player: a waveform to click and seek, play/pause, stop, loop, volume, the
 * clip's length, channels and sample rate, and Auto-play on select.
 */
export function AudioPreview(props: { path: string }) {
  const { path } = props;
  const summary = useAudioSummary(path, true);
  const clip = playingClip.value;
  const mine = clip?.path === path ? clip : null;
  const playing = !!mine && !mine.paused;
  const duration = mine?.duration || summary?.duration || 0;
  const time = mine ? clipTime.value : 0;
  useEffect(() => {
    if (autoPlayAudio.peek()) playClip(path, 0);
    // Leaving this clip's player (another selection) stops it, so nothing plays with no control on screen.
    return () => {
      if (playingClip.peek()?.path === path) stopClip();
    };
  }, [path]);
  const seek = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
    playClip(path, f * duration);
  };
  return (
    <div class="asset-inspector-preview audio-preview" aria-label="Audio preview">
      <div class="audio-wave" role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration * 10) / 10} aria-valuenow={Math.round(time * 10) / 10} tabIndex={0} onClick={seek}>
        {summary ? <Waveform peaks={summary.peaks} progress={mine && duration > 0 ? time / duration : 0} bars={120} /> : <span class="asset-inspector-size">Reading the clip…</span>}
      </div>
      <div class="audio-controls">
        <button aria-label={playing ? "Pause" : "Play"} onClick={() => (playing ? pauseClip() : playClip(path))}>
          {playing ? "⏸ Pause" : "▶ Play"}
        </button>
        <button aria-label="Stop" disabled={!mine} onClick={stopClip}>
          ■ Stop
        </button>
        <label title="Play the clip over and over">
          <input type="checkbox" checked={mine?.loop ?? false} disabled={!mine} onChange={(e) => setClip({ loop: (e.currentTarget as HTMLInputElement).checked })} /> Loop
        </label>
        <label class="audio-volume" title="Preview volume">
          Volume
          <input type="range" min={0} max={1} step={0.05} value={mine?.volume ?? 1} disabled={!mine} aria-label="Volume" onInput={(e) => setClip({ volume: Number((e.currentTarget as HTMLInputElement).value) })} />
        </label>
      </div>
      <span class="asset-inspector-size">
        {mine ? `${clock(time)} / ` : ""}
        {summary ? `${clock(summary.duration)} · ${summary.channels === 1 ? "mono" : summary.channels === 2 ? "stereo" : `${summary.channels} channels`} · ${summary.sampleRate} Hz` : ""}
      </span>
      <label class="audio-autoplay" title="Play a clip as soon as you select it">
        <input type="checkbox" checked={autoPlayAudio.value} onChange={(e) => (autoPlayAudio.value = (e.currentTarget as HTMLInputElement).checked)} /> Auto-play on select
      </label>
    </div>
  );
}

// --- Inspector ------------------------------------------------------------------------------------

/** Radians of turn per pixel dragged, and zoom per wheel notch. */
const ORBIT_SPEED = 0.01;
const ZOOM_STEP = 1.12;

/**
 * A larger preview in the Inspector (models, materials, shader graphs, environments, prefabs): live
 * and orbitable (drag to turn, wheel to zoom, double-click to reset), animating where the asset
 * moves. The rendered still shows until it's drawn, and stays if it can't be.
 */
/**
 * The asset's content key in the open project, checked again when files change: a new key (the
 * asset or something it uses was edited, or another project opened) means a new picture. Null
 * until the first check resolves; "?" when the asset can't be read.
 */
function useContentKey(path: string, active: boolean): string | null {
  const version = docVersion.value;
  const project = currentProject.value;
  const [key, setKey] = useState<{ path: string; project: unknown; key: string } | null>(null);
  useEffect(() => {
    if (!active) return;
    let gone = false;
    void contentKeyFor(path).then((k) => {
      if (gone) return;
      const next = k ?? "?";
      setKey((old) => (old && old.path === path && old.project === project && old.key === next ? old : { path, project, key: next }));
    });
    return () => {
      gone = true;
    };
  }, [path, project, version, active]);
  return key && key.path === path && key.project === project ? key.key : null;
}

export function LargePreview(props: { path: string }) {
  const { path } = props;
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const url = useThumbnail(path, true);
  const [live, setLive] = useState<{ path: string; handle: AssetPreviewHandle } | null>(null);
  const kind = previewKind(path);
  const supported = !!kind && kind !== "audio";
  // The preview is prepared again when the asset's content (or the project) changes, and only then.
  const content = useContentKey(path, supported);
  useEffect(() => {
    const el = canvas.current, box = host.current;
    if (!supported || !el || !box || content === null) return;
    // The canvas draws at its on-screen size in device pixels.
    const fit = () => {
      const r = box.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
        handle.redraw();
      }
    };
    const handle = previewAsset(path, el);
    fit();
    let gone = false;
    void handle.ready.then((ok) => !gone && ok && setLive({ path, handle }));
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    ro?.observe(box);
    return () => {
      gone = true;
      ro?.disconnect();
      handle.stop();
      setLive(null);
    };
  }, [path, supported, content]);
  if (!supported) return null;
  const shown = live?.path === path ? live.handle : null;
  const drag = (e: PointerEvent) => {
    if (!shown || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    let x = e.clientX, y = e.clientY;
    const move = (m: PointerEvent) => {
      shown.orbit(-(m.clientX - x) * ORBIT_SPEED, (m.clientY - y) * ORBIT_SPEED);
      x = m.clientX;
      y = m.clientY;
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return (
    <div
      ref={host}
      class={`asset-inspector-preview asset-large-preview${shown ? " live" : ""}`}
      aria-label="Preview"
      title={shown ? "Drag to turn, scroll to zoom, double-click to reset" : undefined}
      onPointerDown={drag}
      onWheel={(e) => {
        if (!shown) return;
        e.preventDefault();
        shown.zoom(e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
      }}
      onDblClick={() => shown?.reset()}
    >
      {!shown && (url ? <img class="asset-rendered" src={url} alt="" draggable={false} /> : <span class="asset-inspector-size">Rendering a preview…</span>)}
      <canvas ref={canvas} class="asset-live-preview" hidden={!shown} aria-hidden="true" />
    </div>
  );
}
