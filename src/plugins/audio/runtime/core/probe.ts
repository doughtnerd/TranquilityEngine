// Feature probes before the core loads (ADR 0157 Platforms; architecture §2.1 fallback rule). Contract K8:
// `service.ts` calls `probeCoreSupport()` before it loads anything, and A0.6 fills this file (AudioWorklet,
// `simd128`, suspended `addModule`, old-engine refusal) without touching `service.ts`.

/** @internal Whether this engine can run the core; when not, `reason` is the one warning the user sees. */
export type ProbeResult = { readonly supported: true } | { readonly supported: false; readonly reason: string };

/** @internal K8 stub: every engine is "supported" until A0.6. Async, so A0.6 can await a module check. */
export async function probeCoreSupport(): Promise<ProbeResult> {
  return { supported: true };
}
