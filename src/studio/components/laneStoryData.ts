// Shared data for the lane stories (not a story file): one 32 s capture's voices and its game and engine series on a linear axis.
import type { Span } from "./spanLaneModel";
import { linearTimeAxis } from "./timeAxis";
import type { ValuePoint } from "./valueLaneModel";

export const WIDTH = 560;
export const AXIS = linearTimeAxis(0, 32, WIDTH);

export const VOICES: Span[] = [
  { id: "b1", start: 2, end: 4.5, status: "ok", label: "boost_01" },
  { id: "b2", start: 8, end: 11, held: { start: 8.6, end: 10.4 }, status: "ok", label: "boost_02" },
  { id: "b3", start: 14.6, end: 15, status: "blocked", label: "boost (limit 1)" },
  { id: "i1", start: 9, end: 10, status: "ok", label: "lift" },
  { id: "i2", start: 20.2, end: 21.1, status: "stolen", label: "land_hard_03" },
  { id: "i3", start: 20.6, end: 22.4, status: "ok", label: "land_hard_04" },
  { id: "v1", start: 23.7, end: 24, status: "error", label: "vo_rider_07 (missing)" },
  { id: "w1", start: 25, end: null, held: { start: 26, end: null }, status: "virtual", label: "wind (virtual)" },
];

export const SPEED: ValuePoint[] = Array.from({ length: 129 }, (_, i) => {
  const t = i / 4;
  return { t, v: Math.max(0, 80 + 60 * Math.sin(t / 3) + 20 * Math.sin(t * 1.7)) };
});

export const VOICE_COUNT: ValuePoint[] = [0, 2, 4.5, 8, 9, 10, 11, 14.6, 20.2, 21.1, 22.4, 23.7, 25, 32].map((t, i) => ({ t, v: [1, 2, 1, 2, 3, 2, 1, 1, 2, 3, 2, 3, 4, 4][i]! }));
