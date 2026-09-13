/**
 * An error the user can act on, carrying the remedy alongside the diagnosis.
 *
 * Every entrypoint (CLI, MCP, Stop hook) prints these without a stack trace,
 * because a stack is noise when the answer is "run this one command". Anything
 * that is genuinely our bug still throws a plain Error and still gets a stack.
 */
export class GateError extends Error {
  constructor(
    message: string,
    /** What the user should do about it. Surfaced verbatim. */
    readonly remedy: string,
  ) {
    super(message);
    this.name = "GateError";
  }
}

export function isGateError(err: unknown): err is GateError {
  return err instanceof GateError;
}

/**
 * Recognise Playwright's "browser not installed" failure and answer it properly.
 *
 * This is the single most likely first-run failure, and Playwright's own message
 * arrives buried in a stack trace and recommends `npx playwright install`, which
 * downloads every browser engine. We only ever launch Chromium.
 */
export function asBrowserError(err: unknown): GateError | null {
  const message = err instanceof Error ? err.message : String(err);
  if (
    /Executable doesn't exist|playwright install|Failed to launch|BrowserType\.launch/i.test(
      message,
    )
  ) {
    return new GateError(
      "Chromium is not installed, so there is nothing to render the page in.",
      "Run: npx playwright install chromium",
    );
  }
  return null;
}
