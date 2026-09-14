import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Finding } from "./findings.js";
import type { GateConfig } from "./config.js";

export interface BaselineEntry {
  /** Per-element id, kept for provenance. */
  id: string;
  /**
   * The defect class this entry accepts.
   *
   * Matching happens here rather than on `id`, because per-element ids embed the
   * selector and real pages are full of volatile ones — a news front page's
   * per-story ids change hourly, so an id-keyed baseline goes stale on the next
   * run and silently stops suppressing anything. Accepting a defect class means
   * accepting one design decision once.
   */
  groupId?: string;
  rule: string;
  selector: string;
  label: string;
  acceptedAt: string;
  /** How many elements the class covered when it was accepted. */
  instances?: number;
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
  const acceptedGroups = new Set(
    baseline.entries.map((e) => e.groupId).filter((g): g is string => Boolean(g)),
  );
  // Entries written before defect classes existed still match by element id.
  const acceptedIds = new Set(baseline.entries.map((e) => e.id));

  const seenGroups = new Set(findings.map((f) => f.groupId));
  const seenIds = new Set(findings.map((f) => f.id));

  const active: Finding[] = [];
  const suppressed: Finding[] = [];

  for (const f of findings) {
    if (acceptedGroups.has(f.groupId) || acceptedIds.has(f.id)) {
      suppressed.push({ ...f, baselined: true });
    } else {
      active.push(f);
    }
  }

  return {
    active,
    suppressed,
    stale: baseline.entries.filter((e) =>
      e.groupId ? !seenGroups.has(e.groupId) : !seenIds.has(e.id),
    ),
  };
}

/** Add findings to the baseline, preserving existing entries and notes. */
export function acceptIntoBaseline(
  existing: BaselineFile,
  findings: Finding[],
  note?: string,
): BaselineFile {
  const byGroup = new Map(
    existing.entries.filter((e) => e.groupId).map((e) => [e.groupId!, e]),
  );
  const acceptedAt = new Date().toISOString();

  // One entry per defect class, not per element: 240 instances of one colour
  // decision should be one line in the file, and stay accepted when the page
  // regenerates with different ids.
  const perGroup = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = perGroup.get(f.groupId) ?? [];
    list.push(f);
    perGroup.set(f.groupId, list);
  }

  for (const [groupId, instances] of perGroup) {
    if (byGroup.has(groupId)) continue;
    const first = instances[0]!;
    byGroup.set(groupId, {
      id: first.id,
      groupId,
      rule: first.rule,
      selector: first.selector,
      label: first.label,
      acceptedAt,
      instances: instances.length,
      note,
    });
  }

  return {
    version: 1,
    entries: [...byGroup.values()].sort(
      (a, b) => a.rule.localeCompare(b.rule) || a.id.localeCompare(b.id),
    ),
  };
}

/** Drop entries whose findings no longer occur, so the file does not rot. */
export function pruneBaseline(existing: BaselineFile, stale: BaselineEntry[]): BaselineFile {
  const staleIds = new Set(stale.map((e) => e.id));
  return { version: 1, entries: existing.entries.filter((e) => !staleIds.has(e.id)) };
}
