import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { closeBrowser } from "../core/browser.js";
import { hasConfig, loadConfig, type GateConfig } from "../core/config.js";
import { runOnce } from "../core/run.js";
import { formatReport } from "../report/format.js";
import { outPath, writeRunArtifact } from "../report/json.js";
import { SourceError, type PageSource } from "../sources/index.js";
import type { Finding } from "../core/findings.js";

interface StopHookInput {
  cwd?: string;
  stop_hook_active?: boolean;
  session_id?: string;
  hook_event_name?: string;
}

/**
 * The Stop hook: the part that makes this a gate rather than a linter.
 *
 * Exit 0 lets the turn end; exit 2 blocks it and feeds stderr back to the agent
 * as the reason. Everything before the actual check is about *not* blocking:
 * there are five separate ways to bail out before we are willing to stop someone
 * from finishing their work.
 *
 * That conservatism is deliberate. A gate that blocks for a bad reason once —
 * because a dev server was not running, because it looped, because it fired in a
 * project that never opted in — gets uninstalled, and then it prevents nothing at
 * all. Every guard here is worth more than an extra defect caught.
 */
async function main(): Promise<never> {
  const input = await readInput();
  const cwd = input.cwd ?? process.cwd();

  // 1. Never loop. If we already blocked once this turn, let it go.
  if (input.stop_hook_active === true) return exit(0);

  // 2. Explicit escape hatch.
  if (process.env.A11Y_GATE_DISABLE) return exit(0);

  // 3. Opt-in per project: no config file, no gate. Installing the plugin must
  //    not change how any unrelated repository behaves.
  if (!hasConfig(cwd)) return exit(0);

  const config = loadConfig(cwd);

  // 4. Only when UI actually changed, and only if it changed since the last pass.
  const fingerprint = uiFingerprint(config);
  if (fingerprint === null) return exit(0);
  const state = readState(config);
  if (state?.fingerprint === fingerprint && state.verdict === "pass") return exit(0);

  // 5. Never block on infrastructure the user did not start.
  const sources = resolveSources(config);
  if (sources.length === 0) return exit(0);
  if (config.sources.baseUrl && !(await reachable(config.sources.baseUrl))) {
    process.stderr.write(
      `a11y-gate: skipped — ${config.sources.baseUrl} is not reachable. ` +
        "Start the dev server to enable the accessibility gate.\n",
    );
    return exit(0);
  }

  // --- Actually check ------------------------------------------------------

  const findings: Finding[] = [];
  let verdict: "pass" | "fail" = "pass";
  let checked = "";
  let elementsScanned = 0;
  let durationMs = 0;

  try {
    const deadline = Date.now() + 25_000;
    for (const source of sources) {
      if (Date.now() > deadline) break;
      const run = await runOnce(source, config.viewports[0]!, config.themes[0]!, { config });
      findings.push(...run.findings);
      elementsScanned += run.meta.elementsScanned;
      durationMs += run.meta.durationMs;
      checked = checked ? `${checked}, ${run.source}` : run.source;
      if (run.verdict === "fail") verdict = "fail";
    }
  } catch (err) {
    await closeBrowser();
    if (err instanceof SourceError) {
      process.stderr.write(`a11y-gate: skipped — ${err.message}\n`);
      return exit(0);
    }
    // An internal error in the gate is our bug, not the user's. Never block on it.
    process.stderr.write(
      `a11y-gate: skipped — internal error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return exit(0);
  }

  await closeBrowser();

  const counts = { critical: 0, serious: 0, moderate: 0, advice: 0 };
  for (const f of findings) counts[f.severity]++;

  const jsonPath = writeRunArtifact(config, {
    version: 1,
    timestamp: new Date().toISOString(),
    source: checked,
    verdict,
    counts,
    durationMs,
    findings,
    suppressed: [],
    contexts: [config.viewports[0]!.name],
  });

  writeState(config, { fingerprint, verdict, at: new Date().toISOString() });

  if (verdict === "pass") {
    process.stderr.write(`a11y-gate: pass (${checked})\n`);
    return exit(0);
  }

  // Block, and hand back a report shaped as work to do rather than a complaint.
  const report = formatReport(
    {
      verdict,
      source: checked,
      context: config.viewports[0]!.name,
      findings,
      counts,
      durationMs,
      elementsScanned,
    },
    { jsonPath, color: false, perRuleLimit: 3 },
  );

  process.stderr.write(
    `${report}\n\n` +
      "These are blocking accessibility defects in UI changed this turn. " +
      "Fix them and re-run the check (a11y_check, or `npx a11y-gate check`) before finishing. " +
      "If a finding is pre-existing debt the user has chosen not to fix, ask them before " +
      "accepting it into the baseline.\n",
  );
  return exit(2);
}

// ---------------------------------------------------------------------------

function resolveSources(config: GateConfig): PageSource[] {
  const { baseUrl, routes } = config.sources;
  if (!baseUrl) return [];
  const list = routes?.length ? routes : ["/"];
  // Cap the number of routes: the hook has a hard time budget and a slow gate is
  // a gate people disable.
  return list.slice(0, 3).map((route) => ({
    kind: "url" as const,
    url: new URL(route, baseUrl).toString(),
  }));
}

/**
 * A hash of the UI files currently modified.
 *
 * Returns null when nothing UI-shaped has changed, which is the common case and
 * the cheapest possible exit. Falls back to file mtimes outside a git repo.
 */
function uiFingerprint(config: GateConfig): string | null {
  const extensions = new Set(
    config.uiGlobs.map((g) => extname(g)).filter((e) => e.length > 1),
  );

  let files: string[] = [];
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: config.rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    files = out
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      // Renames arrive as "old -> new"; the new path is what matters.
      .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1]! : p));
  } catch {
    return null; // Not a git repo, or git unavailable: stay out of the way.
  }

  const uiFiles = files.filter((f) => extensions.has(extname(f)));
  if (uiFiles.length === 0) return null;

  const hash = createHash("sha256");
  for (const file of uiFiles.sort()) {
    hash.update(file);
    try {
      const full = join(config.rootDir, file);
      hash.update(String(statSync(full).mtimeMs));
    } catch {
      hash.update("missing");
    }
  }
  return hash.digest("hex").slice(0, 16);
}

interface HookState {
  fingerprint: string;
  verdict: "pass" | "fail";
  at: string;
}

function statePath(config: GateConfig): string {
  return outPath(config, "hook-state.json");
}

function readState(config: GateConfig): HookState | null {
  const path = statePath(config);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as HookState;
  } catch {
    return null;
  }
}

function writeState(config: GateConfig, state: HookState): void {
  const path = statePath(config);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Losing the cache costs a re-check, never correctness.
  }
}

async function reachable(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return true;
  } catch {
    return false;
  }
}

async function readInput(): Promise<StopHookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as StopHookInput;
  } catch {
    return {};
  }
}

function exit(code: number): never {
  process.exit(code);
}

main().catch(async (err) => {
  await closeBrowser().catch(() => {});
  process.stderr.write(`a11y-gate: hook error, not blocking — ${err}\n`);
  process.exit(0);
});
