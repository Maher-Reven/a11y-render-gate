import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, "..", "dist", "hook", "stop-gate.js");

const temps: string[] = [];

function project(withConfig: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "a11y-gate-hook-"));
  temps.push(dir);
  if (withConfig) {
    writeFileSync(
      join(dir, "a11y-gate.config.json"),
      JSON.stringify({ sources: { baseUrl: "http://127.0.0.1:59999" } }),
    );
  }
  initGitRepo(dir);
  return dir;
}

/** A real repository: the hook reads `git status` to decide what changed. */
function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
}

/** Run the hook with a given stdin payload and report its exit code. */
function runHook(input: object, env: Record<string, string> = {}): number {
  try {
    execFileSync("node", [HOOK], {
      input: JSON.stringify(input),
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 40_000,
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/**
 * The hook is the only component that can stop someone from finishing their work,
 * so its refusals to act matter more than its ability to act. Each of these is a
 * way it must decline to block.
 */
describe("Stop hook guards", () => {
  it("never loops: stop_hook_active always exits 0", () => {
    const cwd = project(true);
    expect(runHook({ cwd, stop_hook_active: true, hook_event_name: "Stop" })).toBe(0);
  });

  it("respects the A11Y_GATE_DISABLE escape hatch", () => {
    const cwd = project(true);
    expect(
      runHook({ cwd, stop_hook_active: false }, { A11Y_GATE_DISABLE: "1" }),
    ).toBe(0);
  });

  it("stays out of projects that never opted in", () => {
    // No config file: installing the plugin must not change how an unrelated
    // repository behaves.
    const cwd = project(false);
    expect(runHook({ cwd, stop_hook_active: false })).toBe(0);
  });

  it("does nothing when no UI files changed", () => {
    // A real repo with a config but no modified UI file: the cheapest exit, and
    // the one that keeps the gate from running on every unrelated turn.
    const cwd = project(true);
    writeFileSync(join(cwd, "notes.md"), "not a UI file\n");
    expect(runHook({ cwd, stop_hook_active: false })).toBe(0);
  });

  it("does not block when the dev server is unreachable", () => {
    const cwd = project(true);
    writeFileSync(join(cwd, "Button.tsx"), "export const Button = () => null;\n");
    // Port 59999 is not listening; the gate must decline rather than fail the turn.
    expect(runHook({ cwd, stop_hook_active: false })).toBe(0);
  });

  it("survives malformed input without blocking", () => {
    try {
      execFileSync("node", [HOOK], { input: "not json at all", stdio: ["pipe", "pipe", "pipe"] });
      expect(true).toBe(true);
    } catch (err) {
      expect((err as { status?: number }).status).toBe(0);
    }
  });
});

/**
 * The positive case: the hook must actually block. Everything above is about
 * restraint; this is the one that proves the gate is a gate.
 */
describe("Stop hook blocking", () => {
  it("exits 2 and explains what to fix when the rendered page fails", async () => {
    const { createServer } = await import("node:http");
    const { readFileSync } = await import("node:fs");

    const broken = readFileSync(join(here, "..", "fixtures", "broken", "focus.html"), "utf8");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(broken);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const cwd = mkdtempSync(join(tmpdir(), "a11y-gate-block-"));
    temps.push(cwd);
    initGitRepo(cwd);
    writeFileSync(
      join(cwd, "a11y-gate.config.json"),
      JSON.stringify({ sources: { baseUrl: `http://127.0.0.1:${port}`, routes: ["/"] } }),
    );
    // A changed UI file is what makes the gate consider the turn worth checking.
    writeFileSync(join(cwd, "Button.tsx"), "export const Button = () => null;\n");

    // Must be async: execFileSync would block this process's event loop, and the
    // server being served from it could never accept the hook's connection.
    const { status, stderr } = await new Promise<{ status: number; stderr: string }>(
      (resolve) => {
        const child = execFile(
          "node",
          [HOOK],
          { timeout: 40_000 },
          (err, _stdout, errOut) => {
            resolve({
              status: (err as { code?: number } | null)?.code ?? 0,
              stderr: errOut,
            });
          },
        );
        child.stdin?.end(
          JSON.stringify({ cwd, stop_hook_active: false, hook_event_name: "Stop" }),
        );
      },
    );
    server.close();

    // Exit 2 is what prevents the turn from ending.
    expect(status).toBe(2);
    // And the reason handed back has to be work, not a complaint.
    expect(stderr).toContain("a11y-gate FAIL");
    expect(stderr).toContain("focus-visible");
    expect(stderr).toContain("0 pixels change when focused");
    expect(stderr).toMatch(/Fix them and re-run/);
  }, 60_000);
});
