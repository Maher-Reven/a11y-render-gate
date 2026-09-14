import { readAxTree } from "./axtree.js";
import { applyBaseline, readBaseline, type BaselineEntry } from "./baseline.js";
import { createSession, type Session } from "./browser.js";
import { collect } from "./collect.js";
import { DEFAULT_CONFIG, ruleEnabled, type GateConfig } from "./config.js";
import {
  countBySeverity,
  severityRank,
  sortFindings,
  type Finding,
  type RunCounts,
  type Severity,
} from "./findings.js";
import { contrastProbe } from "../probes/contrast.js";
import { focusVisibilityProbe } from "../probes/focus-visibility.js";
import { keyboardReachProbe } from "../probes/keyboard-reach.js";
import { labelWiringProbe } from "../probes/label-wiring.js";
import { targetSizeProbe } from "../probes/target-size.js";
import { samplePixelContrast } from "../probes/contrast-sampling.js";
import { stateMatrixProbe } from "../probes/state-matrix.js";
import { axeProbe } from "../probes/axe.js";
import { describeSource, loadSource, SourceError, type PageSource } from "../sources/index.js";
import type { CollectResult, Theme, Viewport } from "./types.js";

export interface RunOptions {
  config?: GateConfig;
  /** Restrict to these rules. */
  only?: string[];
  /** Keep the session open so the caller can screenshot; caller must close it. */
  keepSession?: boolean;
}

export interface RunResult {
  source: string;
  verdict: "pass" | "fail";
  findings: Finding[];
  suppressed: Finding[];
  staleBaseline: BaselineEntry[];
  counts: RunCounts;
  meta: CollectResult["meta"] & { context: string; durationMs: number };
  /** Open only when `keepSession` was set. */
  session?: Session;
  collected: CollectResult;
}

/**
 * Run every enabled probe against one rendering of one source.
 *
 * The ordering matters: the collection pass must happen first because every probe
 * reads it, the accessibility tree is read while the DOM markers are still in
 * place, and the probes that drive the page (focus, keyboard) run last so they
 * cannot perturb what the passive probes observed.
 */
export async function runOnce(
  source: PageSource,
  viewport: Viewport,
  theme: Theme,
  options: RunOptions = {},
): Promise<RunResult> {
  const config = options.config ?? DEFAULT_CONFIG;
  const started = Date.now();
  const wants = (rule: string) => !options.only?.length || options.only.includes(rule);

  const session = await createSession({ viewport, theme });
  let loaded: { dispose?: () => Promise<void> } = {};

  try {
    loaded = await loadSource(session, source, {
      storybookUrl: config.sources.storybookUrl,
      rootDir: config.rootDir,
    });

    const collected = await collect(session.page, { ignore: config.ignore });
    const findings: Finding[] = [];

    // --- Passive probes, all pure over the collected snapshots ---------------

    if (wants("contrast") && ruleEnabled(config, "contrast")) {
      const { findings: contrastFindings, needsSampling } = contrastProbe(collected, {
        level: config.level,
        reportDisabled: config.rules.contrast?.reportDisabled ?? false,
      });
      findings.push(...contrastFindings);

      // Text over a gradient or image cannot be resolved from the cascade alone.
      // Rather than reporting "incomplete" and handing it back to a human, look
      // at what actually rendered.
      if (needsSampling.length > 0) {
        findings.push(
          ...(await samplePixelContrast(session.page, needsSampling, config.level)),
        );
      }
    }

    if (wants("target-size") && ruleEnabled(config, "target-size")) {
      findings.push(
        ...targetSizeProbe(collected, { minPx: config.rules["target-size"]?.minPx ?? 24 }),
      );
    }

    if (wants("label-wiring") && ruleEnabled(config, "label-wiring")) {
      const axNodes = await readAxTree(session.page);
      findings.push(
        ...labelWiringProbe(collected, axNodes, {
          strictPlaceholder: config.rules["label-wiring"]?.strictPlaceholder ?? false,
        }),
      );
    }

    // --- Active probes, which drive the page --------------------------------

    if (wants("keyboard-reach") && ruleEnabled(config, "keyboard-reach")) {
      const { findings: kbd } = await keyboardReachProbe(session.page, collected, {
        maxTabs: config.rules["keyboard-reach"]?.maxTabs ?? 60,
      });
      findings.push(...kbd);
    }

    if (wants("focus-visible") && ruleEnabled(config, "focus-visible")) {
      const { findings: focus } = await focusVisibilityProbe(session.page, collected, {
        maxElements: config.rules["focus-visible"]?.maxElements ?? 40,
        minIndicatorContrast: config.rules["focus-visible"]?.minIndicatorContrast ?? 3,
      });
      findings.push(...focus);
    }

    // Off by default: it multiplies runtime per interactive element, and the gate
    // has to stay fast enough that people leave it switched on.
    if (wants("state-contrast") && config.rules["state-contrast"]?.enabled === true) {
      findings.push(...(await stateMatrixProbe(session.page, collected, { level: config.level })));
    }

    // Last: axe injects a large script into the page, and nothing after it should
    // have to trust that the DOM is untouched.
    if (wants("axe") && config.rules.axe?.enabled === true) {
      findings.push(...(await axeProbe(session.page)));
    }

    // --- Baseline and verdict ------------------------------------------------

    const { active, suppressed, stale } = applyBaseline(
      sortFindings(findings),
      readBaseline(config),
    );

    const counts = countBySeverity(active);
    const verdict = failsGate(active, config.failOn) ? "fail" : "pass";
    const context = `${viewport.name} ${viewport.width}x${viewport.height}, ${theme}`;

    const result: RunResult = {
      source: describeSource(source),
      verdict,
      findings: active.map((f) => ({ ...f, context })),
      suppressed,
      staleBaseline: stale,
      counts,
      meta: { ...collected.meta, context, durationMs: Date.now() - started },
      collected,
    };

    if (options.keepSession) result.session = session;
    else await session.close();

    await loaded.dispose?.();
    return result;
  } catch (err) {
    await session.close();
    await loaded.dispose?.().catch(() => {});
    throw err;
  }
}

