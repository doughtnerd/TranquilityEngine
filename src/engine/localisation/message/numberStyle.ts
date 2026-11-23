/**
 * The number styles of ICU messages (ADR 0356 §2) as `Intl.NumberFormat` options: the styles `integer` and `percent`,
 * and skeletons (`::…`) with the tokens `integer`, `percent`, `compact-short`, `compact-long`, `currency/XXX`,
 * `unit/xxx`, fraction digits (`.00`, `.0#`, `.##`), `group-off` and `sign-always`. Unknown tokens are returned for the
 * parse to lint, and ignored.
 *
 * Pure; no plugin, no DOM.
 */

/** The options a number style gives, and the tokens (or the style) it didn't know. */
export function numberStyleOptions(style: string | null): { options: Intl.NumberFormatOptions; unknown: string[] } {
  const options: Intl.NumberFormatOptions = {};
  const unknown: string[] = [];
  if (style === null) return { options, unknown };
  const skeleton = style.startsWith("::");
  for (const token of skeleton ? style.slice(2).trim().split(/\s+/).filter(Boolean) : [style]) {
    const [stem, arg] = token.split("/", 2);
    const fraction = /^\.(0*)(#*)$/.exec(token);
    if (token === "integer") { options.maximumFractionDigits = 0; options.minimumFractionDigits = 0; }
    else if (token === "percent") options.style = "percent";
    else if (skeleton && token === "compact-short") { options.notation = "compact"; options.compactDisplay = "short"; }
    else if (skeleton && token === "compact-long") { options.notation = "compact"; options.compactDisplay = "long"; }
    else if (skeleton && stem === "currency" && /^[A-Za-z]{3}$/.test(arg ?? "")) { options.style = "currency"; options.currency = arg!.toUpperCase(); }
    else if (skeleton && stem === "unit" && /^[a-z]+(-[a-z]+)*$/.test(arg ?? "")) { options.style = "unit"; options.unit = arg; }
    else if (skeleton && fraction && token.length > 1) {
      options.minimumFractionDigits = fraction[1].length;
      options.maximumFractionDigits = fraction[1].length + fraction[2].length;
    } else if (skeleton && token === "group-off") options.useGrouping = false;
    else if (skeleton && token === "sign-always") options.signDisplay = "always";
    else unknown.push(token);
  }
  return { options, unknown };
}

/** The date and time styles a message may name. */
export const DATE_STYLES = ["short", "medium", "long", "full"] as const;
