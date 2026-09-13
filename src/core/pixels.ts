import { PNG } from "pngjs";
import { contrastRatio, type Rgba } from "./color.js";

export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Buffer;
}

export function decodePng(buffer: Buffer): Bitmap {
  const png = PNG.sync.read(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

export function pixelAt(bmp: Bitmap, x: number, y: number): Rgba {
  const i = (y * bmp.width + x) * 4;
  return {
    r: bmp.data[i] ?? 0,
    g: bmp.data[i + 1] ?? 0,
    b: bmp.data[i + 2] ?? 0,
    a: (bmp.data[i + 3] ?? 255) / 255,
  };
}

export interface DiffResult {
  /** Pixels that differ beyond the noise threshold. */
  changedPixels: number;
  totalPixels: number;
  changedFraction: number;
  /** Bounding box of the changed region, in bitmap coordinates. */
  bbox: { x: number; y: number; w: number; h: number } | null;
  /** Mean colour of the changed pixels in the "after" image — the indicator itself. */
  indicatorColor: Rgba | null;
  /** Mean colour of unchanged pixels near the change — what it sits against. */
  adjacentColor: Rgba | null;
  /** WCAG 1.4.11 ratio between indicator and adjacent. */
  indicatorContrast: number | null;
  /** Largest single-channel delta seen anywhere. */
  maxDelta: number;
}

/**
 * Threshold below which a per-channel difference is treated as rendering noise
 * rather than a real change.
 *
 * Subpixel antialiasing and font rasterisation drift by a few units between
 * otherwise identical renders. Set this too low and every element reports a focus
 * ring it does not have; too high and a faint 1px ring is missed. 10 sits above
 * observed AA noise and below any indicator a person could actually see.
 */
const NOISE_THRESHOLD = 10;

/**
 * Diff two renders of the same region.
 *
 * This is the measurement behind the focus-visibility check: a focus indicator is,
 * definitionally, a visible change when the element receives focus. If nothing
 * changed, there is no indicator — no static analysis can tell you that, and no
 * other a11y tool measures it.
 */
export function diffBitmaps(before: Bitmap, after: Bitmap): DiffResult {
  const width = Math.min(before.width, after.width);
  const height = Math.min(before.height, after.height);
  const totalPixels = width * height;

  let changedPixels = 0;
  let maxDelta = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  let iR = 0, iG = 0, iB = 0;
  let uR = 0, uG = 0, uB = 0, uCount = 0;

  const changedMask = new Uint8Array(totalPixels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bi = (y * before.width + x) * 4;
      const ai = (y * after.width + x) * 4;
      const dr = Math.abs((before.data[bi] ?? 0) - (after.data[ai] ?? 0));
      const dg = Math.abs((before.data[bi + 1] ?? 0) - (after.data[ai + 1] ?? 0));
      const db = Math.abs((before.data[bi + 2] ?? 0) - (after.data[ai + 2] ?? 0));
      const delta = Math.max(dr, dg, db);
      if (delta > maxDelta) maxDelta = delta;

      if (delta > NOISE_THRESHOLD) {
        changedPixels++;
        changedMask[y * width + x] = 1;
        iR += after.data[ai] ?? 0;
        iG += after.data[ai + 1] ?? 0;
        iB += after.data[ai + 2] ?? 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (changedPixels === 0) {
    return {
      changedPixels: 0,
      totalPixels,
      changedFraction: 0,
      bbox: null,
      indicatorColor: null,
      adjacentColor: null,
      indicatorContrast: null,
      maxDelta,
    };
  }

  // "Adjacent" means what the indicator is drawn against, so sample unchanged
  // pixels within a few px of a changed one rather than the whole clip — an
  // average over the entire region would fold in unrelated content.
  const RADIUS = 3;
  // (indicator colour is derived below, once we know what it sits against)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (changedMask[y * width + x]) continue;
      let nearChange = false;
      for (let dy = -RADIUS; dy <= RADIUS && !nearChange; dy++) {
        for (let dx = -RADIUS; dx <= RADIUS; dx++) {
          const ny = y + dy, nx = x + dx;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (changedMask[ny * width + nx]) {
            nearChange = true;
            break;
          }
        }
      }
      if (nearChange) {
        const ai = (y * after.width + x) * 4;
        uR += after.data[ai] ?? 0;
        uG += after.data[ai + 1] ?? 0;
        uB += after.data[ai + 2] ?? 0;
        uCount++;
      }
    }
  }

  const adjacentColor: Rgba | null =
    uCount > 0 ? { r: uR / uCount, g: uG / uCount, b: uB / uCount, a: 1 } : null;

  /**
   * The indicator's colour, taken from its core rather than its average.
   *
   * A focus ring is antialiased: its edge pixels are blends between the ring and
   * the background, and they outnumber the solid interior on a thin ring.
   * Averaging all changed pixels therefore drags the measured colour toward the
   * background and understates contrast — enough to report a false failure
   * against a genuinely visible indicator, such as the browser's own default ring.
   *
   * WCAG 1.4.11 asks whether the indicator contrasts with its surroundings, and a
   * ring with a strongly contrasting core satisfies that regardless of how its
   * edges blend. So: rank changed pixels by distance from what they sit against
   * and average the most distant quartile — robust to stray pixels, and a fair
   * description of the ring a person actually sees.
   */
  let indicatorColor: Rgba = {
    r: iR / changedPixels,
    g: iG / changedPixels,
    b: iB / changedPixels,
    a: 1,
  };

  if (adjacentColor) {
    const distances: { i: number; d: number }[] = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!changedMask[y * width + x]) continue;
        const ai = (y * after.width + x) * 4;
        const d = Math.hypot(
          (after.data[ai] ?? 0) - adjacentColor.r,
          (after.data[ai + 1] ?? 0) - adjacentColor.g,
          (after.data[ai + 2] ?? 0) - adjacentColor.b,
        );
        distances.push({ i: ai, d });
      }
    }
    distances.sort((a, b) => b.d - a.d);
    const coreCount = Math.max(1, Math.ceil(distances.length * 0.25));
    let cR = 0, cG = 0, cB = 0;
    for (let k = 0; k < coreCount; k++) {
      const ai = distances[k]!.i;
      cR += after.data[ai] ?? 0;
      cG += after.data[ai + 1] ?? 0;
      cB += after.data[ai + 2] ?? 0;
    }
    indicatorColor = { r: cR / coreCount, g: cG / coreCount, b: cB / coreCount, a: 1 };
  }

  return {
    changedPixels,
    totalPixels,
    changedFraction: changedPixels / totalPixels,
    bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    indicatorColor,
    adjacentColor,
    indicatorContrast: adjacentColor ? contrastRatio(indicatorColor, adjacentColor) : null,
    maxDelta,
  };
}

