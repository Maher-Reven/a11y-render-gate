import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { GateConfig } from "../core/config.js";
import type { Finding, RunCounts } from "../core/findings.js";

export interface RunArtifact {
  version: 1;
  timestamp: string;
  source: string;
  verdict: "pass" | "fail";
  counts: RunCounts;
  durationMs: number;
  findings: Finding[];
  suppressed: Finding[];
  contexts: string[];
}

export function outPath(config: GateConfig, filename: string): string {
  const dir = isAbsolute(config.outDir) ? config.outDir : join(config.rootDir, config.outDir);
  return join(dir, filename);
}

/**
 * Write the complete run to disk and return its path.
 *
 * This is what lets the conversational report stay small. Everything is always
 * recorded; the formatter shows the top of it and names this file, so an agent
 * that needs the twentieth finding can read it without every run paying for all
 * twenty.
 */
export function writeRunArtifact(config: GateConfig, artifact: RunArtifact): string {
  const path = outPath(config, "last-run.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return path;
}

export function readLastRun(config: GateConfig): RunArtifact | null {
  const path = outPath(config, "last-run.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunArtifact;
  } catch {
    return null;
  }
}
