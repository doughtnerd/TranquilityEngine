// ADR 0171 amended by 0172 (M5a, task Pf8; api-and-models §7): the Profiler's `banners` slot. It renders the controller's
// banners (`profilerBanners`) with the open refusals in full words: the `CaptureError` code, what it means and, for a
// version or wire mismatch, both versions (`captureErrorMessage`). Errors are `role="alert"`, the rest `role="status"`.
// Theme tokens only (`openSaveFlow.css`). Fill: `profilerSlots.banners = ProfilerBanners`.
import type { ComponentChild } from "preact";
import type { BannersSlotProps, ProfilerBanner } from "./ProfilerPanel";
import { captureErrorMessage, parseErrorBanner } from "./openSaveFlow";
import "./openSaveFlow.css";

/** The words of one banner: an open refusal expands to its code's message; every other banner keeps the controller's text. */
export function bannerText(b: ProfilerBanner): { text: string; code: string | null } {
  const parsed = parseErrorBanner(b.id, b.text);
  if (!parsed) return { text: b.text, code: null };
  return { text: `Can't open ${parsed.file}: ${captureErrorMessage(parsed.code, parsed.detail)}`, code: parsed.code };
}

export function ProfilerBanners({ banners }: BannersSlotProps): ComponentChild {
  return (
    <div class="profiler-banners" role="region" aria-label="Profiler notices">
      {banners.map((b) => {
        const { text, code } = bannerText(b);
        return (
          <p
            key={b.id}
            class="profiler-banner"
            data-banner={b.id}
            data-severity={b.severity}
            {...(code ? { "data-code": code } : {})}
            role={b.severity === "error" ? "alert" : "status"}
          >
            {text}
          </p>
        );
      })}
    </div>
  );
}