/**
 * Does anything here clear the configured failure bar?
 *
 * Severity ranks ascend as severity *descends* (critical 0 … advice 3), so the
 * threshold is the numerically largest rank in `failOn` — the least severe level
 * the user still wants to be stopped for — and anything at or above that severity
 * fails. Taking the minimum instead silently narrows `["critical", "serious"]`
 * down to critical alone, which makes the gate quietly more permissive than the
 * config says it is: the worst possible direction for a bug like this to fail in.
 */
function failsGate(findings: Finding[], failOn: Severity[]): boolean {
  if (failOn.length === 0) return false;
  const threshold = Math.max(...failOn.map(severityRank));
  return findings.some((f) => severityRank(f.severity) <= threshold);
}

export interface MatrixResult {
  source: string;
  verdict: "pass" | "fail";
  runs: RunResult[];
  findings: Finding[];
  counts: RunCounts;
  durationMs: number;
}

/**
 * Run the full viewport x theme matrix.
 *
 * Worth the extra passes: contrast defects hide in dark mode constantly, because
 * the light palette is the one anybody looks at, and target-size defects appear
 * only at mobile widths where the layout reflows.
 */
export async function runMatrix(
  source: PageSource,
  options: RunOptions & { viewports?: Viewport[]; themes?: Theme[] } = {},
): Promise<MatrixResult> {
  const config = options.config ?? DEFAULT_CONFIG;
  const viewports = options.viewports ?? config.viewports;
  const themes = options.themes ?? config.themes;
  const started = Date.now();

  const runs: RunResult[] = [];
  for (const viewport of viewports) {
    for (const theme of themes) {
      runs.push(await runOnce(source, viewport, theme, options));
    }
  }

  // The same defect found at two viewports is one defect; keep the first
  // occurrence and let its `context` say where it was seen.
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const run of runs) {
    for (const f of run.findings) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      findings.push(f);
    }
  }

  const sorted = sortFindings(findings);
  return {
    source: runs[0]?.source ?? describeSource(source),
    verdict: runs.some((r) => r.verdict === "fail") ? "fail" : "pass",
    runs,
    findings: sorted,
    counts: countBySeverity(sorted),
    durationMs: Date.now() - started,
  };
}

export { SourceError };
