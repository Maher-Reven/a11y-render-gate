import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contrastProbe } from "../src/probes/contrast.js";
import { classesOf, render, shutdown } from "./helpers.js";
import type { CollectResult } from "../src/core/types.js";
import type { Finding } from "../src/core/findings.js";

describe("contrast probe", () => {
  let collected: CollectResult;
  let findings: Finding[];
  let classes: string[];

  beforeAll(async () => {
    const r = await render("broken/contrast.html");
    collected = r.collected;
    findings = contrastProbe(collected, { reportDisabled: true }).findings;
    classes = classesOf(findings, collected);
    await r.session.close();
  }, 30_000);

  afterAll(async () => {
    await shutdown();
  });

  it("collects the page", () => {
    expect(collected.meta.elementsScanned).toBeGreaterThan(5);
    expect(collected.meta.rootBackground).toBe("rgb(255, 255, 255)");
  });

  it("flags exactly the elements the fixture declares as failing", () => {
    expect(new Set(classes)).toEqual(
      new Set([
        "muted-label",
        "ghost-link",
        "faded",
        "on-brand",
        "small-bold",
        "disabled-hint",
      ]),
    );
  });

  it("does not flag the passing elements — false positives kill a gate", () => {
    expect(classes).not.toContain("body-text");
    expect(classes).not.toContain("large-heading");
    expect(classes).not.toContain("inverse");
  });

  it("reports the computed ratio, not a rule name", () => {
    const muted = findings[classes.indexOf("muted-label")]!;
    expect(muted.facts.foreground).toBe("#8a8a8a");
    expect(muted.facts.background).toBe("#ffffff");
    expect(muted.facts.ratio).toBeCloseTo(3.45, 2);
    expect(muted.facts.required).toBe(4.5);
    expect(muted.facts.fontPx).toBe(14);
  });

  it("composites element opacity into the reported colour", () => {
    // The authored colour is #000000; what renders is a mid grey that fails.
    const faded = findings[classes.indexOf("faded")]!;
    expect(faded.facts.foreground).not.toBe("#000000");
    expect(Number(faded.facts.ratio)).toBeLessThan(4.5);
  });

  it("resolves the background through an ancestor panel", () => {
    const onBrand = findings[classes.indexOf("on-brand")]!;
    expect(onBrand.facts.background).toBe("#f0b429");
  });

  it("applies the large-text bar only where it actually applies", () => {
    // 17px bold is under the 18.66px threshold, so it needs 4.5 and not 3.
    const smallBold = findings[classes.indexOf("small-bold")]!;
    expect(smallBold.facts.required).toBe(4.5);
    expect(smallBold.facts.largeText).toBe(false);
  });

  it("stays silent about disabled text unless asked — 1.4.3 exempts it", () => {
    // Default behaviour: a greyed-out control is correct code, not a finding.
    const defaults = contrastProbe(collected).findings;
    expect(defaults.some((f) => f.severity === "advice")).toBe(false);
    expect(defaults.length).toBe(findings.length - 1);
  });

  it("reports disabled text as advice when explicitly requested", () => {
    const disabled = findings[classes.indexOf("disabled-hint")]!;
    expect(disabled.severity).toBe("advice");
    expect(disabled.facts.disabled).toBe(true);
  });

  it("suggests a fix that genuinely clears the threshold", () => {
    for (const f of findings) {
      if (f.severity === "advice") continue;
      expect(f.fix.css, `${f.label} has no css fix`).toBeDefined();
      const hex = f.fix.css!.match(/#[0-9a-f]{6}/)!;
      expect(hex).not.toBeNull();
      // The fix summary states the resulting ratio; it must clear the requirement.
      const stated = Number(f.fix.summary.match(/\(([\d.]+):1/)?.[1]);
      expect(stated).toBeGreaterThanOrEqual(Number(f.facts.required));
    }
  });

  it("assigns stable ids that survive re-measurement", async () => {
    const again = await render("broken/contrast.html");
    const second = contrastProbe(again.collected, { reportDisabled: true }).findings;
    await again.session.close();
    expect(second.map((f) => f.id).sort()).toEqual(findings.map((f) => f.id).sort());
  }, 30_000);
});
