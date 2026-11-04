// Spreads thumbnail renders over frames (ADR 0061): at most a few start per frame and run at once,
// so scrolling a large folder never stalls the editor. Jobs whose tile went away are dropped.

export type Schedule = (callback: () => void) => void;

const nextFrame: Schedule = (cb) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => cb()) : setTimeout(cb, 16));

interface Job {
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
}

export class FrameQueue {
  private readonly waiting: Job[] = [];
  private running = 0;
  private scheduled = false;

  constructor(
    /** Jobs started per frame, and the most running at once. */
    private readonly perFrame = 2,
    private readonly schedule: Schedule = nextFrame,
  ) {}

  /** Jobs not started yet. */
  get pending(): number {
    return this.waiting.length;
  }

  /** Run `job` in a later frame. Rejects with an `AbortError` if `signal` aborts before it starts. */
  run<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ run: job, resolve: resolve as (v: unknown) => void, reject, signal });
      this.kick();
    });
  }

  private kick(): void {
    if (this.scheduled || !this.waiting.length) return;
    this.scheduled = true;
    this.schedule(() => this.frame());
  }

  private frame(): void {
    this.scheduled = false;
    let started = 0;
    while (this.waiting.length && started < this.perFrame && this.running < this.perFrame) {
      const job = this.waiting.shift()!;
      if (job.signal?.aborted) {
        job.reject(new DOMException("The thumbnail isn't needed any more.", "AbortError"));
        continue;
      }
      started++;
      this.running++;
      job
        .run()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running--;
          this.kick();
        });
    }
    this.kick();
  }
}
