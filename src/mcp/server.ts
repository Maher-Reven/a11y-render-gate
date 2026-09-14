import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { closeBrowser } from "../core/browser.js";
import { acceptIntoBaseline, readBaseline, writeBaseline } from "../core/baseline.js";
import { findConfigFile, loadConfig } from "../core/config.js";
import { diffFindings } from "../core/findings.js";
import { runMatrix, runOnce } from "../core/run.js";
import { annotatedScreenshot } from "../render/annotate.js";
import { formatReport } from "../report/format.js";
import { readLastRun, writeRunArtifact } from "../report/json.js";
import { isGateError } from "../core/errors.js";
import { type Action, type PageSource } from "../sources/index.js";
import type { Finding } from "../core/findings.js";

const server = new McpServer({ name: "a11y-render-gate", version: "0.1.0" });

const actionSchema = z.union([
  z.object({ click: z.string() }),
  z.object({ hover: z.string() }),
  z.object({ fill: z.string(), value: z.string() }),
  z.object({ press: z.string() }),
  z.object({ wait: z.number() }),
  z.object({ waitFor: z.string() }),
]);

// ---------------------------------------------------------------------------
// a11y_check
// ---------------------------------------------------------------------------

server.registerTool(
  "a11y_check",
  {
    title: "Check rendered UI for accessibility defects",
    description:
      "Render UI and report accessibility defects as computed facts with ready-to-apply fixes. " +
      "Call this BEFORE reporting any UI work complete — it catches defects that are invisible " +
      "in source: real composited contrast ratios, whether a focus indicator actually renders " +
      "(measured by pixel diff), hit-target sizes, accessible names as the browser computes " +
      "them, and controls Tab can never reach. " +
      "Pass exactly one source: `url` (your dev server), `html` (a snippet to render standalone), " +
      "or `story` (a Storybook story id). Re-run after fixing; it reports what changed.",
    inputSchema: {
      url: z.string().optional().describe("URL to check, e.g. http://localhost:5173/checkout"),
      html: z.string().optional().describe("Raw HTML to render standalone"),
      css: z.string().optional().describe("CSS to apply to the `html` source"),
      story: z.string().optional().describe("Storybook story id, e.g. ui-button--secondary"),
      viewport: z
        .enum(["mobile", "desktop", "both"])
        .optional()
        .describe("Which viewport(s) to check. Defaults to the configured set."),
      theme: z.enum(["light", "dark", "both"]).optional(),
      only: z
        .array(
          z.enum([
            "contrast", "focus-visible", "target-size", "label-wiring", "keyboard-reach",
            "state-contrast", "axe",
          ]),
        )
        .optional()
        .describe("Restrict to these rules. Omit to run all of them."),
      actions: z
        .array(actionSchema)
        .optional()
        .describe(
          "Steps to reach state that only exists after interaction, " +
            'e.g. [{"click":".open-modal"},{"wait":300}] to check inside a dialog.',
        ),
      screenshot: z
        .enum(["auto", "always", "never"])
        .optional()
        .describe("Annotated screenshot with numbered boxes. `auto` (default) attaches one on failure."),
    },
  },
  async (args) => {
    const config = loadConfig();

    let source: PageSource;
    try {
      source = buildSource(args, config.sources.baseUrl);
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    // `filter` returns [] rather than null, so the old `??` fallback here was
    // dead code. Name the real behaviour instead: asking for a viewport this
    // project has not configured falls back to the configured set rather than
    // silently checking nothing.
    const named = args.viewport && args.viewport !== "both"
      ? config.viewports.filter((v) => v.name === args.viewport)
      : [];
    const viewports = named.length > 0 ? named : config.viewports;
    const themes: ("light" | "dark")[] =
      args.theme === "both" ? ["light", "dark"] : args.theme ? [args.theme] : config.themes;

    const previous = readLastRun(config);

    try {
      const wantsShot = args.screenshot ?? "auto";
      const singleRun = viewports.length === 1 && themes.length === 1;

      // Keep the session open only when we will actually screenshot from it.
      const keepSession = singleRun && wantsShot !== "never";

      const result = singleRun
        ? await (async () => {
            const run = await runOnce(source, viewports[0]!, themes[0]!, {
              config,
              only: args.only,
              keepSession,
            });
            return {
              source: run.source,
              verdict: run.verdict,
              runs: [run],
              findings: run.findings,
              counts: run.counts,
              durationMs: run.meta.durationMs,
            };
          })()
        : await runMatrix(source, {
            config,
            only: args.only,
            viewports: viewports.length ? viewports : undefined,
            themes,
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

      let findings: Finding[] = result.findings;
      let image: { data: string; mimeType: string } | undefined;

      const shouldShoot =
        wantsShot === "always" ||
        // An image of forty red boxes communicates nothing and costs ~1.5k tokens,
        // so attach one only when it can actually be read.
        (wantsShot === "auto" && result.verdict === "fail" && findings.length <= 8);

      const session = result.runs[0]?.session;
      if (session && shouldShoot) {
        try {
          const { png, labelled } = await annotatedScreenshot(
            session.page,
            findings,
            result.runs[0]!.collected,
          );
          findings = labelled;
          image = { data: png.toString("base64"), mimeType: "image/png" };
        } catch {
          // A failed screenshot must never fail the check.
        }
      }
      if (session) await session.close();

      const delta = previous && previous.source === result.source
        ? (() => {
            const d = diffFindings(previous.findings, findings);
            return { fixed: d.fixed.length, introduced: d.introduced.length, remaining: d.remaining.length };
          })()
        : undefined;

      const text = formatReport(
        {
          verdict: result.verdict,
          source: result.source,
          context: result.runs.map((r) => r.meta.context).join(" | "),
          findings,
          counts: result.counts,
          durationMs: result.durationMs,
          elementsScanned: result.runs[0]?.meta.elementsScanned ?? 0,
        },
        {
          jsonPath,
          delta,
          suppressed: result.runs[0]?.suppressed.length ?? 0,
          color: false,
        },
      );

      const content: any[] = [{ type: "text", text }];
      if (image) {
        content.push({ type: "image", data: image.data, mimeType: image.mimeType });
        content.push({
          type: "text",
          text: "Numbered boxes above correspond to the findings listed, in order.",
        });
      }
      return { content };
    } catch (err) {
      if (isGateError(err)) return errorResult(`${err.message}\n${err.remedy}`);
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  },
);

// ---------------------------------------------------------------------------
// a11y_explain
// ---------------------------------------------------------------------------

server.registerTool(
  "a11y_explain",
  {
    title: "Explain one finding in full",
    description:
      "Get the complete detail for one finding id from the last a11y_check run: every measured " +
      "value, the success criteria it fails, and the exact fix. Use this when the summary line " +
      "is not enough, instead of re-running the whole check.",
    inputSchema: {
      findingId: z.string().describe("The finding id, as shown in the last run's JSON"),
    },
  },
  async ({ findingId }) => {
    const config = loadConfig();
    const last = readLastRun(config);
    if (!last) return errorResult("No previous run. Call a11y_check first.");

    const all = [...last.findings, ...last.suppressed];
    const finding = all.find((f) => f.id === findingId);
    if (!finding) {
      return errorResult(
        `No finding "${findingId}" in the last run. Available ids: ${all.map((f) => f.id).join(", ") || "(none)"}`,
      );
    }

    const lines = [
      `${finding.severity}  ${finding.rule}  ${finding.label}`,
      `selector: ${finding.selector}`,
      finding.context ? `seen in: ${finding.context}` : "",
      finding.sourceHint ? `source:   ${finding.sourceHint}` : "",
      "",
      "measured:",
      ...Object.entries(finding.facts).map(([k, v]) => `  ${k}: ${v}`),
      "",
      `fails: ${finding.wcag.join(", ")}`,
      "",
      `fix: ${finding.fix.summary}`,
      finding.fix.css ? `\n${finding.fix.css}` : "",
      finding.fix.html ? `\n${finding.fix.html}` : "",
      finding.baselined ? "\n(this finding is currently suppressed by the baseline)" : "",
    ].filter(Boolean);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ---------------------------------------------------------------------------
// a11y_status
// ---------------------------------------------------------------------------

server.registerTool(
  "a11y_status",
  {
    title: "Report what the gate can reach",
    description:
      "Check configuration and whether the dev server and Storybook are actually up. " +
      "Call this first if a11y_check fails to load a source, rather than guessing at URLs.",
    inputSchema: {},
  },
  async () => {
    const configFile = findConfigFile();
    const config = loadConfig();
    const baseline = readBaseline(config);

    const reach = async (url: string | undefined) => {
      if (!url) return "not configured";
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_000);
        await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        return `${url} — reachable`;
      } catch {
        return `${url} — NOT reachable (start it, or pass an explicit url)`;
      }
    };

    const lines = [
      `config:     ${configFile ?? "(none — defaults in use; the Stop hook stays off)"}`,
      `level:      ${config.level}`,
      `viewports:  ${config.viewports.map((v) => `${v.name} ${v.width}x${v.height}`).join(", ")}`,
      `themes:     ${config.themes.join(", ")}`,
      `fails on:   ${config.failOn.join(", ")}`,
      `baseline:   ${baseline.entries.length} accepted finding(s)`,
      `dev server: ${await reach(config.sources.baseUrl)}`,
      `storybook:  ${await reach(config.sources.storybookUrl)}`,
    ];
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ---------------------------------------------------------------------------
// a11y_accept_baseline
// ---------------------------------------------------------------------------

server.registerTool(
  "a11y_accept_baseline",
  {
    title: "Accept known findings as existing debt",
    description:
      "Suppress specific findings so only NEW ones fail. Use this only for pre-existing issues " +
      "the user has explicitly decided not to fix now — never to silence a defect you just " +
      "introduced. Requires the finding ids from the last run.",
    inputSchema: {
      findingIds: z.array(z.string()).describe("Finding ids to accept"),
      note: z.string().optional().describe("Why this debt is being accepted"),
    },
    annotations: { destructiveHint: false, idempotentHint: true },
  },
  async ({ findingIds, note }) => {
    const config = loadConfig();
    const last = readLastRun(config);
    if (!last) return errorResult("No previous run. Call a11y_check first.");

    const toAccept = last.findings.filter((f) => findingIds.includes(f.id));
    if (toAccept.length === 0) {
      return errorResult(`None of those ids are in the last run: ${findingIds.join(", ")}`);
    }

    const path = writeBaseline(config, acceptIntoBaseline(readBaseline(config), toAccept, note));
    return {
      content: [
        {
          type: "text",
          text:
            `Accepted ${toAccept.length} finding(s) into ${path}:\n` +
            toAccept.map((f) => `  ${f.id}  ${f.rule}  ${f.label}`).join("\n") +
            "\nThese no longer fail the gate. New findings still will.",
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------

function buildSource(
  args: { url?: string; html?: string; css?: string; story?: string; actions?: unknown },
  baseUrl: string | undefined,
): PageSource {
  const actions = args.actions as Action[] | undefined;
  const provided = [args.url, args.html, args.story].filter(Boolean).length;

  if (provided === 0) {
    if (baseUrl) return { kind: "url", url: baseUrl, actions };
    throw new Error(
      "Pass one of `url`, `html`, or `story`. (No sources.baseUrl is configured to fall back to.)",
    );
  }
  if (provided > 1) throw new Error("Pass exactly one of `url`, `html`, or `story`.");

  if (args.story) return { kind: "storybook", story: args.story, actions };
  if (args.html) return { kind: "html", html: args.html, css: args.css, actions };

  let url = args.url!;
  // A bare route is a common and reasonable thing to pass.
  if (url.startsWith("/") && baseUrl) url = new URL(url, baseUrl).toString();
  return { kind: "url", url, actions };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: `a11y-render-gate: ${message}` }] };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void closeBrowser().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error(`a11y-render-gate MCP server failed to start: ${err}`);
  process.exit(1);
});
