import { afterAll, describe, expect, it } from "vitest";
import { closeBrowser } from "../src/core/browser.js";
import { runOnce } from "../src/core/run.js";
import { GateError } from "../src/core/errors.js";

afterAll(async () => {
  await closeBrowser();
});

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head>
<body style="background:#fff">
  <div id="keep"><p style="color:#8a8a8a;font-size:14px">inside the scope</p></div>
  <div id="ignore"><p style="color:#9a9a9a;font-size:14px">outside the scope</p></div>
</body></html>`;

const VIEWPORT = { name: "desktop", width: 1440, height: 900 };
const run = (within?: string) =>
  runOnce({ kind: "html", html: PAGE, within }, VIEWPORT, "light", {});

/**
 * `within` was declared on every source type for a while before it did anything,
 * which is worse than not offering it: someone narrowing a check to one component
 * would have believed they had, and quietly received the whole page.
 */
describe("within — subtree scoping", () => {
  it("checks the whole page when unscoped", async () => {
    const result = await run();
    const texts = result.findings.map((f) => f.label).join(" ");
    expect(texts).toContain("inside the scope");
    expect(texts).toContain("outside the scope");
  }, 30_000);

  it("checks only the named subtree when scoped", async () => {
    const result = await run("#keep");
    const texts = result.findings.map((f) => f.label).join(" ");
    expect(texts).toContain("inside the scope");
    expect(texts).not.toContain("outside the scope");
  }, 30_000);

  it("still composites backgrounds from ancestors outside the scope", async () => {
    // Narrowing the report must not change what a colour renders against; body's
    // white is outside #keep but still the background the text sits on.
    const result = await run("#keep");
    const contrast = result.findings.find((f) => f.rule === "contrast")!;
    expect(contrast.facts.background).toBe("#ffffff");
    expect(contrast.facts.ratio).toBeCloseTo(3.45, 2);
  }, 30_000);

  it("raises a clear error when the selector matches nothing", async () => {
    await expect(run(".nope")).rejects.toThrow(GateError);
    await expect(run(".nope")).rejects.toThrow(/Nothing on the page matches/);
  }, 30_000);
});