/**
 * Dominant colours in a region, used to resolve text contrast over a gradient or
 * image where the cascade cannot tell us the background.
 *
 * Buckets into a coarse colour cube and returns the most populated buckets. Text
 * is a minority of the pixels in its own box, so the largest bucket is the
 * background and the darkest/lightest outlier is usually the glyph colour.
 */
export function dominantColors(
  bmp: Bitmap,
  region: { x: number; y: number; w: number; h: number },
  limit = 4,
): { color: Rgba; fraction: number }[] {
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(bmp.width, Math.ceil(region.x + region.w));
  const y1 = Math.min(bmp.height, Math.ceil(region.y + region.h));
  let total = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * bmp.width + x) * 4;
      const r = bmp.data[i] ?? 0;
      const g = bmp.data[i + 1] ?? 0;
      const b = bmp.data[i + 2] ?? 0;
      // 5 bits per channel: tight enough to separate real colours, loose enough
      // that antialiasing does not shatter one colour into fifty buckets.
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.r += r; bucket.g += g; bucket.b += b; bucket.n++;
      } else {
        buckets.set(key, { r, g, b, n: 1 });
      }
      total++;
    }
  }

  if (total === 0) return [];

  return [...buckets.values()]
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((b) => ({
      color: { r: b.r / b.n, g: b.g / b.n, b: b.b / b.n, a: 1 } as Rgba,
      fraction: b.n / total,
    }));
}
