import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { focusVisibilityProbe, type FocusMeasurement } from "../src/probes/focus-visibility.js";
import { render, shutdown } from "./helpers.js";
import type { Finding } from "../src/core/findings.js";
import type { CollectResult } from "../src/core/types.js";

/**
 * The focus-visibility check has no prior art, so it gets the most direct tests:
 * the measurement itself is asserted, not just the findings derived from it.
 */
describe("focus visibility (pixel diff)", () => {
  let findings: Finding[];
  let measurements: FocusMeasurement[];
  let collected: CollectResult;

  const classOf = (m: FocusMeasurement) =>
    m.snapshot.attrs.className?.trim().split(/\s+/)[0] ?? m.snapshot.selector;

  const measurementFor = (cls: string) => {
    const m = measurements.find((x) => classOf(x) === cls);
    if (!m) throw new Error(`no measurement for .${cls}`);
    return m;
  };

  const findingClasses = () =>
    findings.map((f) => {
      const snap = collected.snapshots.find((s) => s.selector === f.selector);
      return snap?.attrs.className?.trim().split(/\s+/)[0] ?? f.selector;
    });

  beforeAll(async () => {
    const r = await render("broken/focus.html");
    collected = r.collected;
    const result = await focusVisibilityProbe(r.session.page, collected);
    findings = result.findings;
    measurements = result.measurements;
    await r.session.close();
  }, 60_000);

  afterAll(async () => {
    await shutdown();
  });

  it("measures every focusable control", () => {
    expect(measurements).toHaveLength(8);
  });

  it("detects a removed outline as literally zero changed pixels", () => {
    // The core claim of this probe: nothing renders differently on focus.
    expect(measurementFor("no-outline").diff.changedPixels).toBe(0);
    expect(measurementFor("reset-all").diff.changedPixels).toBe(0);
  });

  it("sees a real indicator where one exists", () => {
    expect(measurementFor("default-ring").diff.changedPixels).toBeGreaterThan(0);
    expect(measurementFor("custom-ring").diff.changedPixels).toBeGreaterThan(0);
    expect(measurementFor("shadow-ring").diff.changedPixels).toBeGreaterThan(0);
  });

  it("flags exactly the three broken controls", () => {
    expect(new Set(findingClasses())).toEqual(
      new Set(["no-outline", "reset-all", "faint-ring", "ghost-ring"]),
    );
  });

  it("passes all three correct controls, including a box-shadow ring", () => {
    // A box-shadow indicator is valid; a checker that only reads `outline` would
    // report a false positive here and get itself switched off.
    const flagged = findingClasses();
    expect(flagged).not.toContain("default-ring");
    expect(flagged).not.toContain("custom-ring");
    expect(flagged).not.toContain("shadow-ring");
  });

  it("does not mistake a thin antialiased ring for a low-contrast one", () => {
    // A 1px ring is mostly edge pixels blending into the background. Averaging
    // them drags the measured colour toward the background and fails a ring that
    // is plainly visible — which is what happened to the browser's own default
    // ring before the indicator colour was taken from the ring's core instead.
    expect(findingClasses()).not.toContain("thin-ring");
    const m = measurementFor("thin-ring");
    expect(m.diff.changedPixels).toBeGreaterThan(0);
    expect(m.diff.indicatorContrast!).toBeGreaterThanOrEqual(3);
  });

  it("rates an invisible indicator critical and a weak one serious", () => {
    const byClass = Object.fromEntries(
      findings.map((f) => {
        const snap = collected.snapshots.find((s) => s.selector === f.selector);
        return [snap?.attrs.className?.trim().split(/\s+/)[0], f];
      }),
    );
    expect(byClass["no-outline"]!.severity).toBe("critical");
    expect(byClass["reset-all"]!.severity).toBe("critical");
    expect(byClass["faint-ring"]!.severity).toBe("serious");
    // A ring below the perception floor is reported as absent, not as weak:
    // "you can't see it" is the same defect however the CSS got there.
    expect(byClass["ghost-ring"]!.severity).toBe("critical");
    expect(measurementFor("ghost-ring").diff.changedPixels).toBe(0);
  });

  it("measures the weak ring's contrast rather than guessing at it", () => {
    const m = measurementFor("faint-ring");
    expect(m.diff.changedPixels).toBeGreaterThan(0);
    expect(m.diff.indicatorContrast).not.toBeNull();
    expect(m.diff.indicatorContrast!).toBeLessThan(3);

    // The finding carries the measured numbers, which is what makes it fixable.
    const finding = findings.find((f) => f.facts.indicatorContrast !== undefined)!;
    expect(finding).toBeDefined();
    expect(Number(finding.facts.indicatorContrast)).toBeLessThan(3);
    expect(finding.facts.required).toBe(3);
    expect(finding.fix.css).toContain("outline");
  });

  it("names the cause when an outline was explicitly suppressed", () => {
    const f = findings.find((x) => x.fix.summary.includes("outline is set to none"));
    expect(f).toBeDefined();
    expect(f!.fix.css).toContain(":focus-visible");
    expect(f!.fix.css).toContain("outline-offset");
  });
});
