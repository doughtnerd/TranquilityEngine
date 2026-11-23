// A segmented control's keys (ADR 0349): a radio group drawn as joined buttons ("By ear | By eye"). Left and Up
// pick the previous enabled option, Right and Down the next (wrapping), Home and End the first and last.

export interface SegmentOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
  readonly title?: string;
}

/** The option a key moves to from `value`, or null when the key isn't one of the control's or nothing else can be picked. */
export function segmentForKey<T extends string>(options: readonly SegmentOption<T>[], value: T, key: string): T | null {
  const enabled = options.filter((o) => !o.disabled);
  if (enabled.length === 0) return null;
  const at = enabled.findIndex((o) => o.value === value);
  let next: SegmentOption<T> | undefined;
  if (key === "Home") next = enabled[0];
  else if (key === "End") next = enabled[enabled.length - 1];
  else if (key === "ArrowRight" || key === "ArrowDown") next = enabled[(at + 1 + enabled.length) % enabled.length];
  else if (key === "ArrowLeft" || key === "ArrowUp") next = enabled[at < 0 ? enabled.length - 1 : (at - 1 + enabled.length) % enabled.length];
  return next && next.value !== value ? next.value : null;
}
