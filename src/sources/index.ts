import type { Session } from "../core/browser.js";
import { prepareSession } from "../core/browser.js";
import { GateError } from "../core/errors.js";

/** A step the gate performs after load to reach state that only exists after interaction. */
export type Action =
  | { click: string }
  | { hover: string }
  | { fill: string; value: string }
  | { press: string }
  | { wait: number }
  | { waitFor: string };

export interface BaseSource {
  /** Steps to reach the state under test, e.g. open a modal before checking it. */
  actions?: Action[];
  /** Check only this subtree. */
  within?: string;
}

export interface UrlSource extends BaseSource {
  kind: "url";
  url: string;
}

export interface HtmlSource extends BaseSource {
  kind: "html";
  html: string;
  css?: string;
  /** Extra <head> content, e.g. a font or a CSS framework tag. */
  head?: string;
}

export interface StorybookSource extends BaseSource {
  kind: "storybook";
  /** Story id as it appears in the URL, e.g. "ui-button--secondary". */
  story: string;
  /** Storybook root; defaults to config, then http://localhost:6006. */
  storybookUrl?: string;
}

export interface ComponentSource extends BaseSource {
  kind: "component";
  /** Path to the component module, relative to the project root. */
  component: string;
  /** Named export to mount; defaults to the default export. */
  export?: string;
  /** Props to mount with, as JSON. */
  props?: Record<string, unknown>;
}

export type PageSource = UrlSource | HtmlSource | StorybookSource | ComponentSource;

export interface LoadOptions {
  timeout?: number;
  storybookUrl?: string;
}

export class SourceError extends GateError {
  constructor(message: string, remedy: string) {
    super(message, remedy);
    this.name = "SourceError";
  }
}

/**
 * Resolve any source to a loaded page.
 *
 * All four source kinds collapse to "get a document into this browser", which is
 * why they can share every probe downstream. The differences are entirely in how
 * the document gets there.
 */
export async function loadSource(
  session: Session,
  source: PageSource,
  options: LoadOptions = {},
): Promise<void> {
  const { timeout = 20_000 } = options;
  const { page } = session;

  switch (source.kind) {
    case "url": {
      await navigate(page, source.url, timeout);
      break;
    }

    case "html": {
      const doc = buildDocument(source);
      await page.setContent(doc, { waitUntil: "load", timeout });
      break;
    }

    case "storybook": {
      const root = (source.storybookUrl ?? options.storybookUrl ?? "http://localhost:6006")
        .replace(/\/$/, "");
      // Storybook's iframe endpoint renders one story with no manager chrome —
      // component isolation for free, with the project's real build pipeline.
      const url = `${root}/iframe.html?id=${encodeURIComponent(source.story)}&viewMode=story`;
      await navigate(page, url, timeout);
      // The story mounts after the iframe's own bootstrap, not at `load`.
      await page
        .waitForSelector("#storybook-root > *, #root > *", { timeout: 5_000 })
        .catch(() => {
          throw new SourceError(
            `Storybook story "${source.story}" loaded but rendered nothing.`,
            "Check the story id is correct (it is the `id` in the Storybook URL, e.g. ui-button--secondary).",
          );
        });
      break;
    }

    case "component": {
      throw new SourceError(
        "The `component` source is not implemented yet.",
        "Use `url` against your dev server, or `storybook` with a story id.",
      );
    }
  }

  await prepareSession(session);
  await runActions(session, source.actions ?? []);
}

async function navigate(page: Session["page"], url: string, timeout: number): Promise<void> {
  try {
    const response = await page.goto(url, { waitUntil: "load", timeout });
    if (response && !response.ok() && response.status() >= 400) {
      throw new SourceError(
        `${url} returned HTTP ${response.status()}.`,
        "Check the route exists. Accessibility findings on an error page are not useful.",
      );
    }
  } catch (err) {
    if (err instanceof SourceError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/ERR_CONNECTION_REFUSED|net::ERR/.test(message)) {
      throw new SourceError(
        `Could not reach ${url} (connection refused).`,
        "Start the dev server first, then re-run. The gate never blocks on an unreachable source.",
      );
    }
    throw new SourceError(`Could not load ${url}: ${message}`, "Check the URL and try again.");
  }
}

function buildDocument(source: HtmlSource): string {
  const alreadyFullDocument = /<html[\s>]/i.test(source.html);
  if (alreadyFullDocument && !source.css && !source.head) return source.html;

  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    source.head ?? "",
    source.css ? `<style>${source.css}</style>` : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (alreadyFullDocument) {
    return source.html.replace(/<\/head>/i, `${head}</head>`);
  }
  return `<!doctype html><html><head>${head}</head><body>${source.html}</body></html>`;
}

async function runActions(session: Session, actions: Action[]): Promise<void> {
  const { page } = session;
  for (const action of actions) {
    try {
      if ("click" in action) await page.click(action.click, { timeout: 5_000 });
      else if ("hover" in action) await page.hover(action.hover, { timeout: 5_000 });
      else if ("fill" in action) await page.fill(action.fill, action.value, { timeout: 5_000 });
      else if ("press" in action) await page.keyboard.press(action.press);
      else if ("wait" in action) await page.waitForTimeout(action.wait);
      else if ("waitFor" in action) await page.waitForSelector(action.waitFor, { timeout: 5_000 });
    } catch (err) {
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      throw new SourceError(
        `Action ${JSON.stringify(action)} failed: ${message}`,
        "Check the selector exists in the loaded page.",
      );
    }
  }
  // Let whatever the actions triggered settle before probes read the DOM.
  await page.waitForTimeout(120);
}

/** Human-readable one-liner naming what was checked, for the report header. */
export function describeSource(source: PageSource): string {
  switch (source.kind) {
    case "url":
      return source.url;
    case "html":
      return "inline HTML";
    case "storybook":
      return `storybook: ${source.story}`;
    case "component":
      return `component: ${source.component}`;
  }
}
