import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { asBrowserError } from "./errors.js";
import type { Theme, Viewport } from "./types.js";

export const DEFAULT_VIEWPORT: Viewport = { name: "desktop", width: 1440, height: 900 };

let shared: Browser | null = null;

/**
 * One browser process, reused across checks in a session.
 *
 * Launch is ~300ms and a check is often a few hundred ms of actual work, so a
 * cold launch per call would dominate. The MCP server keeps this alive between
 * tool calls, which is what makes an iterate-and-recheck loop feel immediate.
 */
export async function getBrowser(): Promise<Browser> {
  if (shared && shared.isConnected()) return shared;
  try {
    shared = await launch();
  } catch (err) {
    // "Chromium isn't installed" is the most common first run, and deserves a
    // one-line answer rather than a stack trace.
    const friendly = asBrowserError(err);
    if (friendly) throw friendly;
    throw err;
  }
  return shared;
}

async function launch(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: [
      // Deterministic rendering: without this, font smoothing and GPU rasterisation
      // vary between machines and the focus-visibility pixel diff gets noisy.
      "--force-color-profile=srgb",
      "--disable-lcd-text",
      "--font-render-hinting=none",
      "--disable-gpu",
      "--hide-scrollbars",
    ],
  });
}

export async function closeBrowser(): Promise<void> {
  if (shared) {
    await shared.close().catch(() => {});
    shared = null;
  }
}

export interface SessionOptions {
  viewport?: Viewport;
  theme?: Theme;
  /** Disable CSS animations and transitions so screenshots are stable. */
  freezeMotion?: boolean;
  deviceScaleFactor?: number;
  /**
   * User-agent string. Playwright's default announces HeadlessChrome, which many
   * production sites reject outright — and a page you cannot load is a page you
   * cannot audit.
   */
  userAgent?: string;
  /** Extra headers, e.g. an auth token for a staging environment. */
  extraHTTPHeaders?: Record<string, string>;
}

export interface Session {
  context: BrowserContext;
  page: Page;
  viewport: Viewport;
  theme: Theme;
  close(): Promise<void>;
}

export async function createSession(options: SessionOptions = {}): Promise<Session> {
  const {
    viewport = DEFAULT_VIEWPORT,
    theme = "light",
    freezeMotion = true,
    deviceScaleFactor = 1,
    userAgent,
    extraHTTPHeaders,
  } = options;

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme,
    deviceScaleFactor,
    reducedMotion: freezeMotion ? "reduce" : "no-preference",
    ...(userAgent ? { userAgent } : {}),
    ...(extraHTTPHeaders ? { extraHTTPHeaders } : {}),
  });

  const page = await context.newPage();

  if (freezeMotion) {
    // `prefers-reduced-motion` is only advisory — plenty of UI animates regardless.
    // Pinning animations to their end state is what makes two screenshots of the
    // same element comparable, which the focus-visibility diff depends on.
    await page.addStyleTag({
      content: `*, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }`,
    }).catch(() => {
      /* no document yet; re-applied after navigation by prepareSession */
    });
  }

  return {
    context,
    page,
    viewport,
    theme,
    close: async () => {
      await context.close().catch(() => {});
    },
  };
}

/** Re-apply motion freezing after a navigation, and settle fonts. */
export async function prepareSession(session: Session): Promise<void> {
  await session.page
    .addStyleTag({
      content: `*, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }`,
    })
    .catch(() => {});

  // Webfonts swapping in after the first screenshot would show up as a spurious
  // pixel change and be reported as a focus indicator. Wait them out.
  await session.page.evaluate(() => document.fonts?.ready).catch(() => {});
}
