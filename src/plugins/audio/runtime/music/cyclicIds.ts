// A cyclic id counter over 1..max that skips ids still in use (ADR 0166 P1: the music group ids, 1..1023, are handed out
// round-robin so a freed id is not reused at once). Allocation-free; the caller says which ids are live.

export class CyclicIdCounter {
  private next_ = 1;

  constructor(private readonly max: number) {}

  /** The next id from the counter that `isLive` doesn't claim, moving the counter past it; 0 when every id is live. */
  next(isLive: (id: number) => boolean): number {
    for (let n = 0; n < this.max; n++) {
      const id = this.next_;
      this.next_ = id >= this.max ? 1 : id + 1;
      if (!isLive(id)) return id;
    }
    return 0;
  }
}
