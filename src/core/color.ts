/**
 * Colour maths for contrast findings.
 *
 * Everything here is a pure function over plain numbers so the probes that use it
 * can be unit-tested without a browser. `Rgba` channels are 0-255, alpha 0-1.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  transparent: "rgba(0,0,0,0)",
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  navy: "#000080",
  teal: "#008080",
  olive: "#808000",
  purple: "#800080",
  maroon: "#800000",
  lime: "#00ff00",
  aqua: "#00ffff",
  cyan: "#00ffff",
  fuchsia: "#ff00ff",
  magenta: "#ff00ff",
  yellow: "#ffff00",
  orange: "#ffa500",
};

/**
 * Parse the colour strings a browser actually hands back from `getComputedStyle`,
 * which in Chromium is `rgb()` / `rgba()` / `color(srgb ...)`, plus the hex and
 * named forms that show up in authored CSS and in our own fixtures.
 *
 * Returns null for anything we can't resolve to sRGB (e.g. `currentColor`,
 * gradients, `color(display-p3 ...)`) so callers can fall back to pixel sampling
 * rather than silently reporting a wrong ratio.
 */
export function parseColor(input: string | null | undefined): Rgba | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (s in NAMED) s = NAMED[s]!;

  // #rgb, #rgba, #rrggbb, #rrggbbaa
  if (s.startsWith("#")) {
    const h = s.slice(1);
    const expand = (c: string) => parseInt(c.length === 1 ? c + c : c, 16);
    if (h.length === 3 || h.length === 4) {
      return {
        r: expand(h[0]!),
        g: expand(h[1]!),
        b: expand(h[2]!),
        a: h.length === 4 ? expand(h[3]!) / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: expand(h.slice(0, 2)),
        g: expand(h.slice(2, 4)),
        b: expand(h.slice(4, 6)),
        a: h.length === 8 ? expand(h.slice(6, 8)) / 255 : 1,
      };
    }
    return null;
  }

  // rgb(r g b / a), rgb(r, g, b, a), rgba(...) — modern and legacy syntax both.
  const rgbMatch = s.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const parts = rgbMatch[1]!.split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const chan = (v: string) =>
      v.endsWith("%") ? (parseFloat(v) / 100) * 255 : parseFloat(v);
    const alpha = (v: string | undefined) =>
      v === undefined ? 1 : v.endsWith("%") ? parseFloat(v) / 100 : parseFloat(v);
    const c = {
      r: chan(parts[0]!),
      g: chan(parts[1]!),
      b: chan(parts[2]!),
      a: alpha(parts[3]),
    };
    if ([c.r, c.g, c.b, c.a].some(Number.isNaN)) return null;
    return c;
  }

  // color(srgb 0.1 0.2 0.3 / 0.5)
  const fnMatch = s.match(/^color\(\s*srgb\s+([^)]+)\)$/);
  if (fnMatch) {
    const parts = fnMatch[1]!.split(/[/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const c = {
      r: parseFloat(parts[0]!) * 255,
      g: parseFloat(parts[1]!) * 255,
      b: parseFloat(parts[2]!) * 255,
      a: parts[3] === undefined ? 1 : parseFloat(parts[3]),
    };
    if ([c.r, c.g, c.b, c.a].some(Number.isNaN)) return null;
    return c;
  }

  return null;
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function toHex({ r, g, b }: Rgba): string {
  return (
    "#" +
    [r, g, b].map((c) => clamp255(c).toString(16).padStart(2, "0")).join("")
  );
}

/** Format for display: keeps alpha visible when it matters to the finding. */
export function formatColor(c: Rgba): string {
  if (c.a >= 0.999) return toHex(c);
  return `rgba(${clamp255(c.r)}, ${clamp255(c.g)}, ${clamp255(c.b)}, ${Number(
    c.a.toFixed(3),
  )})`;
}

/**
 * Composite `fg` over `bg` (simple source-over alpha blend).
 *
 * This is what makes contrast numbers correct for the very common case of
 * semi-transparent text or a translucent overlay panel, where naively reading
 * `color` and `background-color` gives a ratio that does not exist on screen.
 */
export function compositeOver(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (f: number, b: number) =>
    (f * fg.a + b * bg.a * (1 - fg.a)) / a;
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a };
}

/**
 * Flatten a stack of layers onto an opaque base.
 * `layers` is ordered furthest-from-viewer first (i.e. ancestor → descendant).
 */
export function flatten(layers: Rgba[], base: Rgba = { r: 255, g: 255, b: 255, a: 1 }): Rgba {
  let out = base;
  for (const layer of layers) out = compositeOver(layer, out);
  return { ...out, a: 1 };
}

function channelLuminance(c8: number): number {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance. Input must already be opaque. */
export function relativeLuminance({ r, g, b }: Rgba): number {
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

/** WCAG 2.x contrast ratio, 1..21. Both colours must already be opaque. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Rounded the way the finding should read it — never rounds *up* past a threshold. */
export function roundRatio(ratio: number): number {
  return Math.floor(ratio * 100) / 100;
}

/**
 * The ratio WCAG 1.4.3 / 1.4.11 demands for this text.
 *
 * Large text is >=24px, or >=18.66px when bold (WCAG defines it in points;
 * these are the CSS pixel equivalents at the default 96dpi mapping).
 */
export function requiredRatio(
  fontPx: number,
  fontWeight: number,
  level: "AA" | "AAA" = "AA",
): number {
  const bold = fontWeight >= 700;
  const large = fontPx >= 24 || (bold && fontPx >= 18.66);
  if (level === "AAA") return large ? 4.5 : 7;
  return large ? 3 : 4.5;
}

export function isLargeText(fontPx: number, fontWeight: number): boolean {
  return fontPx >= 24 || (fontWeight >= 700 && fontPx >= 18.66);
}

// ---------------------------------------------------------------------------
// Fix suggestion
// ---------------------------------------------------------------------------

function toHsl({ r, g, b }: Rgba): { h: number; s: number; l: number } {
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

function fromHsl(h: number, s: number, l: number): Rgba {
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v, a: 1 };
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue2rgb(p, q, h + 1 / 3) * 255,
    g: hue2rgb(p, q, h) * 255,
    b: hue2rgb(p, q, h - 1 / 3) * 255,
    a: 1,
  };
}

export interface ColorSuggestion {
  color: Rgba;
  hex: string;
  ratio: number;
}

/**
 * Nearest colour to `fg` that clears `target` against `bg`, preserving hue and
 * saturation and moving only lightness.
 *
 * Hue preservation is the point: telling someone to replace their brand grey with
 * `#000` is a finding they will ignore. Moving lightness the minimum distance keeps
 * the suggestion visually close enough to accept without a design conversation.
 *
 * Returns null when no lightness of this hue can clear the target against this
 * background (which is itself worth reporting — the background has to change).
 */
export function suggestForeground(
  fg: Rgba,
  bg: Rgba,
  target: number,
): ColorSuggestion | null {
  const { h, s, l } = toHsl(fg);
  const bgLum = relativeLuminance(bg);

  // Move away from the background: darken on a light bg, lighten on a dark one.
  const directions: number[] = bgLum > 0.5 ? [-1, 1] : [1, -1];

  let best: ColorSuggestion | null = null;

  for (const dir of directions) {
    // Binary search the smallest lightness step in this direction that clears target.
    let lo = l;
    let hi = dir < 0 ? 0 : 1;
    const endpoint = fromHsl(h, s, hi);
    if (contrastRatio(endpoint, bg) < target) continue; // unreachable this way

    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      const candidate = fromHsl(h, s, mid);
      if (contrastRatio(candidate, bg) >= target) hi = mid;
      else lo = mid;
    }
    const color = fromHsl(h, s, hi);
    // Re-measure the quantised 8-bit colour, not the float — that is what ships.
    const quantised: Rgba = {
      r: clamp255(color.r),
      g: clamp255(color.g),
      b: clamp255(color.b),
      a: 1,
    };
    let ratio = contrastRatio(quantised, bg);
    // Rounding to 8-bit can drop us a hair under; nudge one step if so.
    if (ratio < target) {
      const nudged = fromHsl(h, s, Math.max(0, Math.min(1, hi + dir * 0.01)));
      const q2: Rgba = {
        r: clamp255(nudged.r),
        g: clamp255(nudged.g),
        b: clamp255(nudged.b),
        a: 1,
      };
      if (contrastRatio(q2, bg) >= target) {
        quantised.r = q2.r;
        quantised.g = q2.g;
        quantised.b = q2.b;
        ratio = contrastRatio(q2, bg);
      } else continue;
    }

    const suggestion: ColorSuggestion = {
      color: quantised,
      hex: toHex(quantised),
      ratio: roundRatio(ratio),
    };
    // Prefer the direction that moved lightness least.
    if (!best || Math.abs(toHsl(quantised).l - l) < Math.abs(toHsl(best.color).l - l)) {
      best = suggestion;
    }
  }

  return best;
}

/**
 * Nearest background that clears `target` for the given text colour.
 *
 * The mirror of `suggestForeground`, and often the better advice: white text on a
 * brand colour cannot be fixed by changing the text without abandoning the design,
 * but darkening the surface keeps it.
 */
export function suggestBackground(
  fg: Rgba,
  bg: Rgba,
  target: number,
): ColorSuggestion | null {
  return suggestForeground(bg, fg, target);
}

/** How far a suggestion moves, in perceptual lightness. Used to pick the smaller edit. */
export function suggestionDistance(from: Rgba, suggestion: ColorSuggestion): number {
  return Math.abs(relativeLuminance(suggestion.color) - relativeLuminance(from));
}

// ---------------------------------------------------------------------------
// APCA (informational only)
// ---------------------------------------------------------------------------

/**
 * APCA-W3 lightness contrast (Lc). Reported alongside the WCAG ratio as context,
 * never used to pass or fail: WCAG 2.x is what is legally cited, and APCA is not
 * yet normative. It earns its place because it is far better at describing thin
 * light-on-dark text, where WCAG 2.x is known to be over-permissive.
 */
export function apcaContrast(text: Rgba, bg: Rgba): number {
  const Y = (c: Rgba) =>
    0.2126729 * Math.pow(c.r / 255, 2.4) +
    0.7151522 * Math.pow(c.g / 255, 2.4) +
    0.072175 * Math.pow(c.b / 255, 2.4);

  const blkThrs = 0.022;
  const blkClmp = 1.414;
  const clampY = (y: number) => (y > blkThrs ? y : y + Math.pow(blkThrs - y, blkClmp));

  const Ytxt = clampY(Y(text));
  const Ybg = clampY(Y(bg));

  if (Math.abs(Ybg - Ytxt) < 0.0005) return 0;

  let sapc: number;
  let out: number;
  if (Ybg > Ytxt) {
    sapc = (Math.pow(Ybg, 0.56) - Math.pow(Ytxt, 0.57)) * 1.14;
    out = sapc < 0.1 ? 0 : sapc - 0.027;
  } else {
    sapc = (Math.pow(Ybg, 0.65) - Math.pow(Ytxt, 0.62)) * 1.14;
    out = sapc > -0.1 ? 0 : sapc + 0.027;
  }
  return Math.round(out * 100 * 10) / 10;
}
