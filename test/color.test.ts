import { describe, expect, it } from "vitest";
import {
  apcaContrast,
  compositeOver,
  contrastRatio,
  flatten,
  parseColor,
  requiredRatio,
  roundRatio,
  suggestForeground,
  toHex,
} from "../src/core/color.js";

const c = (s: string) => {
  const parsed = parseColor(s);
  if (!parsed) throw new Error(`could not parse ${s}`);
  return parsed;
};

describe("parseColor", () => {
  it("parses the forms a browser actually returns", () => {
    expect(parseColor("rgb(138, 138, 138)")).toEqual({ r: 138, g: 138, b: 138, a: 1 });
    expect(parseColor("rgba(0, 0, 0, 0.5)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor("rgb(255 0 0 / 25%)")).toEqual({ r: 255, g: 0, b: 0, a: 0.25 });
    expect(parseColor("color(srgb 1 0 0)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it("parses authored hex and named forms", () => {
    expect(toHex(c("#8a8a8a"))).toBe("#8a8a8a");
    expect(toHex(c("#f00"))).toBe("#ff0000");
    expect(c("#00000080").a).toBeCloseTo(0.502, 2);
    expect(c("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("returns null rather than guessing at what it cannot resolve", () => {
    // A wrong ratio is worse than no ratio: callers fall back to pixel sampling.
    expect(parseColor("currentColor")).toBeNull();
    expect(parseColor("linear-gradient(red, blue)")).toBeNull();
    expect(parseColor("")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG reference extremes", () => {
    expect(contrastRatio(c("#000000"), c("#ffffff"))).toBeCloseTo(21, 5);
    expect(contrastRatio(c("#ffffff"), c("#ffffff"))).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio(c("#8a8a8a"), c("#ffffff"))).toBeCloseTo(
      contrastRatio(c("#ffffff"), c("#8a8a8a")),
      10,
    );
  });

  it("computes the canonical grey-on-white failures", () => {
    // #8a8a8a on white is the classic 'looks fine, fails AA' generated-UI grey.
    expect(roundRatio(contrastRatio(c("#8a8a8a"), c("#ffffff")))).toBeCloseTo(3.45, 2);
    // #767676 on white is the well-known minimum passing grey.
    expect(contrastRatio(c("#767676"), c("#ffffff"))).toBeGreaterThanOrEqual(4.5);
    // ...and one step lighter fails, which is what makes it the boundary.
    expect(contrastRatio(c("#777777"), c("#ffffff"))).toBeLessThan(4.5);
  });
});

describe("alpha compositing", () => {
  it("blends 50% black over white to the expected mid grey", () => {
    const out = compositeOver(c("rgba(0,0,0,0.5)"), c("#ffffff"));
    expect(Math.round(out.r)).toBe(128);
    expect(out.a).toBe(1);
  });

  it("changes the verdict for semi-transparent text", () => {
    // Read naively, black text always passes. Composited at 30% opacity it does not.
    const naive = contrastRatio(c("#000000"), c("#ffffff"));
    const real = contrastRatio(compositeOver(c("rgba(0,0,0,0.3)"), c("#ffffff")), c("#ffffff"));
    expect(naive).toBeGreaterThan(4.5);
    expect(real).toBeLessThan(4.5);
  });

  it("flattens an ancestor stack onto an opaque base", () => {
    const out = flatten([c("rgba(0,0,0,0.5)"), c("rgba(255,255,255,0.5)")], c("#ffffff"));
    expect(out.a).toBe(1);
    expect(Math.round(out.r)).toBe(191); // 50% white over 50% black over white
  });
});

describe("requiredRatio", () => {
  it("applies the WCAG large-text thresholds", () => {
    expect(requiredRatio(14, 400)).toBe(4.5);
    expect(requiredRatio(24, 400)).toBe(3);
    expect(requiredRatio(19, 700)).toBe(3); // bold >=18.66px counts as large
    expect(requiredRatio(18, 700)).toBe(4.5); // bold but under the bar
    expect(requiredRatio(14, 400, "AAA")).toBe(7);
  });
});

describe("suggestForeground", () => {
  it("produces a colour that actually clears the target", () => {
    const s = suggestForeground(c("#8a8a8a"), c("#ffffff"), 4.5);
    expect(s).not.toBeNull();
    expect(s!.ratio).toBeGreaterThanOrEqual(4.5);
    // Verify independently rather than trusting the reported ratio.
    expect(contrastRatio(c(s!.hex), c("#ffffff"))).toBeGreaterThanOrEqual(4.5);
  });

  it("preserves hue so the suggestion is acceptable to a designer", () => {
    const s = suggestForeground(c("#e57373"), c("#ffffff"), 4.5)!;
    const sug = c(s.hex);
    // Still recognisably red: red channel dominant, and not collapsed to black.
    expect(sug.r).toBeGreaterThan(sug.g);
    expect(sug.r).toBeGreaterThan(sug.b);
    expect(sug.r + sug.g + sug.b).toBeGreaterThan(30);
  });

  it("moves the minimum distance needed", () => {
    // A colour that only just fails should get a nearby suggestion, not black.
    const s = suggestForeground(c("#777777"), c("#ffffff"), 4.5)!;
    expect(c(s.hex).r).toBeGreaterThan(0x60);
  });

  it("lightens instead of darkening on a dark background", () => {
    const s = suggestForeground(c("#444444"), c("#000000"), 4.5)!;
    expect(c(s.hex).r).toBeGreaterThan(0x44);
  });

  it("returns null when the hue cannot clear the target at any lightness", () => {
    // Nothing can reach 7:1 against mid grey without leaving the hue's range.
    expect(suggestForeground(c("#808080"), c("#808080"), 21)).toBeNull();
  });
});

describe("apcaContrast", () => {
  it("reports high Lc for black on white and near zero for no contrast", () => {
    expect(Math.abs(apcaContrast(c("#000000"), c("#ffffff")))).toBeGreaterThan(100);
    expect(apcaContrast(c("#888888"), c("#888888"))).toBe(0);
  });

  it("signs polarity: negative for light text on dark", () => {
    expect(apcaContrast(c("#ffffff"), c("#000000"))).toBeLessThan(0);
    expect(apcaContrast(c("#000000"), c("#ffffff"))).toBeGreaterThan(0);
  });
});
