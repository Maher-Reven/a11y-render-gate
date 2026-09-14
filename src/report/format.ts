import {
  groupFindings,
  severityRank,
  type Finding,
  type RunCounts,
  type Severity,
} from "../core/findings.js";

export interface FormatOptions {
  /** Max distinct findings rendered per rule before collapsing. */
  perRuleLimit?: number;
  /** Include ANSI colour. Off for MCP and hook output. */
  color?: boolean;
  /** Path to the full JSON, offered as the escape valve. */
  jsonPath?: string;
  /** Delta against the previous run, when there was one. */
  delta?: { fixed: number; introduced: number; remaining: number };
  /** Count of findings hidden by the baseline. */
  suppressed?: number;
  showAdvice?: boolean;
}

export interface FormatInput {
  verdict: "pass" | "fail";
  source: string;
  context: string;
  findings: Finding[];
  counts: RunCounts;
  durationMs: number;
  elementsScanned: number;
}

const ANSI = {
  reset: "[0m",
  dim: "[2m",
  bold: "[1m",
  red: "[31m",
  yellow: "[33m",
  green: "[32m",
  cyan: "[36m",
};

/**
 * The agent-facing report.
 *
 * Budget is the design constraint. A raw axe dump runs 5-10k tokens, and a check
 * that expensive gets called once and then avoided — which defeats the entire
 * purpose, since the value is in re-running after a fix. The target here is around
 * 1200 tokens for a typical failing run, achieved by severity ordering, collapsing
 * identical fixes, capping per rule, and writing the full detail to disk instead
 * of into the conversation.
 */
export function formatReport(input: FormatInput, options: FormatOptions = {}): string {
  const {
    perRuleLimit = 3,
    color = false,
    jsonPath,
    delta,
    suppressed = 0,
    showAdvice = false,
  } = options;

  const c = (code: string, text: string) => (color ? `${code}${text}${ANSI.reset}` : text);
  const lines: string[] = [];

  const visible = showAdvice
    ? input.findings
    : input.findings.filter((f) => f.severity !== "advice");

  // --- Header ---------------------------------------------------------------

  if (input.verdict === "pass") {
    lines.push(
      `${c(ANSI.green + ANSI.bold, "a11y-render-gate PASS")}  ${input.source}`,
      `${c(ANSI.dim, `${input.context} · ${input.elementsScanned} elements · ${fmtMs(input.durationMs)}`)}`,
    );
    if (suppressed > 0) {
      lines.push(c(ANSI.dim, `${suppressed} known finding${suppressed === 1 ? "" : "s"} suppressed by baseline`));
    }

    // Passing the gate is not the same as having nothing to report. Findings
    // below the failure threshold are still real defects; swallowing them because
    // they did not block would quietly make `failOn` a filter on the truth rather
    // than a policy about when to stop the turn.
    if (visible.length > 0) {
      lines.push("");
      lines.push(
        c(ANSI.dim, `${visible.length} finding${visible.length === 1 ? "" : "s"} below the failure threshold:`),
      );
      for (const group of groupFindings(visible).slice(0, 6)) {
        const f = group.representative;
        const count = group.others.length + 1;
        lines.push(
          `  ${c(ANSI.dim, f.severity)} ${f.rule}  ${f.label}${count > 1 ? c(ANSI.dim, ` ×${count}`) : ""}`,
        );
        lines.push(`    ${factLine(f)}`);
        lines.push(`    ${c(ANSI.cyan, "→")} ${f.fix.summary}`);
      }
      if (jsonPath) lines.push(c(ANSI.dim, `full detail: ${jsonPath}`));
    }
    return lines.join("\n");
  }

  lines.push(
    `${c(ANSI.red + ANSI.bold, "a11y-render-gate FAIL")}  ${input.source}`,
    c(ANSI.dim, `${input.context} · ${input.elementsScanned} elements · ${fmtMs(input.durationMs)}`),
  );

  if (delta && (delta.fixed > 0 || delta.introduced > 0)) {
    // Movement since the last run is what makes a second call cheap to read.
    lines.push(
      c(
        ANSI.cyan,
        `${delta.fixed} fixed · ${delta.remaining} still failing · ${delta.introduced} new`,
      ),
    );
  }
  lines.push("");

  // --- Findings, grouped by identical fix -----------------------------------

  const groups = groupFindings(visible).sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      b.others.length - a.others.length,
  );

  const renderedPerRule = new Map<string, number>();

  for (const group of groups) {
    const shown = renderedPerRule.get(group.rule) ?? 0;
    if (shown >= perRuleLimit) continue;
    renderedPerRule.set(group.rule, shown + 1);

    const f = group.representative;
    const count = group.others.length + 1;
    const sevColor =
      f.severity === "critical" ? ANSI.red : f.severity === "serious" ? ANSI.yellow : ANSI.dim;

    lines.push(
      `${c(sevColor + ANSI.bold, f.severity)} ${c(ANSI.bold, f.rule)}${count > 1 ? c(ANSI.dim, `  ×${count}`) : ""}`,
    );
    lines.push(`  ${f.label}  ${c(ANSI.dim, f.selector)}`);
    lines.push(`    ${factLine(f)}`);
    lines.push(`    ${c(ANSI.cyan, "→")} ${f.fix.summary}`);
    if (f.fix.css) lines.push(indentBlock(f.fix.css, "       "));
    if (f.fix.html) lines.push(indentBlock(f.fix.html, "       "));
    if (f.sourceHint) lines.push(c(ANSI.dim, `    ${f.sourceHint}`));

    if (group.others.length > 0) {
      // Same fix, other elements: naming them is enough, repeating the fix is not.
      const names = group.others.slice(0, 4).map((o) => o.label).join(", ");
      const extra = group.others.length > 4 ? `, +${group.others.length - 4} more` : "";
      lines.push(c(ANSI.dim, `    same fix applies to: ${names}${extra}`));
    }
    lines.push("");
  }

  // Rules whose groups were capped still need to be accounted for.
  for (const [rule, shown] of renderedPerRule) {
    const totalGroups = groups.filter((g) => g.rule === rule).length;
    if (totalGroups > shown) {
      lines.push(
        c(ANSI.dim, `… ${totalGroups - shown} more distinct ${rule} finding${totalGroups - shown === 1 ? "" : "s"} not shown`),
      );
    }
  }

  // --- Footer ---------------------------------------------------------------

  const tally = (["critical", "serious", "moderate"] as Severity[])
    .filter((s) => input.counts[s] > 0)
    .map((s) => `${input.counts[s]} ${s}`)
    .join(", ");

  const footer = [tally || "no blocking findings"];
  if (suppressed > 0) footer.push(`${suppressed} baselined`);
  if (jsonPath) footer.push(`full detail: ${jsonPath}`);
  lines.push(c(ANSI.dim, footer.join(" · ")));

  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * The computed values, on one line.
 *
 * This is the payload that distinguishes the tool from a rule name: an agent can
 * act on "#8a8a8a on #ffffff = 3.45:1, need 4.5" in one step, and has to guess at
 * "insufficient colour contrast".
 */
