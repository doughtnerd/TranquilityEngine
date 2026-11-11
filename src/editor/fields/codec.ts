// Field codecs (ADR 0165): how an Inspector field reads stored data into what it shows, writes what the
// user typed back, and turns stored data into its scene-file form. A value's invariants (normalize,
// clamp, round) live in `write` and `toJSON`, so every editor of that value keeps them.

export interface FieldCodec<Stored, Shown> {
  /** Deserialize: data → what the field shows. */
  read(stored: Stored): Shown;
  /** Serialize: what the user typed → data (`previous` is the value being replaced). */
  write(shown: Shown, previous: Stored): Stored;
  /** The scene-file form. */
  toJSON(stored: Stored): unknown;
  /** True when two stored values show as the same (for "mixed" across a multi-selection). */
  same(a: Stored, b: Stored): boolean;
}
