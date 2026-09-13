import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { makeFindingId, type Finding, type Severity } from "../core/findings.js";

const require = createRequire(import.meta.url);

/**
 * Rules we measure better ourselves, disabled so the two never disagree in the
 * same report.
 *
 * axe computes contrast from the cascade and marks anything over a gradient or
 * image "incomplete"; our probe samples the rendered pixels and returns a number.
 * Its target-size rule does not implement the spacing exception. Reporting both
 * would mean showing the user two different verdicts on one element.
 */
const SUPERSEDED_RULES = ["color-contrast", "color-contrast-enhanced", "target-size"];

const IMPACT_TO_SEVERITY: Record<string, Severity> = {
  critical: "critical",
  serious: "serious",
  moderate: "moderate",
  minor: "advice",
};

export interface AxeOptions {
  /** Conformance tags to run. */
  tags?: string[];
  /** Extra rules to disable. */
  disableRules?: string[];
}

/**
 * axe-core as a breadth backstop.
 *
 * Our own probes go deep on five things that matter most in generated UI. axe
 * covers ninety rules we have not written — ARIA validity, landmark structure,
 * heading order, table semantics, language attributes. Folding its output into the
 * same `Finding` shape means the breadth is free and the report stays one list
 * rather than two tools' worth of output to reconcile.
 */
export async function axeProbe(page: Page, options: AxeOptions = {}): Promise<Finding[]> {
  const {
    tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
    disableRules = [],
  } = options;

  let axeSource: string;
  try {
    axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  } catch {
    return [];
  }

  try {
    await page.evaluate(axeSource);
  } catch {
    return [];
  }

  const results = (await page.evaluate(
    async ({ tags, disabled }) => {
      const axe = (window as any).axe;
      if (!axe) return null;
      const rules: Record<string, { enabled: boolean }> = {};
      for (const id of disabled) rules[id] = { enabled: false };
      try {
        return await axe.run(document, {
          runOnly: { type: "tag", values: tags },
          rules,
          resultTypes: ["violations"],
          // Our probes already own the rendered-pixel questions; this keeps axe
          // to the structural rules it is genuinely best at.
          reporter: "v1",
        });
      } catch {
        return null;
      }
    },
    { tags, disabled: [...SUPERSEDED_RULES, ...disableRules] },
  )) as any;

  if (!results?.violations) return [];

  const findings: Finding[] = [];

  for (const violation of results.violations) {
    for (const node of violation.nodes ?? []) {
      const selector = Array.isArray(node.target) ? String(node.target[0] ?? "") : String(node.target);
      if (!selector) continue;

      const detail: string =
        node.failureSummary?.replace(/\s*\n\s*/g, " ").trim() || violation.help;

      findings.push({
        id: makeFindingId("axe", selector, violation.id),
        rule: "axe",
        severity: IMPACT_TO_SEVERITY[node.impact ?? violation.impact] ?? "moderate",
        wcag: (violation.tags ?? [])
          .filter((t: string) => /^wcag\d/.test(t))
          .map((t: string) => formatWcagTag(t)),
        selector,
        label: shorten(node.html ?? selector),
        facts: {
          axeRule: violation.id,
          issue: violation.help,
          detail: shorten(detail, 200),
        },
        fix: {
          summary: violation.help,
          html: node.html ? shorten(node.html, 160) : undefined,
        },
        sourceHint: violation.helpUrl,
      });
    }
  }

  return findings;
}

/** `wcag143` -> `1.4.3`, so axe findings read like the rest of the report. */
function formatWcagTag(tag: string): string {
  const digits = tag.replace(/^wcag/, "");
  if (!/^\d{3,}$/.test(digits)) return tag;
  return `${digits[0]}.${digits[1]}.${digits.slice(2)}`;
}

function shorten(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
