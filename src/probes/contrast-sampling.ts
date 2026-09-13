import type { Page } from "playwright";
import { compositeOver, contrastRatio, type Rgba } from "../core/color.js";
import { IDX_ATTR } from "../core/collect.js";
import { decodePng, dominantColors } from "../core/pixels.js";
import type { Finding } from "../core/findings.js";
import { buildFinding, type PixelSamplingCandidate } from "./contrast.js";

/**
 * Resolve text contrast by looking at the pixels that actually rendered.
 *
 * When a gradient, photo, or backdrop-filter sits behind text, the cascade cannot
 * tell you the background colour — there isn't one, there are thousands. axe-core
 * reports these as "incomplete" and asks a human to go and look, which is exactly
 * the handoff this tool exists to remove.
 *
 * WCAG requires the text to be readable across its whole run, so the verdict is
 * the *worst* background the glyphs sit on, not the average.
 */
export async function samplePixelContrast(
  page: Page,
  candidates: PixelSamplingCandidate[],
  level: "AA" | "AAA",
): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const candidate of candidates) {
    const { snapshot: s, foreground, required } = candidate;

    const clip = await page.evaluate(
      ({ idx, attr }) => {
        const el = document.querySelector(`[${attr}="${idx}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const x = Math.max(0, Math.floor(r.left));
        const y = Math.max(0, Math.floor(r.top));
        const width = Math.min(window.innerWidth - x, Math.ceil(r.width));
        const height = Math.min(window.innerHeight - y, Math.ceil(r.height));
        if (width <= 1 || height <= 1) return null;
        return { x, y, width, height };
      },
      { idx: s.idx, attr: IDX_ATTR },
    );
    if (!clip) continue;

    let bitmap;
    try {
      bitmap = decodePng(await page.screenshot({ clip, animations: "disabled" }));
    } catch {
      continue;
    }

    const buckets = dominantColors(bitmap, { x: 0, y: 0, w: bitmap.width, h: bitmap.height }, 6);
    if (buckets.length === 0) continue;

    // Glyphs are a minority of the pixels in their own box, so any bucket holding
    // a meaningful share is background rather than text. Ignore buckets close to
    // the known text colour so antialiased glyph edges are not mistaken for it.
    const opaqueForeground = compositeOver(foreground, { r: 255, g: 255, b: 255, a: 1 });
    const backgroundBuckets = buckets.filter(
      (b) => b.fraction >= 0.05 && colorDistance(b.color, opaqueForeground) > 40,
    );
    if (backgroundBuckets.length === 0) continue;

    let worst: { bg: Rgba; ratio: number } | null = null;
    for (const bucket of backgroundBuckets) {
      const composited = compositeOver(foreground, bucket.color);
      const ratio = contrastRatio(composited, bucket.color);
      if (!worst || ratio < worst.ratio) worst = { bg: bucket.color, ratio };
    }
    if (!worst || worst.ratio >= required) continue;

    findings.push(
      buildFinding({
        snapshot: s,
        foreground: compositeOver(foreground, worst.bg),
        background: worst.bg,
        ratio: worst.ratio,
        required,
        level,
        disabled: s.attrs.disabled === true,
        sampled: true,
      }),
    );
  }

  return findings;
}

function colorDistance(a: Rgba, b: Rgba): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}
