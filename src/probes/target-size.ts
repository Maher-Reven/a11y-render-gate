import { describeElement, sourceHint } from "../core/describe.js";
import { makeFindingId, type Finding } from "../core/findings.js";
import type { CollectResult, ElementSnapshot } from "../core/types.js";

export interface TargetSizeOptions {
  /** WCAG 2.2 SC 2.5.8 (AA) is 24px; SC 2.5.5 (AAA) is 44px. */
  minPx?: number;
}

/**
 * WCAG 2.2 SC 2.5.8 Target Size (Minimum).
 *
 * The exceptions are the hard part and most of the value. A naive
 * "is it 24x24" check fires on every inline link in a paragraph and on every
 * densely-packed toolbar that is actually fine, and a check that noisy gets
 * switched off within a day. For a gate, a false positive costs far more than a
 * miss, so both documented exceptions are implemented.
 */
export function targetSizeProbe(
  collected: CollectResult,
  options: TargetSizeOptions = {},
): Finding[] {
  const { minPx = 24 } = options;
  const findings: Finding[] = [];

  const targets = collected.snapshots.filter(
    (s) =>
      s.visible &&
      s.interactive &&
      s.tabbable &&
      s.attrs.disabled !== true &&
      s.rect.w > 0 &&
      s.rect.h > 0,
  );

  for (const s of targets) {
    const w = s.rect.w;
    const h = s.rect.h;
    if (w >= minPx && h >= minPx) continue;

    // Exception: "Inline" — a target in a sentence of text, where the line box
    // determines its size and enlarging it would break the paragraph.
    if (s.inlineInText) continue;

    // Exception: "User agent control" — size determined by the UA, not the author.
    if (isUserAgentSized(s)) continue;

    // Exception: "Spacing" — a 24px-diameter circle centred on the target
    // intersects no other target. Undersized but well-separated controls pass.
    if (spacingExceptionApplies(s, targets, minPx)) continue;

    const spacing = minSpacing(s, targets);
    const facts: Record<string, string | number | boolean> = {
      width: Math.round(w * 10) / 10,
      height: Math.round(h * 10) / 10,
      required: `${minPx}x${minPx}`,
    };
    if (spacing !== null) {
      facts.nearestTargetDistance = Math.round(spacing * 10) / 10;
      facts.spacingExceptionApplies = false;
    }

    const shortDimension = Math.min(w, h);
    const grow = Math.ceil(minPx - shortDimension);

    findings.push({
      id: makeFindingId("target-size", s.selector, `${minPx}`),
      rule: "target-size",
      severity: shortDimension < minPx * 0.6 ? "serious" : "moderate",
      wcag: ["2.5.8 Target Size (Minimum) (AA)"],
      selector: s.selector,
      label: describeElement(s),
      facts,
      fix: {
        summary:
          `Grow the target to at least ${minPx}x${minPx} CSS px ` +
          `(currently ${facts.width}x${facts.height}; needs ~${grow}px more on the short side), ` +
          `or leave ${minPx}px of clear space around it.`,
        css: `min-width: ${minPx}px;\nmin-height: ${minPx}px;`,
      },
      sourceHint: sourceHint(s),
    });
  }

  return findings;
}

/**
 * The WCAG 2.2 spacing exception, implemented as the spec words it.
 *
 * "Undersized targets are positioned so that if a 24 CSS pixel diameter circle is
 * centered on the bounding box of each, the circles do not intersect another
 * target or the circle for another undersized target."
 *
 * Two separate tests, and the distinction matters: the circle must clear every
 * other target's *bounding box*, and additionally clear the *circle* of any other
 * undersized target. A plain centre-to-centre distance check passes cases the
 * spec fails, because a large neighbouring target's box can reach into the circle
 * long before its centre does.
 */
function spacingExceptionApplies(
  s: ElementSnapshot,
  all: ElementSnapshot[],
  minPx: number,
): boolean {
  const radius = minPx / 2;
  const cx = s.rect.x + s.rect.w / 2;
  const cy = s.rect.y + s.rect.h / 2;

  for (const other of all) {
    if (other.idx === s.idx) continue;
    // An ancestor or descendant is the same target, not a neighbouring one.
    if (isRelated(s, other)) continue;

    if (circleIntersectsRect(cx, cy, radius, other.rect)) return false;

    const otherUndersized = other.rect.w < minPx || other.rect.h < minPx;
    if (otherUndersized) {
      const ox = other.rect.x + other.rect.w / 2;
      const oy = other.rect.y + other.rect.h / 2;
      if (Math.hypot(cx - ox, cy - oy) < minPx) return false;
    }
  }

  return true;
}

function circleIntersectsRect(
  cx: number,
  cy: number,
  r: number,
  rect: ElementSnapshot["rect"],
): boolean {
  const nearestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const nearestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  return Math.hypot(cx - nearestX, cy - nearestY) < r;
}

/** Nearest other target's centre, reported as context on a failing finding. */
function minSpacing(s: ElementSnapshot, all: ElementSnapshot[]): number | null {
  const cx = s.rect.x + s.rect.w / 2;
  const cy = s.rect.y + s.rect.h / 2;
  let min = Infinity;

  for (const other of all) {
    if (other.idx === s.idx) continue;
    if (isRelated(s, other)) continue;
    const ox = other.rect.x + other.rect.w / 2;
    const oy = other.rect.y + other.rect.h / 2;
    const d = Math.hypot(cx - ox, cy - oy);
    if (d < min) min = d;
  }

  return min === Infinity ? null : min;
}

/** True when one element is an ancestor of the other, in either direction. */
function isRelated(a: ElementSnapshot, b: ElementSnapshot): boolean {
  return a.ancestorIdxs.includes(b.idx) || b.ancestorIdxs.includes(a.idx);
}

/** Controls the browser sizes itself, which authors cannot restyle meaningfully. */
function isUserAgentSized(s: ElementSnapshot): boolean {
  if (s.tag !== "input") return false;
  // Native checkboxes and radios are UA-sized unless explicitly restyled. If the
  // author has set an explicit size we hold them to it; if not, the UA decides.
  const type = s.attrs.type?.toLowerCase();
  if (type !== "checkbox" && type !== "radio") return false;
  const restyled = s.styles.borderWidth > 0 || s.styles.backgroundColor !== "rgba(0, 0, 0, 0)";
  return !restyled;
}
