import { describe, expect, it } from "vitest";
import { runOnce } from "../src/core/run.js";
import { DEFAULT_CONFIG, type GateConfig } from "../src/core/config.js";
import { closeBrowser } from "../src/core/browser.js";
import { fixture } from "./helpers.js";
import { afterAll } from "vitest";

afterAll(async () => {
  await closeBrowser();
});

const config = (failOn: GateConfig["failOn"]): GateConfig => ({
  ...DEFAULT_CONFIG,
  failOn,
  rules: { "state-contrast": { enabled: true } },
});

/**
 * `failOn` is the single knob that decides whether the gate stops someone's work.
 * It was previously computed with a min where it needed a max, which quietly
 * reduced ["critical","serious"] to critical alone — the gate claiming to be
 * stricter than it was. These pin the semantics in both directions.
 */
describe("failure threshold", () => {
  const desktop = { name: "desktop", width: 1440, height: 900 };

  it("fails on serious findings when serious is in failOn", async () => {
    const result = await runOnce(
      { kind: "html", html: fixture("broken/states.html") },
      desktop,
      "light",
      { config: config(["critical", "serious"]) },
    );
    expect(result.findings.some((f) => f.severity === "serious")).toBe(true);
    expect(result.findings.some((f) => f.severity === "critical")).toBe(false);
    // Serious findings present, serious in failOn: this must fail.
    expect(result.verdict).toBe("fail");
  }, 40_000);

  it("passes the same page when only critical blocks", async () => {
    const result = await runOnce(
      { kind: "html", html: fixture("broken/states.html") },
      desktop,
      "light",
      { config: config(["critical"]) },
    );
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.verdict).toBe("pass");
  }, 40_000);

  it("blocks on moderate findings when asked to", async () => {
    const result = await runOnce(
      { kind: "html", html: fixture("broken/targets.html") },
      desktop,
      "light",
      { config: config(["critical", "serious", "moderate"]) },
    );
    expect(result.findings.every((f) => f.severity === "moderate")).toBe(true);
    expect(result.verdict).toBe("fail");
  }, 40_000);

  it("never blocks when failOn is empty", async () => {
    const result = await runOnce(
      { kind: "html", html: fixture("broken/focus.html") },
      desktop,
      "light",
      { config: config([]) },
    );
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.verdict).toBe("pass");
  }, 40_000);
});
