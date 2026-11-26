// The Studio's icons (ADR 0361): one set of stroke icons on a 24-unit grid, drawn in the text colour (`currentColor`), so
// a theme recolours them and a disabled button greys them. An icon is decoration: the button or link it sits in carries
// the name (its text, or `aria-label` when the icon stands alone). Pass `label` only for an icon that means something on
// its own (a warning beside a value), which then reads as an image with that name.
import "./studioIcons.css";

/** Each icon's path data (`d` of one or more `<path>`s; "M…" segments may hold several shapes). */
const PATHS = {
  // Screens
  samples: "M3 12h2M7 8v8M11 4v16M15 7v10M19 10v4M21 12h0",
  playlists: "M4 6h11M4 12h11M4 18h7M17 15v6M17 15l4-1.5v3",
  dialogue: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6",
  mixer: "M6 3v18M12 3v18M18 3v18M4 15h4M10 8h4M16 12h4",
  spatial: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4M3.5 3.5a12 12 0 0 0 0 17M20.5 3.5a12 12 0 0 1 0 17",
  take: "M4 8h16v12H4zM4 8l3-4h13l-3 4M9 4l-3 4M14 4l-3 4M12 14m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
  profiler: "M3 12h4l2-6 4 12 2-6h6",
  packages: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9M8 5.3l8 4.5",
  // Transport
  play: "M7 4.5v15l12-7.5z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  stop: "M6 6h12v12H6z",
  record: "M12 12m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0",
  skipBack: "M6 5v14M18 5v14L9 12z",
  skipForward: "M18 5v14M6 5v14l9-7z",
  loop: "M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4",
  trigger: "M13.5 2L4.5 13.5h6.5L10 22l9.5-12H13z",
  // Actions
  heatmap: "M12 3c.5 3 5 5.5 5 10.5a5 5 0 0 1-10 0c0-2.5 1.5-4 2.5-5.5.3 1.5 1 2.5 2 3 .5-2.5 1-5 .5-8z",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  close: "M6 6l12 12M18 6L6 18",
  check: "M5 12.5l4.5 4.5L19 7",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  import: "M12 3v12M7 10l5 5 5-5M4 17v3h16v-3",
  export: "M12 15V3M7 8l5-5 5 5M4 17v3h16v-3",
  save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
  undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  redo: "M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  history: "M3 12a9 9 0 1 0 2.6-6.4M3 4v4h4M12 7v5l3 2",
  search: "M11 11m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M20 20l-4.5-4.5",
  filter: "M4 5h16l-6 7.5V19l-4 2v-8.5z",
  settings: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  menu: "M4 6h16M4 12h16M4 18h16",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.8M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2",
  folder: "M3 6h6l2 2h10v11H3z",
  folderPlus: "M3 6h6l2 2h10v11H3zM12 11v5M9.5 13.5h5",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  snapshot: "M4 8h3l2-3h6l2 3h3v11H4zM12 13.5m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0",
  // Views and navigation
  chevronDown: "M6 9l6 6 6-6",
  chevronUp: "M6 15l6-6 6 6",
  chevronLeft: "M15 6l-6 6 6 6",
  chevronRight: "M9 6l6 6-6 6",
  zoomIn: "M11 11m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M20 20l-4.5-4.5M8.5 11h5M11 8.5v5",
  zoomOut: "M11 11m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M20 20l-4.5-4.5M8.5 11h5",
  fit: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  // Collapse all (a tree's folders): two chevrons pointing together over a rule.
  collapseAll: "M7 4l5 5 5-5M7 20l5-5 5 5M4 12h16",
  // Opens elsewhere (another screen): a box with an arrow leaving it.
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  panels: "M3 4h18v16H3zM9 4v16",
  // State
  headphones: "M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H4zM17 15h3v5h-3z",
  warning: "M12 3l10 18H2zM12 10v4.5M12 17.5h.01",
  info: "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 11v6M12 7.5h.01",
  keyboard: "M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  volume: "M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12",
  mute: "M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6",
  automate: "M3 19C8 19 9 5 14 5S19 12 21 12",
  // Spatial scene objects (the tool palette)
  pointer: "M5 3l14 8-6 1.5L10 19z",
  emitter: "M12 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M12 12m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0",
  moving: "M6 18m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M8.5 16C12 14 11 9 15 7M15 4h5v5M20 4l-5 5",
  listener: "M12 8m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M5 21a7 7 0 0 1 14 0",
  obstacle: "M8 3h8v18H8zM8 9h8M8 15h8",
  reverbZone: "M4 4h16v16H4zM8 8h8v8H8z",
  audioZone: "M3 9c3-3 6 3 9 0s6-3 9 0M3 15c3-3 6 3 9 0s6-3 9 0",
  note: "M9 18V5l11-2v13M9 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M20 16m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
  // A moving emitter's path (a curve with square ends), attenuation (a source and its waves), a test scene, and
  // collapse all (two chevrons meeting).
  path: "M4 17h3v3H4zM17 4h3v3h-3zM5.5 17C6 10 12 13 18.5 7",
  attenuation: "M6 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M11 8a5.5 5.5 0 0 1 0 8M14.5 5a10 10 0 0 1 0 14M18 3a13 13 0 0 1 0 18",
  scene: "M3 5h18v14H3zM7 15l10-6M7 15m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M17 9m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0",
  // Playlists
  release: "M3 12h13M12 7l5 5-5 5M20 5v14",
  // A note marker on a timeline: a flag on its pole.
  marker: "M6 21V4M6 4h11l-2.5 4L17 12H6",
  // A note region on a timeline: a span between two brackets.
  region: "M4 5v14M20 5v14M4 12h16M8 9l-4 3 4 3M16 9l4 3-4 3",
  razor: "M6 6m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M6 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M8.5 7.8L20 18M8.5 16.2L20 6",
  collapse: "M7 3l5 5 5-5M7 21l5-5 5 5M4 12h16",
} as const;

export type IconName = keyof typeof PATHS;

/** Every icon's name, in the set's order (the component library shows them all). */
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export interface IconProps {
  readonly name: IconName;
  /** Its width and height in CSS px (default 16; scaled with the UI scale by `.studio-glyph`). */
  readonly size?: number;
  /** Only for an icon that means something by itself: it then reads as an image with this name. */
  readonly label?: string;
  readonly class?: string;
  readonly style?: Record<string, string>;
}

/** Shapes drawn filled rather than stroked (the transport's solid glyphs). */
const FILLED: ReadonlySet<IconName> = new Set<IconName>(["play", "pause", "stop", "record", "trigger"]);
/** Icons made of dots, drawn with a heavier stroke so the dots show. */
const DOTS: ReadonlySet<IconName> = new Set<IconName>(["more", "grip"]);

export function Icon(props: IconProps) {
  const size = props.size ?? 16;
  const filled = FILLED.has(props.name);
  return (
    <svg
      class={`studio-glyph${filled ? " filled" : ""}${DOTS.has(props.name) ? " dots" : ""}${props.class ? ` ${props.class}` : ""}`}
      style={{ "--icon-size": `${size}px`, ...props.style } as Record<string, string>}
      viewBox="0 0 24 24"
      {...(props.label ? { role: "img", "aria-label": props.label } : { "aria-hidden": "true", focusable: "false" })}
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}
