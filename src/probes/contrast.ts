import {
  apcaContrast,
  compositeOver,
  contrastRatio,
  flatten,
  formatColor,
  isLargeText,
  parseColor,
  requiredRatio,
  roundRatio,
  suggestBackground,
  suggestForeground,
  suggestionDistance,
  type Rgba,
} from "../core/color.js";
import { describeElement, sourceHint } from "../core/describe.js";
import { makeFindingId, type Finding, type Severity } from "../core/findings.js";
import type { CollectResult, ElementSnapshot } from "../core/types.js";

export interface ContrastOptions {
  level?: "AA" | "AAA";
  /**
   * Report disabled controls as `advice`. Off by default: WCAG 1.4.3 exempts
   * inactive components, so a greyed-out button is correct code, and emitting a
   * finding on every run for something the spec permits is noise that trains
   * people to ignore the report.
   */
  reportDisabled?: boolean;
}

/** Elements whose text could not be resolved without looking at real pixels. */
export interface PixelSamplingCandidate {
  snapshot: ElementSnapshot;
  foreground: Rgba;
  required: number;
  reason: "image-background" | "unresolved-background";
}

export interface ContrastResult {
  findings: Finding[];
  /** Handed to the pixel sampler, which resolves what the cascade alone cannot. */
  needsSampling: PixelSamplingCandidate[];
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/**
 * Text contrast against the real composited background.
 *
 * Pure over snapshots, with one escape hatch: when a gradient or image sits behind
 * the text, the cascade cannot tell us the background colour and we hand the
 * element to the pixel sampler instead of guessing. This is the case where axe
 * returns "incomplete" and a human has to go look; returning a number here is a
 * large part of the point of rendering at all.
 */
export function contrastProbe(
  collected: CollectResult,
  options: ContrastOptions = {},
): ContrastResult {
  const { level = "AA", reportDisabled = false } = options;
  const findings: Finding[] = [];
  const needsSampling: PixelSamplingCandidate[] = [];

  const pageBase = parseColor(collected.meta.rootBackground) ?? WHITE;

  for (const s of collected.snapshots) {
    if (!s.visible) continue;
    // Only elements that directly render text: an ancestor's `color` is irrelevant
    // if every visible glyph belongs to a descendant with its own colour.
    if (!s.ownText) continue;
    // Whitespace-only or punctuation-only runs carry no information to read.
    if (!/[\p{L}\p{N}]/u.test(s.ownText)) continue;

    const rawFg = parseColor(s.styles.color);
    if (!rawFg) continue;

    const required = requiredRatio(s.styles.fontSize, s.styles.fontWeight, level);

    // Element opacity multiplies down onto the text, so 30%-opacity black text is
    // not black. Reading `color` alone would pass it; reading what renders fails it.
    const fgWithOpacity: Rgba = { ...rawFg, a: rawFg.a * s.effectiveOpacity };

    if (s.hasImageBackground) {
      needsSampling.push({
        snapshot: s,
        foreground: fgWithOpacity,
        required,
        reason: "image-background",
      });
      continue;
    }

    const layers = s.backgroundStack
      .map(parseColor)
      .filter((c): c is Rgba => c !== null);
    const background = flatten(layers, pageBase);

    const foreground = compositeOver(fgWithOpacity, background);
    const ratio = contrastRatio(foreground, background);

    if (ratio >= required) continue;

    const disabled = s.attrs.disabled === true || isInsideDisabled(s, collected);
    if (disabled && !reportDisabled) continue;

    findings.push(
      buildFinding({
        snapshot: s,
        foreground,
        background,
        ratio,
        required,
        level,
        disabled,
        sampled: false,
      }),
    );
  }

  return { findings, needsSampling };
}

function isInsideDisabled(s: ElementSnapshot, collected: CollectResult): boolean {
  // A disabled fieldset greys out everything inside it, and those contents are
  // exempt from 1.4.3 along with it.
  return s.ancestorIdxs.some(
    (idx) => collected.snapshots.find((o) => o.idx === idx)?.attrs.disabled === true,
  );
}

export interface BuildFindingArgs {
  snapshot: ElementSnapshot;
  foreground: Rgba;
  background: Rgba;
  ratio: number;
  required: number;
  level: "AA" | "AAA";
  disabled: boolean;
  sampled: boolean;
}

export function buildFinding(args: BuildFindingArgs): Finding {
  const { snapshot: s, foreground, background, ratio, required, level, disabled, sampled } = args;

  const fgSuggestion = suggestForeground(foreground, background, required);
  const bgSuggestion = suggestBackground(foreground, background, required);
  const large = isLargeText(s.styles.fontSize, s.styles.fontWeight);

  // Changing the text colour is the usual fix, but not always the right one:
  // white text on a brand colour cannot be recoloured without losing the design,
  // and the smaller edit is to darken the surface. Recommend whichever moves
  // less in perceptual lightness, and name the alternative either way.
  const fgMove = fgSuggestion ? suggestionDistance(foreground, fgSuggestion) : Infinity;
  const bgMove = bgSuggestion ? suggestionDistance(background, bgSuggestion) : Infinity;
  const preferBackground = bgMove < fgMove;

  // WCAG 1.4.3 exempts "inactive user interface components". Failing someone for
  // a disabled control's contrast is wrong, and being wrong about the spec is how
  // a gate loses the authority to block anything.
  const severity: Severity = disabled ? "advice" : ratio < 3 ? "critical" : "serious";

  const facts: Record<string, string | number | boolean> = {
    foreground: formatColor(foreground),
    background: formatColor(background),
    ratio: roundRatio(ratio),
    required,
    fontPx: Math.round(s.styles.fontSize * 10) / 10,
    fontWeight: s.styles.fontWeight,
    largeText: large,
    apcaLc: apcaContrast(foreground, background),
  };
  if (sampled) facts.backgroundSource = "sampled from rendered pixels";
  if (disabled) facts.disabled = true;

  const fix = buildFix({
    disabled,
    required,
    background,
    foreground,
    fgSuggestion,
    bgSuggestion,
    preferBackground,
  });

  if (bgSuggestion && !preferBackground) facts.orBackground = bgSuggestion.hex;

  return {
    id: makeFindingId("contrast", s.selector, `${level}:${s.styles.fontSize}`),
    rule: "contrast",
    severity,
    wcag: [
      level === "AAA"
        ? "1.4.6 Contrast (Enhanced) (AAA)"
        : "1.4.3 Contrast (Minimum) (AA)",
    ],
    selector: s.selector,
    label: describeElement(s),
    facts,
    fix,
    sourceHint: sourceHint(s),
  };
}

interface FixArgs {
  disabled: boolean;
  required: number;
  background: Rgba;
  foreground: Rgba;
  fgSuggestion: ReturnType<typeof suggestForeground>;
  bgSuggestion: ReturnType<typeof suggestBackground>;
  preferBackground: boolean;
}

function buildFix(args: FixArgs): Finding["fix"] {
  const { disabled, required, background, foreground, fgSuggestion, bgSuggestion, preferBackground } =
    args;

  if (disabled && fgSuggestion) {
    return {
      summary:
        `Optional: disabled text is exempt from 1.4.3, but ${fgSuggestion.hex} would reach ` +
        `${fgSuggestion.ratio}:1 if you want it readable.`,
      css: `color: ${fgSuggestion.hex};`,
    };
  }

  if (preferBackground && bgSuggestion) {
    return {
      summary:
        `Set background to ${bgSuggestion.hex} (${bgSuggestion.ratio}:1 with ` +
        `${formatColor(foreground)} text) — a smaller change than recolouring the text` +
        (fgSuggestion ? `, which would need ${fgSuggestion.hex}.` : "."),
      css: `background-color: ${bgSuggestion.hex};`,
    };
  }

  if (fgSuggestion) {
    return {
      summary:
        `Set color to ${fgSuggestion.hex} (${fgSuggestion.ratio}:1 against ` +
        `${formatColor(background)})` +
        (bgSuggestion ? `, or keep the text and set background to ${bgSuggestion.hex}.` : "."),
      css: `color: ${fgSuggestion.hex};`,
    };
  }

  if (bgSuggestion) {
    return {
      summary: `The text colour cannot reach ${required}:1 at any lightness — set background to ${bgSuggestion.hex} instead.`,
      css: `background-color: ${bgSuggestion.hex};`,
    };
  }

  return {
    summary:
      `Neither the text nor the background can reach ${required}:1 without changing hue. ` +
      "Pick a different colour pair.",
  };
}
