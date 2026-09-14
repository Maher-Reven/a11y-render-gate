import { afterAll, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeBrowser } from "../src/core/browser.js";
import { runOnce } from "../src/core/run.js";
import { detectFramework, generateEntry, resolveViteConfig } from "../src/sources/component.js";
import { GateError } from "../src/core/errors.js";
import type { ComponentSource } from "../src/sources/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "fixtures", "component-project");
const VIEWPORT = { name: "desktop", width: 1440, height: 900 };

const check = (source: Omit<ComponentSource, "kind">) =>
  runOnce({ kind: "component", root: ROOT, ...source }, VIEWPORT, "light", {});

afterAll(async () => {
  await closeBrowser();
});

/**
 * These exercise the claim that makes the component source worth having: it
 * renders through the *project's own* build rather than a reconstruction of it.
 * Every assertion here would fail if the harness quietly substituted its own
 * Vite config.
 */
describe("component source — build inheritance", () => {
  it("renders a component and finds its real defects", async () => {
    const result = await check({ component: "src/ui/Button.tsx", export: "Button" });

    expect(result.verdict).toBe("fail");
    const rules = result.findings.map((f) => f.rule);
    expect(rules).toContain("contrast");
    expect(rules).toContain("focus-visible");
  }, 60_000);

  it("inherits the project's alias and CSS pipeline", async () => {
    // The failing colour lives in styles/theme.css, reachable only via the
    // "@styles" alias declared in the fixture's vite.config.ts. Seeing the exact
    // ratio proves the alias resolved and the stylesheet was applied — neither
    // of which we configured ourselves.
    const result = await check({ component: "src/ui/Button.tsx", export: "Button" });
    const contrast = result.findings.find((f) => f.rule === "contrast")!;
    expect(contrast.facts.foreground).toBe("#8a8a8a");
    expect(contrast.facts.background).toBe("#ffffff");
    expect(contrast.facts.ratio).toBeCloseTo(3.45, 2);
  }, 60_000);

  it("compiles JSX with the project's own plugin", async () => {
    // Without @vitejs/plugin-react from their config, the .tsx would not parse
    // and we would never get a button at all.
    const result = await check({ component: "src/ui/GoodButton.tsx", export: "GoodButton" });
    expect(result.meta.elementsScanned).toBeGreaterThan(0);
  }, 60_000);

  it("reports nothing for a correct component", async () => {
    const result = await check({ component: "src/ui/GoodButton.tsx", export: "GoodButton" });
    const summary = result.findings.map((f) => `${f.severity} ${f.rule} ${f.label}`).join("\n");
    expect(result.findings, `unexpected findings:\n${summary}`).toHaveLength(0);
    expect(result.verdict).toBe("pass");
  }, 60_000);

  it("passes props through to the component", async () => {
    const result = await check({
      component: "src/ui/GoodButton.tsx",
      export: "GoodButton",
      props: { label: "Save changes" },
    });
    const labels = result.collected.snapshots.map((s) => s.text);
    expect(labels.join(" ")).toContain("Save changes");
  }, 60_000);
});

/**
 * The most important behaviour in this file.
 *
 * A component that fails to mount renders an empty page, and an empty page has
 * no accessibility defects — so the natural failure mode is to report PASS on
 * something completely broken. Silently certifying a broken component as
 * accessible is the worst outcome this tool could produce, so each of these must
 * raise rather than pass.
 */
describe("component source — never a false pass", () => {
  it("raises when the component throws while mounting", async () => {
    // NeedsProvider throws without its context provider.
    await expect(
      check({ component: "src/ui/NeedsProvider.tsx", export: "NeedsProvider" }),
    ).rejects.toThrow(/threw while mounting|LabelContext/);
  }, 60_000);

  it("mounts successfully once the declared wrapper supplies the provider", async () => {
    const result = await check({
      component: "src/ui/NeedsProvider.tsx",
      export: "NeedsProvider",
      wrapper: "./a11y.wrapper.tsx",
    });
    expect(result.verdict).toBe("pass");
    expect(result.collected.snapshots.map((s) => s.text).join(" ")).toContain("Wrapped");
  }, 60_000);

  it("raises on an export that does not exist, rather than rendering nothing", async () => {
    await expect(
      check({ component: "src/ui/Button.tsx", export: "NoSuchExport" }),
    ).rejects.toThrow(/no export named|rendered nothing/i);
  }, 60_000);

  it("raises a clear error for a missing file", async () => {
    await expect(check({ component: "src/ui/Nope.tsx" })).rejects.toThrow(GateError);
    await expect(check({ component: "src/ui/Nope.tsx" })).rejects.toThrow(/Component not found/);
  }, 30_000);

  it("refuses a component outside the project root", async () => {
    // Vite can only serve under its root; saying so beats an obscure 404.
    await expect(check({ component: "../../package.json" })).rejects.toThrow(
      /outside the project root/,
    );
  }, 30_000);
});

describe("component source — project introspection", () => {
  it("detects the framework from the project's dependencies", () => {
    expect(detectFramework(ROOT)).toBe("react");
    // No package.json at all is not an error; plain modules are supported.
    expect(detectFramework(join(ROOT, "styles"))).toBe("vanilla");
  });

  it("finds the project's vite config", () => {
    expect(resolveViteConfig(ROOT)).toContain("vite.config.ts");
    expect(resolveViteConfig(join(ROOT, "styles"))).toBeNull();
  });

  it("raises when an explicitly named config is absent", () => {
    expect(() => resolveViteConfig(ROOT, "nope.config.ts")).toThrow(/vite config not found/);
  });

  it("generates a mount entry per framework", () => {
    const base = { componentUrl: "/src/ui/Button.tsx", props: { a: 1 } };

    expect(generateEntry({ ...base, framework: "react" })).toContain("react-dom/client");
    expect(generateEntry({ ...base, framework: "vue" })).toContain("createApp");
    expect(generateEntry({ ...base, framework: "svelte" })).toContain("target: mountEl");
    expect(generateEntry({ ...base, framework: "vanilla" })).toContain("appendChild");

    // Props and export selection are baked into the generated module.
    expect(generateEntry({ ...base, framework: "react" })).toContain('{"a":1}');
    expect(generateEntry({ ...base, framework: "react", exportName: "Button" })).toContain(
      'Mod["Button"]',
    );
    // Every framework records mount failures so they cannot present as a pass.
    for (const framework of ["react", "vue", "svelte", "vanilla"] as const) {
      expect(generateEntry({ ...base, framework })).toContain("__a11yErrors");
    }
  });
});
