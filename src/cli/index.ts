import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { closeBrowser } from "../core/browser.js";
import { acceptIntoBaseline, pruneBaseline, readBaseline, writeBaseline } from "../core/baseline.js";
import { CONFIG_FILENAMES, DEFAULT_CONFIG, findConfigFile, loadConfig } from "../core/config.js";
import { diffFindings } from "../core/findings.js";
import { runMatrix } from "../core/run.js";
import { isGateError } from "../core/errors.js";
import { type PageSource } from "../sources/index.js";
import { formatReport } from "../report/format.js";
import { readLastRun, writeRunArtifact } from "../report/json.js";

const program = new Command();

program
  .name("a11y-render-gate")
  .description("Render the UI and report accessibility defects as computed facts.")
  .version("0.1.0");

program
  .command("check", { isDefault: true })
  .description("Check a URL, an HTML file, or a Storybook story")
  .argument("[target]", "URL, path to an .html file, or storybook story id")
  .option("--url <url>", "explicit URL to check")
  .option("--html <path>", "path to an HTML file to render")
  .option("--story <id>", "Storybook story id")
  .option("--storybook-url <url>", "Storybook root URL")
  .option("--only <rules>", "comma-separated rules to run")
  .option("--viewport <name>", "run only this configured viewport")
  .option("--theme <theme>", "light or dark")
  .option("--level <level>", "AA or AAA")
  .option("--advice", "include advisory findings the spec exempts", false)
  .option("--json", "print the full JSON artifact instead of the report", false)
  .option("--no-color", "disable ANSI colour")
  .action(async (target, opts) => {
    const config = loadConfig();
    if (opts.level) config.level = opts.level === "AAA" ? "AAA" : "AA";
    if (opts.storybookUrl) config.sources.storybookUrl = opts.storybookUrl;

    let source: PageSource;
    try {
      source = resolveSource(target, opts, config.sources.baseUrl);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return;
    }

    const viewports = opts.viewport
      ? config.viewports.filter((v) => v.name === opts.viewport)
      : config.viewports;
    if (viewports.length === 0) {
      fail(`No configured viewport named "${opts.viewport}".`);
      return;
    }
    const themes = opts.theme ? [opts.theme === "dark" ? "dark" : "light"] : config.themes;

    const previous = readLastRun(config);

    try {
      const result = await runMatrix(source, {
        config,
        only: opts.only?.split(",").map((r: string) => r.trim()),
        viewports,
        themes: themes as ("light" | "dark")[],
      });

      const jsonPath = writeRunArtifact(config, {
        version: 1,
        timestamp: new Date().toISOString(),
        source: result.source,
        verdict: result.verdict,
        counts: result.counts,
        durationMs: result.durationMs,
        findings: result.findings,
        suppressed: result.runs[0]?.suppressed ?? [],
        contexts: result.runs.map((r) => r.meta.context),
      });

      if (opts.json) {
        console.log(readFileSync(jsonPath, "utf8"));
      } else {
        const delta = previous && previous.source === result.source
          ? (() => {
              const d = diffFindings(previous.findings, result.findings);
              return {
                fixed: d.fixed.length,
                introduced: d.introduced.length,
                remaining: d.remaining.length,
              };
            })()
          : undefined;

        console.log(
          formatReport(
            {
              verdict: result.verdict,
              source: result.source,
              context: result.runs.map((r) => r.meta.context).join(" | "),
              findings: result.findings,
              counts: result.counts,
              durationMs: result.durationMs,
              elementsScanned: result.runs[0]?.meta.elementsScanned ?? 0,
            },
            {
              color: opts.color !== false && process.stdout.isTTY === true,
              jsonPath,
              delta,
              suppressed: result.runs[0]?.suppressed.length ?? 0,
              showAdvice: opts.advice === true,
            },
          ),
        );
      }

      await closeBrowser();
      process.exit(result.verdict === "fail" ? 1 : 0);
    } catch (err) {
      await closeBrowser();
      if (isGateError(err)) {
        console.error(`a11y-render-gate: ${err.message}\n  ${err.remedy}`);
        // Exit 2 distinguishes "could not check" from "checked and failed", so CI
        // and the Stop hook can treat an unreachable dev server as not-a-failure.
        process.exit(2);
      }
      // Anything left really is our bug, and a stack is the right response.
      console.error(`a11y-render-gate: ${err instanceof Error ? err.stack : String(err)}`);
      process.exit(2);
    }
  });

program
  .command("init")
  .description("Write a starter config, and optionally wire up the Claude Code hook")
  .option("--force", "overwrite an existing config", false)
  .action((opts) => {
    const existing = findConfigFile();
    if (existing && !opts.force) {
      console.log(`a11y-render-gate: config already exists at ${existing}`);
      console.log("Pass --force to overwrite it.");
      return;
    }

    const path = resolve(process.cwd(), CONFIG_FILENAMES[0]!);
    const starter = {
      level: "AA",
      sources: {
        baseUrl: "http://localhost:5173",
        storybookUrl: "http://localhost:6006",
        routes: ["/"],
      },
      viewports: [
        { name: "mobile", width: 390, height: 844 },
        { name: "desktop", width: 1440, height: 900 },
      ],
      themes: ["light"],
      rules: {},
      ignore: [],
      failOn: ["critical", "serious"],
      baseline: ".a11y-render-gate/baseline.json",
      outDir: ".a11y-render-gate",
    };
    writeFileSync(path, `${JSON.stringify(starter, null, 2)}\n`, "utf8");
    console.log(`a11y-render-gate: wrote ${path}`);
    console.log("");
    console.log("Next:");
    console.log("  1. Set sources.baseUrl to your dev server.");
    console.log("  2. Run `a11y-render-gate check /` with the dev server running.");
    console.log("  3. Run `a11y-render-gate baseline accept` to draw a line under existing debt.");
    console.log("");
    console.log("The presence of this file is what enables the Claude Code Stop hook,");
    console.log("so no other project on this machine changes behaviour.");
  });

