import type { Page } from "playwright";
import { contrastRatio, formatColor, parseColor, roundRatio, suggestForeground, type Rgba } from "../core/color.js";
import { IDX_ATTR } from "../core/collect.js";
import { describeElement, sourceHint } from "../core/describe.js";
import { makeFindingId, type Finding, type Severity } from "../core/findings.js";
import { decodePng, diffBitmaps, type DiffResult } from "../core/pixels.js";
import type { CollectResult, ElementSnapshot } from "../core/types.js";

export interface FocusOptions {
  /** Cap on elements tested; each costs two screenshots. */
  maxElements?: number;
  /** Padding around the element included in the diff, to catch outline-offset rings. */
  margin?: number;
  /**
   * Minimum fraction of the clip that must change for an indicator to count as
   * perceivable. A 2px ring around a 200x40 button is ~0.05 of the padded clip;
   * anything under this is a sub-pixel shimmer nobody can see.
   */
  minChangedFraction?: number;
  /** WCAG 1.4.11 non-text contrast minimum for the indicator itself. */
  minIndicatorContrast?: number;
}

export interface FocusMeasurement {
  snapshot: ElementSnapshot;
  diff: DiffResult;
}

/**
 * Focus visibility, measured rather than inferred.
 *
 * Screenshot the element at rest, focus it, screenshot again, diff the two crops.
 * Zero changed pixels means the focus indicator does not exist on screen — a fact
 * no static analysis can produce, and one that axe-core does not attempt at all.
 *
 * This is the most common defect in generated UI because every CSS reset contains
 * `outline: none` and the `:focus-visible` replacement is easy to forget, so the
 * failure is invisible to the person who wrote it and to everyone reviewing it.
 */
export async function focusVisibilityProbe(
  page: Page,
  collected: CollectResult,
  options: FocusOptions = {},
): Promise<{ findings: Finding[]; measurements: FocusMeasurement[] }> {
  const {
    maxElements = 40,
    margin = 8,
    minChangedFraction = 0.004,
    minIndicatorContrast = 3,
  } = options;

  const candidates = collected.snapshots
    .filter((s) => s.tabbable && s.visible && s.rect.w > 0 && s.rect.h > 0)
    .slice(0, maxElements);

  const findings: Finding[] = [];
  const measurements: FocusMeasurement[] = [];

  for (const s of candidates) {
    const measured = await measureOne(page, s, margin);
    if (!measured) continue;
    measurements.push({ snapshot: s, diff: measured });
    const finding = evaluate(s, measured, { minChangedFraction, minIndicatorContrast });
    if (finding) findings.push(finding);
  }

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  return { findings, measurements };
}

async function measureOne(
  page: Page,
  s: ElementSnapshot,
  margin: number,
): Promise<DiffResult | null> {
  const locator = page.locator(`[${IDX_ATTR}="${s.idx}"]`);

  try {
    // Scroll first, and clip to the element's *current* box. Focusing can itself
    // scroll the page; if the viewport moved between the two shots the whole clip
    // shifts and the diff reports a focus ring that is really just new content.
    await locator.scrollIntoViewIfNeeded({ timeout: 2_000 });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const clip = await clipFor(page, s.idx, margin);
    if (!clip) return null;

    const scrollBefore = await page.evaluate(() => window.scrollY);
    const before = await page.screenshot({ clip, animations: "disabled" });

    await locator.focus({ timeout: 2_000 });

    const scrollAfter = await page.evaluate(() => window.scrollY);
    if (scrollAfter !== scrollBefore) {
      // Focus moved the viewport. Re-derive the clip and retake both shots so the
      // two images describe the same region of the page.
      const newClip = await clipFor(page, s.idx, margin);
      if (!newClip) return null;
      const afterShifted = await page.screenshot({ clip: newClip, animations: "disabled" });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const beforeShifted = await page.screenshot({ clip: newClip, animations: "disabled" });
      return diffBitmaps(decodePng(beforeShifted), decodePng(afterShifted));
    }

    const after = await page.screenshot({ clip, animations: "disabled" });
    return diffBitmaps(decodePng(before), decodePng(after));
  } catch {
    // An element that cannot be scrolled to or focused is the keyboard-reach
    // probe's problem, not this one's.
    return null;
  }
}

