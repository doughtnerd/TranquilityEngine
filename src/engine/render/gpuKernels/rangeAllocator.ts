/**
 * Internal (ADR 0370): first-fit allocation of ranges in one growable table, so many small tables
 * (one bone palette per skeleton) share one GPU buffer or texture and upload together. Pure: it hands
 * out offsets in units the owner chooses (rows, joints) and says how big the table must be; the owner
 * keeps the data. Freed ranges are reused (adjacent free ranges merge); the table only grows.
 */

/** A range of a table: `size` units from `offset`. */
export interface Range {
  readonly offset: number;
  readonly size: number;
}

export class RangeAllocator {
  /** Free ranges below `end`, sorted by offset, never adjacent. */
  private readonly free: { offset: number; size: number }[] = [];
  private top = 0;

  /** Units the table must hold: the end of the highest range ever handed out. */
  get end(): number {
    return this.top;
  }

  /** A range of `size` units (at least 1): the first free one that fits, else at the end. */
  allocate(size: number): Range {
    const n = Math.max(1, Math.ceil(size));
    for (let i = 0; i < this.free.length; i++) {
      const f = this.free[i];
      if (f.size < n) continue;
      const r = { offset: f.offset, size: n };
      if (f.size === n) this.free.splice(i, 1);
      else {
        f.offset += n;
        f.size -= n;
      }
      return r;
    }
    const r = { offset: this.top, size: n };
    this.top += n;
    return r;
  }

  /** Give `range` back (a range from `allocate`, released once). */
  release(range: Range): void {
    let i = 0;
    while (i < this.free.length && this.free[i].offset < range.offset) i++;
    this.free.splice(i, 0, { offset: range.offset, size: range.size });
    // Merge with the next, then with the previous.
    const cur = this.free[i];
    const next = this.free[i + 1];
    if (next && cur.offset + cur.size === next.offset) {
      cur.size += next.size;
      this.free.splice(i + 1, 1);
    }
    const prev = this.free[i - 1];
    if (prev && prev.offset + prev.size === cur.offset) {
      prev.size += cur.size;
      this.free.splice(i, 1);
    }
  }
}
