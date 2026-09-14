import { afterAll, describe, expect, it } from "vitest";
import { readAxTree } from "../src/core/axtree.js";
import { keyboardReachProbe } from "../src/probes/keyboard-reach.js";
import { labelWiringProbe } from "../src/probes/label-wiring.js";
import { targetSizeProbe } from "../src/probes/target-size.js";
import { runOnce } from "../src/core/run.js";
import { DEFAULT_CONFIG } from "../src/core/config.js";
import { fixture, render, shutdown } from "./helpers.js";
import type { Finding } from "../src/core/findings.js";
import type { CollectResult } from "../src/core/types.js";

const firstClass = (f: Finding, collected: CollectResult) => {
  const snap = collected.snapshots.find((s) => s.selector === f.selector);
  return snap?.attrs.className?.trim().split(/\s+/)[0] ?? "";
};

afterAll(async () => {
  await shutdown();
});

describe("label wiring", () => {
  it("finds broken wiring that looks correct in the markup", async () => {
    const { session, collected } = await render("broken/labels.html");
    const ax = await readAxTree(session.page);
    const findings = labelWiringProbe(collected, ax);
    await session.close();

    const kinds = findings.map((f) => `${f.selector}|${Object.keys(f.facts).join(",")}`);
    expect(kinds.length).toBeGreaterThan(0);

    // `for` pointing at a non-existent id: the classic silent break.
    const dangling = findings.find((f) => f.facts.for === "emial");
    expect(dangling).toBeDefined();
    expect(dangling!.severity).toBe("serious");

    // aria-labelledby resolving to nothing.
    const badRef = findings.find((f) => f.facts.missingIds === "nonexistent-heading");
    expect(badRef).toBeDefined();

    // Unnamed controls.
    const unnamed = findings.filter((f) => f.facts.computedName === "");
    expect(unnamed.length).toBeGreaterThanOrEqual(2);

    // Placeholder standing in for a label.
    const placeholder = findings.find((f) => f.facts.nameFrom === "placeholder");
    expect(placeholder).toBeDefined();
    expect(placeholder!.severity).toBe("moderate");

    // Image with no alt at all (alt="" is fine and must not appear).
    const noAlt = findings.filter((f) => f.wcag.includes("1.1.1 Non-text Content (A)"));
    expect(noAlt).toHaveLength(1);

    // Visible text not contained in the accessible name (SC 2.5.3).
    const mismatch = findings.find((f) => f.facts.visibleText === "Send message");
    expect(mismatch).toBeDefined();
  }, 30_000);

  it("reads the name the browser computed, not one we re-derived", async () => {
    const { session, collected } = await render("broken/labels.html");
    const ax = await readAxTree(session.page);
    await session.close();
    const wrapped = collected.snapshots.find((s) => s.attrs.id === "wrapped")!;
    const node = ax.find((n) => n.idx === wrapped.idx);
    // A label wrapping its control names it with no `for` attribute anywhere.
    expect(node?.name).toContain("Full name");
  }, 30_000);
});

describe("target size", () => {
  it("flags packed small targets and honours both documented exceptions", async () => {
    const { session, collected } = await render("broken/targets.html");
    await session.close();
    const findings = targetSizeProbe(collected);
    const classes = findings.map((f) => firstClass(f, collected));

    expect(new Set(classes)).toEqual(
      new Set(["tiny-icon", "tiny-icon2", "cramped-a", "cramped-b"]),
    );

    // These three are the reason a naive 24x24 check is unusable.
    expect(classes).not.toContain("isolated");   // spacing exception
    expect(classes).not.toContain("inline-link"); // inline exception
    expect(classes).not.toContain("checkbox");    // UA-sized control
    expect(classes).not.toContain("big-btn");
    // 12px tall, but isolated: the spec's spacing exception genuinely applies.
    expect(classes).not.toContain("thin-bar");
  }, 30_000);

  it("reports the measured size and how much is missing", async () => {
    const { session, collected } = await render("broken/targets.html");
    await session.close();
    const f = targetSizeProbe(collected).find((x) => firstClass(x, collected) === "tiny-icon")!;
    // Form controls are border-box in the UA stylesheet, so 16px width measures 16.
    expect(f.facts.width).toBeCloseTo(16, 0);
    expect(f.facts.required).toBe("24x24");
    expect(f.facts.spacingExceptionApplies).toBe(false);
    expect(f.fix.summary).toMatch(/more on the short side/);
  }, 30_000);
});

describe("keyboard reach", () => {
  it("catches click handlers Tab can never reach", async () => {
    const { session, collected } = await render("broken/keyboard.html");
    const { findings } = await keyboardReachProbe(session.page, collected);
    await session.close();

    const classes = findings.map((f) => firstClass(f, collected));
    expect(classes).toContain("div-button");
    expect(classes).toContain("card-click");
    expect(classes).toContain("jump-ahead");

    expect(classes).not.toContain("real-button");
    expect(classes).not.toContain("roled");
    expect(classes).not.toContain("link");

    // A confirmed handler is now the only trigger. `cursor: pointer` alone flagged
    // 454 elements on one real page — spans inside links, labels forwarding to
    // their input — and zero true positives, so it no longer counts on its own.
    const cursorOnly = collected.snapshots.filter(
      (s) => s.styles.cursor === "pointer" && !s.frameworkClickHandler && s.visible,
    );
    expect(cursorOnly.length).toBeGreaterThan(0);

    // The handler was attached via addEventListener, which no DOM inspection sees.
    const divButton = findings.find((f) => firstClass(f, collected) === "div-button")!;
    expect(divButton.facts.handlerSource).toBe("addEventListener");
    expect(divButton.severity).toBe("critical");
    expect(divButton.fix.html).toContain("<button");
  }, 30_000);
});

/**
 * The most important test in the suite. Recall can be improved over time; a false
 * positive on correct code makes the gate untrustworthy, and an untrustworthy
 * gate gets disabled.
 */
describe("clean fixture — zero findings", () => {
  it("reports nothing at all on a correctly built page", async () => {
    const result = await runOnce(
      { kind: "html", html: fixture("clean/kitchen-sink.html") },
      { name: "desktop", width: 1440, height: 900 },
      "light",
      { config: DEFAULT_CONFIG },
    );

    const summary = result.findings
      .map((f) => `  ${f.severity} ${f.rule} ${f.label} — ${JSON.stringify(f.facts)}`)
      .join("\n");

    expect(result.findings, `unexpected findings:\n${summary}`).toHaveLength(0);
    expect(result.verdict).toBe("pass");
  }, 60_000);
});