async function clipFor(
  page: Page,
  idx: number,
  margin: number,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate(
    ({ idx, margin, attr }) => {
      const el = document.querySelector(`[${attr}="${idx}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      const x = Math.max(0, Math.floor(r.left - margin));
      const y = Math.max(0, Math.floor(r.top - margin));
      const right = Math.min(window.innerWidth, Math.ceil(r.right + margin));
      const bottom = Math.min(window.innerHeight, Math.ceil(r.bottom + margin));
      const width = right - x;
      const height = bottom - y;
      if (width <= 0 || height <= 0) return null;
      return { x, y, width, height };
    },
    { idx, margin, attr: IDX_ATTR },
  );
}

interface Thresholds {
  minChangedFraction: number;
  minIndicatorContrast: number;
}

export function evaluate(
  s: ElementSnapshot,
  diff: DiffResult,
  { minChangedFraction, minIndicatorContrast }: Thresholds,
): Finding | null {
  const base = {
    selector: s.selector,
    label: describeElement(s),
    sourceHint: sourceHint(s),
    wcag: ["2.4.7 Focus Visible (AA)", "1.4.11 Non-text Contrast (AA)"],
  };

  const suppressed =
    s.styles.outlineStyle === "none" || s.styles.outlineWidth === 0;

  if (diff.changedPixels === 0) {
    return {
      ...base,
      id: makeFindingId("focus-visible", s.selector, "invisible"),
      rule: "focus-visible",
      severity: "critical",
      wcag: ["2.4.7 Focus Visible (AA)"],
      facts: {
        changedPixels: 0,
        maxPixelDelta: diff.maxDelta,
        outlineStyle: s.styles.outlineStyle,
        outlineWidth: s.styles.outlineWidth,
        verdict: "nothing changes on screen when this element receives focus",
      },
      fix: focusFix(s, suppressed),
    };
  }

  if (diff.changedFraction < minChangedFraction) {
    return {
      ...base,
      id: makeFindingId("focus-visible", s.selector, "faint"),
      rule: "focus-visible",
      severity: "serious",
      facts: {
        changedPixels: diff.changedPixels,
        changedFraction: Number(diff.changedFraction.toFixed(5)),
        indicatorColor: diff.indicatorColor ? formatColor(diff.indicatorColor) : "n/a",
        verdict: "focus indicator is too small a change to be perceivable",
      },
      fix: focusFix(s, suppressed),
    };
  }

  if (
    diff.indicatorContrast !== null &&
    diff.indicatorContrast < minIndicatorContrast &&
    diff.adjacentColor &&
    diff.indicatorColor
  ) {
    const severity: Severity = "serious";
    const better = suggestForeground(
      diff.indicatorColor,
      diff.adjacentColor,
      minIndicatorContrast,
    );
    return {
      ...base,
      id: makeFindingId("focus-visible", s.selector, "low-contrast"),
      rule: "focus-visible",
      severity,
      wcag: ["1.4.11 Non-text Contrast (AA)"],
      facts: {
        indicatorColor: formatColor(diff.indicatorColor),
        adjacentColor: formatColor(diff.adjacentColor),
        indicatorContrast: roundRatio(diff.indicatorContrast),
        required: minIndicatorContrast,
        changedPixels: diff.changedPixels,
        verdict: "focus indicator is visible but too low-contrast against its surroundings",
      },
      fix: {
        summary: better
          ? `Use a focus ring colour of ${better.hex} (${better.ratio}:1 against the adjacent surface).`
          : `Increase the focus ring's contrast to at least ${minIndicatorContrast}:1 against its surroundings.`,
        css: better
          ? `:focus-visible {\n  outline: 2px solid ${better.hex};\n  outline-offset: 2px;\n}`
          : undefined,
      },
    };
  }

  return null;
}

/**
 * The fix depends on *why* there is no indicator.
 *
 * When `outline` is explicitly suppressed the cause is nearly always a reset that
 * removed the browser default without replacing it, and naming that is far more
 * actionable than restating the success criterion.
 */
function focusFix(s: ElementSnapshot, outlineSuppressed: boolean): Finding["fix"] {
  const surface = parseColor(s.styles.backgroundColor);
  const ring = pickRingColor(surface);

  // Deliberately generic: the offending elements are listed alongside the
  // finding, and a selector-specific rule here would make every fix string
  // unique, so twelve buttons with one shared cause would print twelve times.
  const css = `:focus-visible {\n  outline: 2px solid ${ring};\n  outline-offset: 2px;\n}`;

  return {
    summary: outlineSuppressed
      ? `outline is set to none with no replacement — add a :focus-visible ring (e.g. 2px solid ${ring}).`
      : `Add a visible :focus-visible indicator (e.g. 2px solid ${ring}, offset 2px).`,
    css,
  };
}

function pickRingColor(surface: Rgba | null): string {
  // A ring has to clear 3:1 against the surface it is drawn on. Default to a blue
  // that does on light surfaces, and flip to a light ring on dark ones.
  const fallbackLight = "#1a5fd0";
  const fallbackDark = "#8ab4ff";
  if (!surface || surface.a === 0) return fallbackLight;
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  const candidate = parseColor(fallbackLight)!;
  if (contrastRatio(candidate, surface) >= 3) return fallbackLight;
  const lightCandidate = parseColor(fallbackDark)!;
  if (contrastRatio(lightCandidate, surface) >= 3) return fallbackDark;
  return contrastRatio(white, surface) >= 3 ? "#ffffff" : "#000000";
}
