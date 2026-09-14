import { describe, expect, it } from "vitest";
import {
  acceptIntoBaseline,
  applyBaseline,
  type BaselineFile,
} from "../src/core/baseline.js";
import {
  attachGroupIds,
  distinctProblems,
  makeGroupId,
  type Finding,
  type ProbeFinding,
} from "../src/core/findings.js";

const probeFinding = (selector: string, fixSummary: string): ProbeFinding => ({
  id: `id-${selector}`,
  rule: "contrast",
  severity: "serious",
  wcag: ["1.4.3 Contrast (Minimum) (AA)"],
  selector,
  label: `span "${selector}"`,
  facts: { ratio: 3.54, required: 4.5 },
  fix: { summary: fixSummary, css: "color: #595959;" },
});

const EMPTY: BaselineFile = { version: 1, entries: [] };

/**
 * Defect classes exist because of what real pages do.
 *
 * A news front page produced 240 contrast findings that were one colour decision
 * repeated 240 times, on elements whose ids embed per-story numbers that change
 * hourly. Keyed on the element, a baseline accepted there suppresses nothing an
 * hour later; keyed on the defect, it accepts one decision once and holds.
 */
describe("defect classes", () => {
  it("gives the same group id to the same fix on different elements", () => {
    const findings = attachGroupIds([
      probeFinding("#up_49630353", "Set color to #595959"),
      probeFinding("#up_49638510", "Set color to #595959"),
      probeFinding("#up_49657257", "Set color to #595959"),
    ]);
    const groups = new Set(findings.map((f) => f.groupId));
    expect(groups.size).toBe(1);
    expect(new Set(findings.map((f) => f.id)).size).toBe(3);
  });

  it("separates genuinely different problems", () => {
    const findings = attachGroupIds([
      probeFinding("a", "Set color to #595959"),
      probeFinding("b", "Set color to #767676"),
    ]);
    expect(new Set(findings.map((f) => f.groupId)).size).toBe(2);
  });

  it("counts problems rather than instances", () => {
    const findings = attachGroupIds(
      Array.from({ length: 240 }, (_, i) => probeFinding(`#story-${i}`, "Set color to #595959")),
    );
    expect(findings).toHaveLength(240);
    expect(distinctProblems(findings)).toBe(1);
  });

  it("is stable for the same rule and fix regardless of call site", () => {
    const fix = { summary: "Set color to #595959", css: "color: #595959;" };
    expect(makeGroupId("contrast", fix)).toBe(makeGroupId("contrast", fix));
    expect(makeGroupId("contrast", fix)).not.toBe(makeGroupId("state-contrast", fix));
  });
});

describe("baseline keyed on defect class", () => {
  it("records one entry per problem, not per element", () => {
    const findings = attachGroupIds(
      Array.from({ length: 240 }, (_, i) => probeFinding(`#story-${i}`, "Set color to #595959")),
    );
    const baseline = acceptIntoBaseline(EMPTY, findings, "pre-existing");
    expect(baseline.entries).toHaveLength(1);
    expect(baseline.entries[0]!.instances).toBe(240);
    expect(baseline.entries[0]!.note).toBe("pre-existing");
  });

  it("keeps suppressing after every element selector changes", () => {
    // The property that matters: accept today, and tomorrow's regenerated page
    // with entirely different ids is still covered.
    const today = attachGroupIds([
      probeFinding("#up_49630353", "Set color to #595959"),
      probeFinding("#up_49638510", "Set color to #595959"),
    ]);
    const baseline = acceptIntoBaseline(EMPTY, today);

    const tomorrow = attachGroupIds([
      probeFinding("#up_99999999", "Set color to #595959"),
      probeFinding("#up_88888888", "Set color to #595959"),
      probeFinding("#up_77777777", "Set color to #595959"),
    ]);
    const applied = applyBaseline(tomorrow, baseline);

    expect(applied.active).toHaveLength(0);
    expect(applied.suppressed).toHaveLength(3);
    expect(applied.stale).toHaveLength(0);
  });

  it("still fails a genuinely new problem", () => {
    const baseline = acceptIntoBaseline(
      EMPTY,
      attachGroupIds([probeFinding("#a", "Set color to #595959")]),
    );
    const next = attachGroupIds([
      probeFinding("#b", "Set color to #595959"),
      probeFinding("#c", "Set color to #111111"),
    ]);
    const applied = applyBaseline(next, baseline);

    expect(applied.suppressed).toHaveLength(1);
    expect(applied.active).toHaveLength(1);
    expect(applied.active[0]!.fix.summary).toBe("Set color to #111111");
  });

  it("marks an entry stale once its problem is gone", () => {
    const baseline = acceptIntoBaseline(
      EMPTY,
      attachGroupIds([probeFinding("#a", "Set color to #595959")]),
    );
    const applied = applyBaseline([] as Finding[], baseline);
    expect(applied.stale).toHaveLength(1);
  });
});
