import type { ComponentChildren } from "preact";
import "./toolIcons.css";

/**
 * Small inline SVG icons for the editor's tool and transport buttons. They draw in `currentColor`, so
 * they follow the theme (and a button's active/disabled colour). The button that holds one carries the
 * accessible name (`aria-label`) and the tooltip (`title`); the icon itself is hidden from assistive tech.
 */
function Svg(props: { children: ComponentChildren; fill?: boolean }) {
  return (
    <svg
      class="tool-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      fill={props.fill ? "currentColor" : "none"}
      stroke={props.fill ? "none" : "currentColor"}
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {props.children}
    </svg>
  );
}

/** Select: a pointer arrow. */
export const SelectIcon = () => (
  <Svg>
    <path d="M3.5 2.5 L3.5 12.5 L6.3 10 L8.2 13.8 L9.9 13 L8 9.3 L11.8 9.3 Z" />
  </Svg>
);

/** Move: arrows pointing up, down, left and right. */
export const MoveIcon = () => (
  <Svg>
    <path d="M8 1.8 V14.2 M1.8 8 H14.2" />
    <path d="M6.2 3.6 L8 1.8 L9.8 3.6 M6.2 12.4 L8 14.2 L9.8 12.4 M3.6 6.2 L1.8 8 L3.6 9.8 M12.4 6.2 L14.2 8 L12.4 9.8" />
  </Svg>
);

/** Rotate: an arrow running round a circle. */
export const RotateIcon = () => (
  <Svg>
    <path d="M13 8 A5 5 0 1 1 10.5 3.7" />
    <path d="M13.2 2.2 V5.2 H10.2" />
  </Svg>
);

/** Scale: a small box with a diagonal arrow growing out of it. */
export const ScaleIcon = () => (
  <Svg>
    <path d="M2.5 7 V13.5 H9 V7 Z" />
    <path d="M7 9 L13.5 2.5 M9.5 2.5 H13.5 V6.5" />
  </Svg>
);

/** Play: a right-pointing triangle. */
export const PlayIcon = () => (
  <Svg fill>
    <path d="M4 2.5 L13 8 L4 13.5 Z" />
  </Svg>
);

/** Stop: a square. */
export const StopIcon = () => (
  <Svg fill>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
  </Svg>
);

/** Pause: two bars. */
export const PauseIcon = () => (
  <Svg fill>
    <rect x="3.5" y="2.5" width="3" height="11" rx="0.8" />
    <rect x="9.5" y="2.5" width="3" height="11" rx="0.8" />
  </Svg>
);

/** Step: a triangle against a bar (advance one frame). */
export const StepIcon = () => (
  <Svg fill>
    <path d="M3 2.5 L11 8 L3 13.5 Z" />
    <rect x="11.8" y="2.5" width="2.2" height="11" rx="0.8" />
  </Svg>
);

/** Record: a filled dot. */
export const RecordIcon = () => (
  <Svg fill>
    <circle cx="8" cy="8" r="4.5" />
  </Svg>
);

/** Subtitles: a caption box with two lines of text. */
export const SubtitlesIcon = () => (
  <Svg>
    <rect x="1.8" y="3" width="12.4" height="9" rx="1.5" />
    <path d="M4.5 7 H7 M8.5 7 H11.5 M4.5 9.6 H6 M7.5 9.6 H11.5" />
  </Svg>
);