const baseline = program.command("baseline").description("Manage accepted accessibility debt");

baseline
  .command("accept")
  .description("Accept the findings from the last run, so only new ones fail")
  .option("--note <note>", "why this debt is being accepted")
  .action((opts) => {
    const config = loadConfig();
    const last = readLastRun(config);
    if (!last) {
      fail("No previous run found. Run `a11y-render-gate check` first.");
      return;
    }
    const updated = acceptIntoBaseline(readBaseline(config), last.findings, opts.note);
    const path = writeBaseline(config, updated);
    console.log(
      `a11y-render-gate: accepted ${last.findings.length} finding(s) into ${path}.\n` +
        "Only new findings will fail from now on.",
    );
  });

baseline
  .command("prune")
  .description("Drop baseline entries whose findings no longer occur")
  .action(() => {
    const config = loadConfig();
    const last = readLastRun(config);
    if (!last) {
      fail("No previous run found. Run `a11y-render-gate check` first.");
      return;
    }
    const current = new Set(last.findings.map((f) => f.id));
    const existing = readBaseline(config);
    const stale = existing.entries.filter((e) => !current.has(e.id));
    const path = writeBaseline(config, pruneBaseline(existing, stale));
    console.log(`a11y-render-gate: removed ${stale.length} stale entr(ies) from ${path}.`);
  });

baseline
  .command("list")
  .description("Show accepted debt")
  .action(() => {
    const config = loadConfig();
    const { entries } = readBaseline(config);
    if (entries.length === 0) {
      console.log("a11y-render-gate: baseline is empty.");
      return;
    }
    for (const e of entries) {
      console.log(`${e.id}  ${e.rule.padEnd(15)}  ${e.label}  ${e.note ? `(${e.note})` : ""}`);
    }
    console.log(`\n${entries.length} accepted finding(s).`);
  });

program
  .command("doctor")
  .description("Report what the gate can currently reach")
  .action(async () => {
    const configFile = findConfigFile();
    const config = loadConfig();

    console.log(`config:      ${configFile ?? "(none — using defaults; the Stop hook stays off)"}`);
    console.log(`level:       ${config.level}`);
    console.log(`viewports:   ${config.viewports.map((v) => `${v.name} ${v.width}x${v.height}`).join(", ")}`);
    console.log(`themes:      ${config.themes.join(", ")}`);
    console.log(`fail on:     ${config.failOn.join(", ")}`);
    console.log(`baseline:    ${readBaseline(config).entries.length} accepted finding(s)`);

    for (const [label, url] of [
      ["dev server", config.sources.baseUrl],
      ["storybook", config.sources.storybookUrl],
    ] as const) {
      if (!url) {
        console.log(`${label.padEnd(12)} not configured`);
        continue;
      }
      const reachable = await probeUrl(url);
      console.log(`${label.padEnd(12)} ${url} — ${reachable ? "reachable" : "NOT reachable"}`);
    }

    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      const version = browser.version();
      await browser.close();
      console.log(`chromium:    ok (${version})`);
    } catch (err) {
      console.log(`chromium:    FAILED — ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      console.log("             run: npx playwright install chromium");
    }
  });

program
  .command("mcp")
  .description("Run the MCP server on stdio")
  .action(async () => {
    await import("../mcp/server.js");
  });

function resolveSource(
  target: string | undefined,
  opts: Record<string, string | undefined>,
  baseUrl: string | undefined,
): PageSource {
  if (opts.story) return { kind: "storybook", story: opts.story, storybookUrl: opts.storybookUrl };
  if (opts.url) return { kind: "url", url: opts.url };
  if (opts.html) return { kind: "html", html: readFileSync(resolve(opts.html), "utf8") };

  if (!target) {
    if (baseUrl) return { kind: "url", url: baseUrl };
    throw new Error(
      "Nothing to check. Pass a URL, a path to an .html file, or set sources.baseUrl in the config.",
    );
  }

  if (/^https?:\/\//.test(target)) return { kind: "url", url: target };

  const asPath = resolve(target);
  if (existsSync(asPath) && asPath.endsWith(".html")) {
    return { kind: "html", html: readFileSync(asPath, "utf8") };
  }

  if (target.startsWith("/") && baseUrl) {
    return { kind: "url", url: new URL(target, baseUrl).toString() };
  }

  throw new Error(
    `Could not interpret "${target}". Pass a full URL, a path to an .html file, ` +
      "or a route beginning with / once sources.baseUrl is configured.",
  );
}

async function probeUrl(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const res = await fetch(url, { signal: controller.signal, method: "HEAD" }).catch(() =>
      fetch(url, { signal: controller.signal }),
    );
    clearTimeout(timer);
    return Boolean(res);
  } catch {
    return false;
  }
}

function fail(message: string): void {
  console.error(`a11y-render-gate: ${message}`);
  process.exitCode = 2;
}

program.parseAsync(process.argv).catch(async (err) => {
  await closeBrowser();
  if (isGateError(err)) console.error(`a11y-render-gate: ${err.message}\n  ${err.remedy}`);
  else console.error(err instanceof Error ? err.stack : String(err));
  process.exit(2);
});

export { DEFAULT_CONFIG };
