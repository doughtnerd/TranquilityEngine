// What the 2D tools' stories draw (ADR 0219; T56): a 64 × 32 sheet of four 16 × 32 cells, each a figure of its own colour
// (head, body) so frames and slices tell apart, with its four slices `walk_0`…`walk_3`. Story harness only, like
// `editor/stories/editorStory.tsx`: the editor build never imports it.
import type { SpriteSlice } from "../../../../engine/scene/importSettings";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAgElEQVR42u3WoRGAMBBE0ZREAYhIZDSKMigDSRkRCBSVRNPGopm5uZzP/zMrzzx1KRH9aqXIW+++XKu8de/3Jm+9+/eZ5Q0AAAAAAAAAAPCrOcta9JfIxyJr4futylr0/j4nWQs/QwAAAAAAAAAAAAAAAAAAAAAAAAAAwwEQ0TB90UdrS66ToG8AAAAASUVORK5CYII=";

/** The sheet as a data URL. */
export const SHEET_URL = `data:image/png;base64,${PNG_BASE64}`;

/** The sheet's bytes, for a story project's files. */
export const sheetBytes = (): Uint8Array => Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));

/** The sheet's slices, in the order a grid slice makes them (not name order: the tools order by name). */
export const SHEET_SLICES: readonly SpriteSlice[] = [3, 1, 0, 2].map((i) => ({ name: `walk_${i}`, rect: [i * 16, 0, 16, 32] as [number, number, number, number], pivot: [0.5, 0] as [number, number] }));

/** The sheet's sidecar as the project holds it (`myco.import@1`), with no flipbooks. */
export const SHEET_SIDECAR = { format: "myco.import@1", sprites: SHEET_SLICES.map((s) => ({ name: s.name, rect: [...s.rect], pivot: [...s.pivot] })) };
