/**
 * a11y-gate — an accessibility gate inside the agent loop.
 *
 * Renders the UI, measures it, and reports defects as computed facts with
 * fix-shaped payloads rather than rule names for a human to interpret later.
 */
export { runOnce, runMatrix, type RunResult, type MatrixResult } from "./core/run.js";
export { collect, cleanup, IDX_ATTR } from "./core/collect.js";
export { createSession, closeBrowser, getBrowser, type Session } from "./core/browser.js";
export { loadConfig, hasConfig, findConfigFile, DEFAULT_CONFIG, type GateConfig } from "./core/config.js";
export {
  applyBaseline, readBaseline, writeBaseline, acceptIntoBaseline, pruneBaseline,
  type BaselineFile, type BaselineEntry,
} from "./core/baseline.js";
export {
  type Finding, type Severity, type RuleId, type RunCounts,
  diffFindings, groupFindings, sortFindings, countBySeverity,
} from "./core/findings.js";
export { formatReport, formatOneLine } from "./report/format.js";
export { writeRunArtifact, readLastRun, outPath, type RunArtifact } from "./report/json.js";
export { type PageSource, type Action, SourceError, describeSource } from "./sources/index.js";
export * from "./core/color.js";
export type { ElementSnapshot, CollectResult, Viewport, Theme, Rect } from "./core/types.js";

// Probes are exported so they can be driven directly, e.g. from a custom runner.
export { contrastProbe } from "./probes/contrast.js";
export { focusVisibilityProbe } from "./probes/focus-visibility.js";
export { targetSizeProbe } from "./probes/target-size.js";
export { labelWiringProbe } from "./probes/label-wiring.js";
export { keyboardReachProbe } from "./probes/keyboard-reach.js";
export { stateMatrixProbe } from "./probes/state-matrix.js";
export { axeProbe } from "./probes/axe.js";
