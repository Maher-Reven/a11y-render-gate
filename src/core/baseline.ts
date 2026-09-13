import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Finding } from "./findings.js";
import type { GateConfig } from "./config.js";

export interface BaselineEntry {
  id: string;
  rule: string;
  selector: string;
  label: string;
  acceptedAt: string;
  note?: string;
}

export interface BaselineFile {
  version: 1;
  entries: BaselineEntry[];
}

export function baselinePath(config: GateConfig): string {
  return isAbsolute(config.baseline) ? config.baseline : join(config.rootDir, config.baseline);
}

export function readBaseline(config: GateConfig): BaselineFile {
  const path = baselinePath(config);
  if (!existsSync(path)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as BaselineFile;
    return { version: 1, entries: parsed.entries ?? [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

export function writeBaseline(config: GateConfig, file: BaselineFile): string {
  const path = baselinePath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  return path;
}

export interface BaselineApplication {
  /** Findings that still count — new since the baseline was accepted. */
  active: Finding[];
  /** Findings suppressed by the baseline, kept for reporting totals. */
  suppressed: Finding[];
  /** Baseline entries no longer present, i.e. debt that has been paid off. */
  stale: BaselineEntry[];
}

/**
 * Suppress known debt so only new regressions fail.
 *
 * Without this, the first run against any real codebase produces hundreds of
 * findings, the gate blocks everything, and it gets disabled permanently within
 * the hour. Being able to draw a line and hold it is what makes adoption possible
 * in a project that was not built with this from day one.
 */
export function applyBaseline(findings: Finding[], baseline: BaselineFile): BaselineApplication {
  const accepted = new Set(baseline.entries.map((e) => e.id));
  const seen = new Set(findings.map((f) => f.id));

  const active: Finding[] = [];
  const suppressed: Finding[] = [];

  for (const f of findings) {
    if (accepted.has(f.id)) suppressed.push({ ...f, baselined: true });
    else active.push(f);
  }

  return {
    active,
    suppressed,
    stale: baseline.entries.filter((e) => !seen.has(e.id)),
  };
}

/** Add findings to the baseline, preserving existing entries and notes. */
export function acceptIntoBaseline(
  existing: BaselineFile,
  findings: Finding[],
  note?: string,
): BaselineFile {
  const byId = new Map(existing.entries.map((e) => [e.id, e]));
  const acceptedAt = new Date().toISOString();

  for (const f of findings) {
    if (byId.has(f.id)) continue;
    byId.set(f.id, {
      id: f.id,
      rule: f.rule,
      selector: f.selector,
      label: f.label,
      acceptedAt,
      note,
    });
  }

  return {
    version: 1,
    entries: [...byId.values()].sort((a, b) => a.rule.localeCompare(b.rule) || a.id.localeCompare(b.id)),
  };
}

/** Drop entries whose findings no longer occur, so the file does not rot. */
export function pruneBaseline(existing: BaselineFile, stale: BaselineEntry[]): BaselineFile {
  const staleIds = new Set(stale.map((e) => e.id));
  return { version: 1, entries: existing.entries.filter((e) => !staleIds.has(e.id)) };
}