function factLine(f: Finding): string {
  const { facts } = f;

  if (f.rule === "contrast" || f.rule === "state-contrast") {
    const size = `${facts.fontPx}px${facts.fontWeight && Number(facts.fontWeight) >= 700 ? " bold" : ""}`;
    const sampled = facts.backgroundSource ? " (background sampled from pixels)" : "";
    return `${facts.foreground} on ${facts.background} = ${facts.ratio}:1, need ${facts.required} (${size})${sampled}`;
  }

  if (f.rule === "focus-visible") {
    if (facts.changedPixels === 0) return "0 pixels change when focused — no indicator renders";
    if (facts.indicatorContrast !== undefined) {
      return `indicator ${facts.indicatorColor} on ${facts.adjacentColor} = ${facts.indicatorContrast}:1, need ${facts.required}`;
    }
    return `only ${facts.changedPixels} px change when focused (${facts.changedFraction} of the control)`;
  }

  if (f.rule === "target-size") {
    const near =
      facts.nearestTargetDistance !== undefined
        ? `, nearest target ${facts.nearestTargetDistance}px away`
        : "";
    return `${facts.width}×${facts.height}px, need ${facts.required}${near}`;
  }

  if (f.rule === "label-wiring") {
    if (facts.missingIds) return `${f.facts.verdict} → ${facts.missingIds}`;
    if (facts.for) return `for="${facts.for}" matches no element in the document`;
    if (facts.computedName === "") return `accessible name is empty (role: ${facts.role})`;
    if (facts.nameFrom === "placeholder") return `named only by its placeholder: "${facts.computedName}"`;
    if (facts.visibleText) return `visible "${facts.visibleText}" vs announced "${facts.computedName}"`;
  }

  if (f.rule === "keyboard-reach") {
    if (facts.handlerSource !== undefined) {
      return `<${facts.tag}> has a click handler (${facts.handlerSource}) but Tab cannot reach it`;
    }
    if (facts.tabindex !== undefined) return `tabindex="${facts.tabindex}"`;
  }

  // Fall back to the raw facts rather than losing information.
  return Object.entries(facts)
    .filter(([k]) => k !== "verdict")
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");
}

function indentBlock(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** One-line summary for the Stop hook's blocking message. */
export function formatOneLine(counts: RunCounts, source: string): string {
  const parts = (["critical", "serious", "moderate"] as Severity[])
    .filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${s}`);
  return `${parts.join(", ")} accessibility ${parts.length === 1 && counts.critical === 1 ? "issue" : "issues"} in ${source}`;
}
